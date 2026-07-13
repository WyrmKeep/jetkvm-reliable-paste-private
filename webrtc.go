package kvm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
	"github.com/jetkvm/kvm/internal/diagnostics"
	"github.com/jetkvm/kvm/internal/hidrpc"
	"github.com/jetkvm/kvm/internal/logging"
	"github.com/jetkvm/kvm/internal/sync"
	"github.com/jetkvm/kvm/internal/usbgadget"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"github.com/rs/zerolog"
)

type Session struct {
	managerGeneration atomic.Uint64

	peerConnection           *webrtc.PeerConnection
	VideoTrack               *webrtc.TrackLocalStaticSample
	ControlChannel           *webrtc.DataChannel
	RPCChannel               *webrtc.DataChannel
	HidChannel               *webrtc.DataChannel
	shouldUmountVirtualMedia bool

	rpcQueueLock       sync.Mutex
	rpcQueue           chan rpcQueueMessage
	rpcAdmissionCtx    context.Context
	rpcAdmissionCancel context.CancelFunc
	rpcWorkerCtx       context.Context
	rpcWorkerCancel    context.CancelFunc
	rpcWorkerDone      chan struct{}
	rpcWorkerStarted   bool
	rpcQueueAdmissions sync.WaitGroup
	rpcQueueClosing    bool
	rpcQueueHandler    func(webrtc.DataChannelMessage, *Session)

	hidRPCAvailable          bool
	lastKeepAliveArrivalTime time.Time  // Track when last keep-alive packet arrived
	lastTimerResetTime       time.Time  // Track when auto-release timer was last reset
	keepAliveJitterLock      sync.Mutex // Protect jitter compensation timing state
	hidQueueLock             sync.Mutex
	hidQueue                 []chan hidQueueMessage

	keysDownStateQueue    chan usbgadget.KeysDownState
	managedWorkersStarted bool
}

func (s *Session) managerGenerationLoad() controlsession.Generation {
	return controlsession.Generation(s.managerGeneration.Load())
}

func (s *Session) managerGenerationStore(generation controlsession.Generation) {
	s.managerGeneration.Store(uint64(generation))
}

type rpcQueueAdmission struct {
	ctx     context.Context
	done    sync.Once
	release func()
}

func (a *rpcQueueAdmission) Context() context.Context {
	if a == nil || a.ctx == nil {
		return context.Background()
	}
	return a.ctx
}

func (a *rpcQueueAdmission) Done() {
	if a == nil {
		return
	}
	a.done.Do(func() {
		if a.release != nil {
			a.release()
		}
	})
}

type rpcQueueMessage struct {
	message     webrtc.DataChannelMessage
	producer    *controlsession.Producer
	admission   *rpcQueueAdmission
	maintenance bool
}

var (
	actionSessions      int = 0
	activeSessionsMutex     = &sync.Mutex{}
)

func incrActiveSessions() int {
	activeSessionsMutex.Lock()
	defer activeSessionsMutex.Unlock()

	actionSessions++
	return actionSessions
}

func decrActiveSessions() int {
	activeSessionsMutex.Lock()
	defer activeSessionsMutex.Unlock()

	actionSessions--
	return actionSessions
}

func getActiveSessions() int {
	activeSessionsMutex.Lock()
	defer activeSessionsMutex.Unlock()

	return actionSessions
}

// GetDiagnosticsInfo returns WebRTC diagnostic info for the diagnostics package.
func (s *Session) GetDiagnosticsInfo() diagnostics.SessionInfo {
	info := diagnostics.SessionInfo{
		HasCurrentSession: true,
	}

	if s.peerConnection != nil {
		pc := s.peerConnection
		info.ICEConnectionState = pc.ICEConnectionState().String()
		info.SignalingState = pc.SignalingState().String()
		info.ConnectionState = pc.ConnectionState().String()

		var channels []diagnostics.DataChannelInfo
		if s.ControlChannel != nil {
			channels = append(channels, diagnostics.DataChannelInfo{
				Label: s.ControlChannel.Label(),
				State: s.ControlChannel.ReadyState().String(),
			})
		}
		if s.RPCChannel != nil {
			channels = append(channels, diagnostics.DataChannelInfo{
				Label: s.RPCChannel.Label(),
				State: s.RPCChannel.ReadyState().String(),
			})
		}
		if s.HidChannel != nil {
			channels = append(channels, diagnostics.DataChannelInfo{
				Label: s.HidChannel.Label(),
				State: s.HidChannel.ReadyState().String(),
			})
		}
		info.DataChannels = channels
	}

	return info
}

