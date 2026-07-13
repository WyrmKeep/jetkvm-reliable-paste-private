package kvm

import (
	"errors"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
	"github.com/jetkvm/kvm/internal/usbgadget"
)

// lastKeyboardReportTime is the unix-nano timestamp of the most recent
// keyboard HID report written through the app (interactive or macro).
// Used by wakeTargetForPaste to detect an idle host before a paste.
var lastKeyboardReportTime atomic.Int64

// pasteDropEvery, when > 0 (set via env JETKVM_PASTE_DROP at startup),
// makes rpcKeyboardReport silently drop every Nth non-empty keyboard report
// — i.e. simulate a single dropped keystroke. This is a TEST-ONLY fault
// injector for validating the OCR verify/auto-repair stack against realistic
// sparse loss WITHOUT the CPU stress that also degrades the video/OCR. It is
// off unless the env var is set, and only the dev build's launch sets it.
var pasteDropEvery = func() int64 {
	if v, err := strconv.Atoi(os.Getenv("JETKVM_PASTE_DROP")); err == nil && v > 0 {
		return int64(v)
	}
	return 0
}()
var keyboardReportSeq atomic.Int64

var gadget *usbgadget.UsbGadget
var usbMonitorInstance *usbMonitor
var keyboardReportWrite = func(modifier byte, keys []byte) error {
	return gadget.KeyboardReport(modifier, keys)
}
var keyboardStateClearWrite = func() error {
	return gadget.ClearKeyboardState()
}
var keypressReportWrite = func(key byte, press bool) error {
	return gadget.KeypressReport(key, press)
}
var absMouseReportWrite = func(x int, y int, buttons uint8) error {
	return gadget.AbsMouseReport(x, y, buttons)
}
var relMouseReportWrite = func(dx int8, dy int8, buttons uint8) error {
	return gadget.RelMouseReport(dx, dy, buttons)
}
var wheelReportWrite = func(wheelY int8) error {
	return gadget.AbsMouseWheelReport(wheelY)
}

var maintenanceHIDDevicesRead = func() usbgadget.Devices {
	if config == nil || config.UsbDevices == nil {
		return defaultUsbDevices
	}
	return *config.UsbDevices
}

type absolutePointerPosition struct {
	mu sync.Mutex
	x  int
	y  int
}

var lastAbsolutePointerPosition absolutePointerPosition

var maintenanceAbsPointerZeroWrite = func(x int, y int) error {
	return absMouseReportWrite(x, y, 0)
}

var errStaleControlSession = errors.New("control session is stale or draining")

func withOrdinaryGeneration(generation controlsession.Generation, write func() error) error {
	lease, ok := sessionManager.Acquire(generation)
	if !ok {
		return errStaleControlSession
	}
	defer lease.Release()
	return write()
}

var maintenanceKeyboardZeroWrite = func(lease controlsession.MaintenanceLease) error {
	if !lease.Valid() {
		return errStaleControlSession
	}
	if !maintenanceHIDDevicesRead().Keyboard {
		return nil
	}
	return keyboardStateClearWrite()
}

var maintenancePointerZeroWrite = func(lease controlsession.MaintenanceLease) error {
	if !lease.Valid() {
		return errStaleControlSession
	}

	enabled := maintenanceHIDDevicesRead()
	var absoluteErr error
	if enabled.AbsoluteMouse {
		lastAbsolutePointerPosition.mu.Lock()
		absoluteErr = maintenanceAbsPointerZeroWrite(lastAbsolutePointerPosition.x, lastAbsolutePointerPosition.y)
		lastAbsolutePointerPosition.mu.Unlock()
	}
	var relativeErr error
	if enabled.RelativeMouse {
		relativeErr = relMouseReportWrite(0, 0, 0)
	}
	return errors.Join(absoluteErr, relativeErr)
}

func zeroInputWithMaintenanceLease(lease controlsession.MaintenanceLease) (error, error) {
	return maintenanceKeyboardZeroWrite(lease), maintenancePointerZeroWrite(lease)
}

// initUsbGadget initializes the USB gadget.
// call it only after the config is loaded.
func initUsbGadget() {
	gadget = usbgadget.NewUsbGadget(
		"jetkvm",
		config.UsbDevices,
		config.UsbConfig,
		usbLogger,
	)

	usbMonitorInstance = newUsbMonitor(
		gadget,
		time.Now,
		gadget.GetUsbState,
		usbLogger,
	)

	// Start the polling loop
	go func() {
		for {
			usbMonitorInstance.tick()
			time.Sleep(500 * time.Millisecond)
		}
	}()

	// Start the state update consumer
	go usbStateConsumer()

	gadget.SetOnKeyboardStateChange(func(state usbgadget.KeyboardState) {
		if session := currentSessionRead(); session != nil {
			session.reportHidRPCKeyboardLedState(state)
		}
	})

	gadget.SetOnKeysDownChange(func(state usbgadget.KeysDownState) {
		if session := currentSessionRead(); session != nil {
			session.enqueueKeysDownState(state)
		}
	})

	gadget.SetOnKeepAliveReset(func() {
		if session := currentSessionRead(); session != nil {
			session.resetKeepAliveTime()
		}
	})

	// open the keyboard hid file to listen for keyboard events
	if err := gadget.OpenKeyboardHidFile(); err != nil {
		usbLogger.Error().Err(err).Msg("failed to open keyboard hid file")
	}
}