func (s *Session) resetKeepAliveTime() {
	s.keepAliveJitterLock.Lock()
	defer s.keepAliveJitterLock.Unlock()
	s.lastKeepAliveArrivalTime = time.Time{} // Reset keep-alive timing tracking
	s.lastTimerResetTime = time.Time{}       // Reset auto-release timer tracking
}

type hidQueueMessage struct {
	webrtc.DataChannelMessage
	channel  string
	producer *controlsession.Producer
}

type SessionConfig struct {
	ICEServers []string
	LocalIP    string
	IsCloud    bool
	ws         *websocket.Conn
	Logger     *zerolog.Logger
	MDNSMode   string
}

func (s *Session) ExchangeOffer(offerStr string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(offerStr)
	if err != nil {
		return "", err
	}
	offer := webrtc.SessionDescription{}
	err = json.Unmarshal(b, &offer)
	if err != nil {
		return "", err
	}
	// Set the remote SessionDescription
	if err = s.peerConnection.SetRemoteDescription(offer); err != nil {
		return "", err
	}

	// Create answer
	answer, err := s.peerConnection.CreateAnswer(nil)
	if err != nil {
		return "", err
	}

	// Sets the LocalDescription, and starts our UDP listeners
	if err = s.peerConnection.SetLocalDescription(answer); err != nil {
		return "", err
	}

	localDescription, err := json.Marshal(s.peerConnection.LocalDescription())
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(localDescription), nil
}

func (s *Session) initQueues() {
	s.hidQueueLock.Lock()
	defer s.hidQueueLock.Unlock()

	s.hidQueue = make([]chan hidQueueMessage, 0)
	for i := 0; i < 4; i++ {
		q := make(chan hidQueueMessage, 256)
		s.hidQueue = append(s.hidQueue, q)
	}
}
func (s *Session) initRPCQueue() {
	s.rpcQueueLock.Lock()
	defer s.rpcQueueLock.Unlock()

	if s.rpcQueue == nil {
		s.rpcQueue = make(chan rpcQueueMessage, 256)
	}
	if s.rpcAdmissionCtx == nil {
		s.rpcAdmissionCtx, s.rpcAdmissionCancel = context.WithCancel(context.Background())
	}
	if s.rpcWorkerCtx == nil {
		s.rpcWorkerCtx, s.rpcWorkerCancel = context.WithCancel(context.Background())
		s.rpcWorkerDone = make(chan struct{})
	}
	if s.rpcQueueHandler == nil {
		s.rpcQueueHandler = onRPCMessage
	}
}

func (s *Session) beginRPCQueueAdmission() (*rpcQueueAdmission, bool) {
	s.rpcQueueLock.Lock()
	defer s.rpcQueueLock.Unlock()
	if s.rpcQueueClosing || s.rpcQueue == nil || s.rpcAdmissionCtx == nil {
		return nil, false
	}
	s.rpcQueueAdmissions.Add(1)
	return &rpcQueueAdmission{
		ctx:     s.rpcAdmissionCtx,
		release: s.rpcQueueAdmissions.Done,
	}, true
}

func (s *Session) stopRPCQueue() {
	s.rpcQueueLock.Lock()
	if !s.rpcQueueClosing {
		s.rpcQueueClosing = true
		if s.rpcAdmissionCancel != nil {
			s.rpcAdmissionCancel()
		}
	}
	s.rpcQueueLock.Unlock()

	// Keep the consumer alive until every admitted sender or dispatched handler
	// releases admission. This lets canceled sends either return or enqueue and
	// be discarded without stranding a queue entry.
	s.rpcQueueAdmissions.Wait()

	s.rpcQueueLock.Lock()
	if s.rpcWorkerCancel != nil {
		s.rpcWorkerCancel()
	}
	workerDone := s.rpcWorkerDone
	workerStarted := s.rpcWorkerStarted
	s.rpcQueueLock.Unlock()
	if workerStarted {
		<-workerDone
	}
}

func (s *Session) enqueueRPCQueueMessage(item rpcQueueMessage) bool {
	s.rpcQueueLock.Lock()
	queue := s.rpcQueue
	s.rpcQueueLock.Unlock()
	if queue == nil || item.admission == nil {
		return false
	}

	var producerDone <-chan struct{}
	if item.producer != nil {
		producerDone = item.producer.Context().Done()
	}
	select {
	case queue <- item:
		return true
	case <-item.admission.Context().Done():
		return false
	case <-producerDone:
		return false
	}
}

func (s *Session) enqueueRPCMessage(message webrtc.DataChannelMessage) bool {
	admission, ok := s.beginRPCQueueAdmission()
	if !ok {
		return false
	}

	maintenance := isMaintenanceRPCMessage(message)
	var producer *controlsession.Producer
	if !maintenance {
		producer, ok = sessionManager.StartProducer(s.managerGenerationLoad(), controlsession.ProducerRPC)
		if !ok {
			admission.Done()
			return false
		}
	}

	item := rpcQueueMessage{
		message:     message,
		producer:    producer,
		admission:   admission,
		maintenance: maintenance,
	}
	if s.enqueueRPCQueueMessage(item) {
		return true
	}
	if producer != nil {
		producer.Done()
	}
	admission.Done()
	return false
}

func (s *Session) handleRPCQueueItem(item rpcQueueMessage) {
	if item.admission == nil {
		if item.producer != nil {
			item.producer.Done()
		}
		return
	}
	if item.admission.Context().Err() != nil ||
		(item.producer != nil && item.producer.Context().Err() != nil) {
		if item.producer != nil {
			item.producer.Done()
		}
		item.admission.Done()
		return
	}

	handler := s.rpcQueueHandler
	if handler == nil {
		handler = onRPCMessage
	}
	if item.maintenance {
		// Maintenance quiesces its own session. Release queue admission first so
		// shutdown can join senders without making the handler join itself.
		item.admission.Done()
		handler(item.message, s)
		return
	}

	defer item.admission.Done()
	if item.producer != nil {
		defer item.producer.Done()
	}
	handler(item.message, s)
}

func (s *Session) handleRPCQueue(queue <-chan rpcQueueMessage, workerCtx context.Context) {
	for {
		select {
		case <-workerCtx.Done():
			return
		case item := <-queue:
			go s.handleRPCQueueItem(item)
		}
	}
}

func (s *Session) startManagedWorkers() {
	s.hidQueueLock.Lock()
	if s.managedWorkersStarted {
		s.hidQueueLock.Unlock()
		return
	}
	s.managedWorkersStarted = true
	hidQueues := append([]chan hidQueueMessage(nil), s.hidQueue...)
	s.hidQueueLock.Unlock()

	s.rpcQueueLock.Lock()
	rpcQueue := s.rpcQueue
	rpcWorkerCtx := s.rpcWorkerCtx
	rpcWorkerDone := s.rpcWorkerDone
	startRPCWorker := rpcQueue != nil && rpcWorkerCtx != nil && !s.rpcQueueClosing
	if startRPCWorker {
		s.rpcWorkerStarted = true
	}
	s.rpcQueueLock.Unlock()
	if startRPCWorker {
		go func() {
			defer close(rpcWorkerDone)
			s.handleRPCQueue(rpcQueue, rpcWorkerCtx)
		}()
	}
	for _, queue := range hidQueues {
		go s.handleQueues(queue)
	}
}