func keyboardReportWithOrdinaryLease(lease *controlsession.Lease, modifier byte, keys []byte) error {
	if !lease.Valid() {
		return errStaleControlSession
	}
	lastKeyboardReportTime.Store(time.Now().UnixNano())
	if pasteDropEvery > 0 {
		nonEmpty := modifier != 0
		for _, k := range keys {
			if k != 0 {
				nonEmpty = true
				break
			}
		}
		if nonEmpty && keyboardReportSeq.Add(1)%pasteDropEvery == 0 {
			usbLogger.Warn().Msg("paste-drop: simulating dropped keyboard report")
			return nil
		}
	}
	return keyboardReportWrite(modifier, keys)
}

func rpcKeyboardReportForGeneration(generation controlsession.Generation, modifier byte, keys []byte) error {
	lease, ok := sessionManager.Acquire(generation)
	if !ok {
		return errStaleControlSession
	}
	defer lease.Release()
	return keyboardReportWithOrdinaryLease(lease, modifier, keys)
}

func rpcKeyboardReportForSession(session *Session, modifier byte, keys []byte) error {
	if session == nil {
		return errStaleControlSession
	}
	return rpcKeyboardReportForGeneration(session.managerGenerationLoad(), modifier, keys)
}

func rpcKeyboardReport(modifier byte, keys []byte) error {
	return rpcKeyboardReportForGeneration(currentSessionSnapshot().Generation, modifier, keys)
}

func flushKeyboardHIDTee() {
	if gadget == nil {
		return
	}
	if err := gadget.FlushKeyboardHIDTee(); err != nil {
		usbLogger.Warn().Err(err).Msg("failed to flush keyboard HID tee")
	}
}

func rpcKeypressReportForSession(session *Session, key byte, press bool) error {
	if session == nil {
		return errStaleControlSession
	}
	return withOrdinaryGeneration(session.managerGenerationLoad(), func() error {
		return keypressReportWrite(key, press)
	})
}

func rpcAbsMouseReportForSession(session *Session, x int, y int, buttons uint8) error {
	if session == nil {
		return errStaleControlSession
	}
	return withOrdinaryGeneration(session.managerGenerationLoad(), func() error {
		lastAbsolutePointerPosition.mu.Lock()
		defer lastAbsolutePointerPosition.mu.Unlock()
		if err := absMouseReportWrite(x, y, buttons); err != nil {
			return err
		}
		lastAbsolutePointerPosition.x = x
		lastAbsolutePointerPosition.y = y
		return nil
	})
}

func rpcRelMouseReportForSession(session *Session, dx int8, dy int8, buttons uint8) error {
	if session == nil {
		return errStaleControlSession
	}
	return withOrdinaryGeneration(session.managerGenerationLoad(), func() error {
		return relMouseReportWrite(dx, dy, buttons)
	})
}

func rpcWheelReportForSession(session *Session, wheelY int8) error {
	if session == nil {
		return errStaleControlSession
	}
	return withOrdinaryGeneration(session.managerGenerationLoad(), func() error {
		return wheelReportWrite(wheelY)
	})
}

func rpcAbsMouseReport(x int, y int, buttons uint8) error {
	session := currentSessionRead()
	if session == nil {
		return errStaleControlSession
	}
	return rpcAbsMouseReportForSession(session, x, y, buttons)
}

func rpcGetKeyboardLedState() (state usbgadget.KeyboardState) {
	return gadget.GetKeyboardState()
}

func rpcGetKeysDownState() (state usbgadget.KeysDownState) {
	return gadget.GetKeysDownState()
}

func rpcGetUSBState() (state string) {
	if usbMonitorInstance != nil {
		return usbMonitorInstance.EffectiveState()
	}
	return gadget.GetUsbState()
}

// triggerUSBStateUpdate pushes the current effective state through the monitor's channel.
func triggerUSBStateUpdate() {
	if usbMonitorInstance == nil {
		return
	}
	state := usbMonitorInstance.EffectiveState()
	select {
	case usbMonitorInstance.stateCh <- stateUpdate{
		raw:       usbMonitorInstance.RawState(),
		effective: state,
		reason:    "session_init",
	}:
	default:
		usbLogger.Warn().Msg("USB state update channel full during triggerUSBStateUpdate")
	}
}

// usbStateConsumer reads from the monitor's state channel and publishes to display + RPC.
func usbStateConsumer() {
	for update := range usbMonitorInstance.stateCh {
		requestDisplayUpdate(true, "usb_state_changed")
		if session := currentSessionRead(); session != nil {
			writeJSONRPCEvent("usbState", update.effective, session)
		}
	}
}