func (s *Session) handleQueues(queue <-chan hidQueueMessage) {
	for msg := range queue {
		onHidMessage(msg, s)
	}
}

func (s *Session) enqueueHIDQueueMessage(queueIndex int, msg hidQueueMessage) (int, bool) {
	s.hidQueueLock.Lock()
	defer s.hidQueueLock.Unlock()
	if queueIndex >= len(s.hidQueue) || queueIndex < 0 {
		queueIndex = 3
	}
	if queueIndex >= len(s.hidQueue) {
		return queueIndex, false
	}
	queue := s.hidQueue[queueIndex]
	if queue == nil {
		return queueIndex, false
	}
	select {
	case queue <- msg:
		return queueIndex, true
	case <-msg.producer.Context().Done():
		return queueIndex, false
	}
}

const keysDownStateQueueSize = 64

func (s *Session) initKeysDownStateQueue() {
	// serialise outbound key state reports so unreliable links can't stall input handling
	s.hidQueueLock.Lock()
	queue := make(chan usbgadget.KeysDownState, keysDownStateQueueSize)
	s.keysDownStateQueue = queue
	s.hidQueueLock.Unlock()
	go s.handleKeysDownStateQueue(queue)
}

func (s *Session) handleKeysDownStateQueue(queue <-chan usbgadget.KeysDownState) {
	for state := range queue {
		s.reportHidRPCKeysDownState(state)
	}
}

func (s *Session) enqueueKeysDownState(state usbgadget.KeysDownState) {
	if s == nil {
		return
	}

	s.hidQueueLock.Lock()
	defer s.hidQueueLock.Unlock()

	if s.keysDownStateQueue == nil {
		return
	}

	select {
	case s.keysDownStateQueue <- state:
	default:
		hidRPCLogger.Warn().Msg("dropping keys down state update; queue full")
	}
}

func (s *Session) closeHIDQueues() {
	s.hidQueueLock.Lock()
	defer s.hidQueueLock.Unlock()

	for i := 0; i < len(s.hidQueue); i++ {
		if s.hidQueue[i] != nil {
			close(s.hidQueue[i])
		}
		s.hidQueue[i] = nil
	}

	if s.keysDownStateQueue != nil {
		close(s.keysDownStateQueue)
	}
	s.keysDownStateQueue = nil
}

func getOnHidMessageHandler(session *Session, scopedLogger *zerolog.Logger, channel string) func(msg webrtc.DataChannelMessage) {
	return func(msg webrtc.DataChannelMessage) {
		l := scopedLogger.With().
			Str("channel", channel).
			Int("length", len(msg.Data)).
			Logger()
		// only log data if the log level is debug or lower
		if scopedLogger.GetLevel() > zerolog.DebugLevel {
			l = l.With().Str("data", string(msg.Data)).Logger()
		}

		if msg.IsString {
			l.Warn().Msg("received string data in HID RPC message handler")
			return
		}

		if len(msg.Data) < 1 {
			l.Warn().Msg("received empty data in HID RPC message handler")
			return
		}

		l.Trace().Msg("received data in HID RPC message handler")

		// Register before the potentially blocking enqueue so draining cancels
		// blocked and queued work as one producer.
		producer, ok := sessionManager.StartProducer(session.managerGenerationLoad(), controlsession.ProducerHIDQueue)
		if !ok {
			l.Debug().Msg("rejecting HID message for stale or draining session")
			return
		}
		queueIndex := hidrpc.GetQueueIndex(hidrpc.MessageType(msg.Data[0]))
		actualQueueIndex, enqueued := session.enqueueHIDQueueMessage(queueIndex, hidQueueMessage{
			DataChannelMessage: msg,
			channel:            channel,
			producer:           producer,
		})
		if actualQueueIndex != queueIndex {
			l.Warn().Int("queueIndex", queueIndex).Msg("received data in HID RPC message handler, but queue index not found")
		}
		if !enqueued {
			producer.Done()
			l.Warn().Int("queueIndex", actualQueueIndex).Msg("received data in HID RPC message handler, but queue is nil or unavailable")
			return
		}
	}
}

func newSession(config SessionConfig) (*Session, error) {
	webrtcSettingEngine := webrtc.SettingEngine{
		LoggerFactory: logging.GetPionDefaultLoggerFactory(),
	}

	mDNSNetworkTypes := make([]webrtc.NetworkType, 0)
	if config.MDNSMode == "auto" || config.MDNSMode == "ipv4_only" {
		mDNSNetworkTypes = append(mDNSNetworkTypes, webrtc.NetworkTypeUDP4)
	}
	if config.MDNSMode == "auto" || config.MDNSMode == "ipv6_only" {
		mDNSNetworkTypes = append(mDNSNetworkTypes, webrtc.NetworkTypeUDP6)
	}

	if len(mDNSNetworkTypes) > 0 {
		webrtcSettingEngine.SetNetworkTypes(mDNSNetworkTypes)
		webrtcSettingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	} else {
		webrtcSettingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	}

	iceServer := webrtc.ICEServer{}

	var scopedLogger *zerolog.Logger
	if config.Logger != nil {
		l := config.Logger.With().Str("component", "webrtc").Logger()
		scopedLogger = &l
	} else {
		scopedLogger = webrtcLogger
	}

	if config.IsCloud {
		if config.ICEServers == nil {
			scopedLogger.Info().Msg("ICE Servers not provided by cloud")
		} else {
			iceServer.URLs = config.ICEServers
			scopedLogger.Info().Interface("iceServers", iceServer.URLs).Msg("Using ICE Servers provided by cloud")
		}

		if config.LocalIP == "" || net.ParseIP(config.LocalIP) == nil {
			scopedLogger.Info().Str("localIP", config.LocalIP).Msg("Local IP address not provided or invalid, won't set ICEAddressRewriteRules")
		} else {
			err := webrtcSettingEngine.SetICEAddressRewriteRules(
				webrtc.ICEAddressRewriteRule{
					CIDR:            "0.0.0.0/0",
					External:        []string{config.LocalIP},
					Mode:            webrtc.ICEAddressRewriteAppend,
					AsCandidateType: webrtc.ICECandidateTypeSrflx,
				},
			)
			if err != nil {
				scopedLogger.Warn().Err(err).Str("localIP", config.LocalIP).Msg("Failed to set ICEAddressRewriteRules")
			} else {
				scopedLogger.Info().Str("localIP", config.LocalIP).Msg("Set ICEAddressRewriteRules for local IP")
			}
		}
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(webrtcSettingEngine))
	peerConnection, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{iceServer},
	})
	if err != nil {
		scopedLogger.Warn().Err(err).Msg("Failed to create PeerConnection")
		return nil, err
	}

	session := &Session{peerConnection: peerConnection}
	session.initRPCQueue()
	session.initQueues()
	session.initKeysDownStateQueue()

	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		defer func() {
			if r := recover(); r != nil {
				scopedLogger.Error().Interface("error", r).Msg("Recovered from panic in DataChannel handler")
			}
		}()

		scopedLogger.Info().Str("label", d.Label()).Uint16("id", *d.ID()).Msg("New DataChannel")

		switch d.Label() {
		case "hidrpc":
			session.HidChannel = d
			d.OnMessage(getOnHidMessageHandler(session, scopedLogger, "hidrpc"))
		// we won't send anything over the unreliable channels
		case "hidrpc-unreliable-ordered":
			d.OnMessage(getOnHidMessageHandler(session, scopedLogger, "hidrpc-unreliable-ordered"))
		case "hidrpc-unreliable-nonordered":
			d.OnMessage(getOnHidMessageHandler(session, scopedLogger, "hidrpc-unreliable-nonordered"))
		case "rpc":
			session.RPCChannel = d
			d.OnMessage(func(msg webrtc.DataChannelMessage) {
				if !session.enqueueRPCMessage(msg) {
					scopedLogger.Debug().Msg("rejecting RPC message because session queue is unavailable")
				}
			})
			// Wait for channel to be open before sending initial state
			d.OnOpen(func() {
				triggerOTAStateUpdate(otaState.ToRPCState())
				triggerVideoStateUpdate()
				triggerUSBStateUpdate()
				notifyFailsafeMode(session)
			})
		case "terminal":
			handleTerminalChannel(d)
		case "serial":
			handleSerialChannel(d)
		default:
			if strings.HasPrefix(d.Label(), uploadIdPrefix) {
				go handleUploadChannel(d)
			}
		}
	})

	session.VideoTrack, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "kvm")
	if err != nil {
		scopedLogger.Warn().Err(err).Msg("Failed to create VideoTrack")
		return nil, err
	}

	rtpSender, err := peerConnection.AddTrack(session.VideoTrack)
	if err != nil {
		scopedLogger.Warn().Err(err).Msg("Failed to add VideoTrack to PeerConnection")
		return nil, err
	}

	// Read incoming RTCP packets
	// Before these packets are returned they are processed by interceptors. For things
	// like NACK this needs to be called.
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, rtcpErr := rtpSender.Read(rtcpBuf); rtcpErr != nil {
				return
			}
		}
	}()
	var isConnected bool

	peerConnection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		scopedLogger.Info().Interface("candidate", candidate).Msg("WebRTC peerConnection has a new ICE candidate")
		if candidate != nil && config.ws != nil {
			err := wsjson.Write(context.Background(), config.ws, gin.H{"type": "new-ice-candidate", "data": candidate.ToJSON()})
			if err != nil {
				scopedLogger.Warn().Err(err).Msg("failed to write new-ice-candidate to WebRTC signaling channel")
			}
		}
	})

	peerConnection.OnICEConnectionStateChange(func(connectionState webrtc.ICEConnectionState) {
		scopedLogger.Info().Str("connectionState", connectionState.String()).Msg("ICE Connection State has changed")
		if connectionState == webrtc.ICEConnectionStateConnected {
			if !isConnected {
				isConnected = true
				onActiveSessionsChanged()
				if incrActiveSessions() == 1 {
					onFirstSessionConnected()
				}
			}
		}
		//state changes on closing browser tab disconnected->failed, we need to manually close it
		if connectionState == webrtc.ICEConnectionStateFailed {
			scopedLogger.Debug().Msg("ICE Connection State is failed, closing peerConnection")
			_ = peerConnection.Close()
		}
		if connectionState == webrtc.ICEConnectionStateClosed {
			scopedLogger.Debug().Msg("ICE Connection State is closed, unmounting virtual media")
			closeManagedSession(session, "session-close")
			// Cancel and join queue admission before stopping its consumer. The
			// queue remains allocated because no sender-visible channel is closed.
			session.stopRPCQueue()

			// Stop HID RPC processor
			session.closeHIDQueues()

			if session.shouldUmountVirtualMedia {
				if err := rpcUnmountImage(); err != nil {
					scopedLogger.Warn().Err(err).Msg("unmount image failed on connection close")
				}
			}
			if isConnected {
				isConnected = false
				onActiveSessionsChanged()
				if decrActiveSessions() == 0 {
					scopedLogger.Info().Msg("last session disconnected, stopping video stream")
					onLastSessionDisconnected()
				}
			}
		}
	})
	return session, nil
}

func onActiveSessionsChanged() {
	notifyFailsafeMode(currentSessionRead())
	requestDisplayUpdate(true, "active_sessions_changed")
}

func onFirstSessionConnected() {
	notifyFailsafeMode(currentSessionRead())
	_ = nativeInstance.VideoStart()
	stopVideoSleepModeTicker()
}

func onLastSessionDisconnected() {
	_ = nativeInstance.VideoStop()
	startVideoSleepModeTicker()
}
