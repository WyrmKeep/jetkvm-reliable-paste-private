package kvm

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jetkvm/kvm/internal/controlsession"
	"github.com/pion/webrtc/v4"
)

func installSessionManagerTestSeams(t *testing.T) (*atomic.Int32, *atomic.Int32) {
	t.Helper()
	oldManager := sessionManager
	oldKeyboardClear := keyboardStateClearWrite
	oldPointer := relMouseReportWrite
	oldAbsolutePointer := maintenanceAbsPointerZeroWrite
	sessionManager = controlsession.New[*Session]()
	keyboardWrites := &atomic.Int32{}
	pointerWrites := &atomic.Int32{}
	keyboardStateClearWrite = func() error {
		keyboardWrites.Add(1)
		return nil
	}
	relMouseReportWrite = func(int8, int8, uint8) error {
		pointerWrites.Add(1)
		return nil
	}
	maintenanceAbsPointerZeroWrite = func(int, int) error { return nil }
	t.Cleanup(func() {
		sessionManager = oldManager
		keyboardStateClearWrite = oldKeyboardClear
		relMouseReportWrite = oldPointer
		maintenanceAbsPointerZeroWrite = oldAbsolutePointer
	})
	return keyboardWrites, pointerWrites
}

func TestActivateSessionSerializesSimultaneousOffers(t *testing.T) {
	keyboardWrites, pointerWrites := installSessionManagerTestSeams(t)
	initial := &Session{}
	if _, err := activateSession(context.Background(), initial, "initial"); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	sessions := []*Session{{}, {}}
	for _, session := range sessions {
		session := session
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := activateSession(context.Background(), session, "simultaneous"); err != nil {
				t.Errorf("activate: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	snapshot := currentSessionSnapshot()
	currentGeneration := snapshot.Current.managerGenerationLoad()
	firstGeneration := sessions[0].managerGenerationLoad()
	secondGeneration := sessions[1].managerGenerationLoad()
	if snapshot.Generation != 3 || !snapshot.HasCurrent || currentGeneration == 0 {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if firstGeneration == secondGeneration || firstGeneration == 0 || secondGeneration == 0 {
		t.Fatalf("offer generations=%d,%d", firstGeneration, secondGeneration)
	}
	if keyboardWrites.Load() != 3 || pointerWrites.Load() != 3 {
		t.Fatalf("zero writes keyboard=%d pointer=%d", keyboardWrites.Load(), pointerWrites.Load())
	}
}

func TestOldSessionWireQuiesceIsCorrelatedStaleAndDoesNotWrite(t *testing.T) {
	keyboardWrites, pointerWrites := installSessionManagerTestSeams(t)
	old := &Session{}
	if _, err := activateSession(context.Background(), old, "initial"); err != nil {
		t.Fatal(err)
	}
	current := &Session{}
	if _, err := activateSession(context.Background(), current, "takeover"); err != nil {
		t.Fatal(err)
	}
	beforeKeyboard, beforePointer := keyboardWrites.Load(), pointerWrites.Load()
	receipt := rpcQuiesceAndZero(old, "operation-old")
	if receipt.OperationID != "operation-old" || receipt.Generation != old.managerGenerationLoad() || receipt.Outcome != controlsession.OutcomeStale {
		t.Fatalf("receipt=%+v", receipt)
	}
	if receipt.KeyboardZero || receipt.PointerZero || keyboardWrites.Load() != beforeKeyboard || pointerWrites.Load() != beforePointer {
		t.Fatalf("stale request wrote: receipt=%+v keyboard=%d pointer=%d", receipt, keyboardWrites.Load(), pointerWrites.Load())
	}
}

func TestStaleSessionInputHelpersNeverReachGadgetWriters(t *testing.T) {
	installSessionManagerTestSeams(t)
	stale := &Session{}
	if _, err := activateSession(context.Background(), stale, "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := activateSession(context.Background(), &Session{}, "second"); err != nil {
		t.Fatal(err)
	}

	oldKeyboard := keyboardReportWrite
	oldKeypress := keypressReportWrite
	oldAbs := absMouseReportWrite
	oldRel := relMouseReportWrite
	oldWheel := wheelReportWrite
	var rawWrites atomic.Int32
	keyboardReportWrite = func(byte, []byte) error { rawWrites.Add(1); return nil }
	keypressReportWrite = func(byte, bool) error { rawWrites.Add(1); return nil }
	absMouseReportWrite = func(int, int, uint8) error { rawWrites.Add(1); return nil }
	relMouseReportWrite = func(int8, int8, uint8) error { rawWrites.Add(1); return nil }
	wheelReportWrite = func(int8) error { rawWrites.Add(1); return nil }
	t.Cleanup(func() {
		keyboardReportWrite = oldKeyboard
		keypressReportWrite = oldKeypress
		absMouseReportWrite = oldAbs
		relMouseReportWrite = oldRel
		wheelReportWrite = oldWheel
	})

	writes := []func() error{
		func() error { return rpcKeyboardReportForSession(stale, 0, keyboardClearStateKeys) },
		func() error { return rpcKeypressReportForSession(stale, 0, false) },
		func() error { return rpcAbsMouseReportForSession(stale, 1, 2, 0) },
		func() error { return rpcRelMouseReportForSession(stale, 1, 2, 0) },
		func() error { return rpcWheelReportForSession(stale, 1) },
	}
	for _, write := range writes {
		if err := write(); !errors.Is(err, errStaleControlSession) {
			t.Fatalf("stale input error=%v", err)
		}
	}
	if rawWrites.Load() != 0 {
		t.Fatalf("stale session reached gadget writers %d times", rawWrites.Load())
	}
}

func TestEmergencyAndTakeoverUseSameQuiescePrimitive(t *testing.T) {
	keyboardWrites, pointerWrites := installSessionManagerTestSeams(t)
	first := &Session{}
	if _, err := activateSession(context.Background(), first, "initial"); err != nil {
		t.Fatal(err)
	}
	emergency := rpcQuiesceAndZero(first, "emergency")
	if emergency.Outcome != controlsession.OutcomeReleased {
		t.Fatalf("emergency=%+v", emergency)
	}
	if _, ok := sessionManager.Acquire(first.managerGenerationLoad()); ok {
		t.Fatal("emergency release reopened generation")
	}
	second := &Session{}
	if _, err := activateSession(context.Background(), second, "takeover-after-emergency"); err != nil {
		t.Fatal(err)
	}
	if keyboardWrites.Load() != 3 || pointerWrites.Load() != 3 {
		t.Fatalf("zero writes keyboard=%d pointer=%d", keyboardWrites.Load(), pointerWrites.Load())
	}
}

func TestSignallingCandidateTargetsOriginatingOfferSession(t *testing.T) {
	installSessionManagerTestSeams(t)
	first := &Session{}
	second := &Session{}
	if _, err := activateSession(context.Background(), first, "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := activateSession(context.Background(), second, "second"); err != nil {
		t.Fatal(err)
	}
	oldAdd := addICECandidateToSession
	var got *Session
	addICECandidateToSession = func(session *Session, candidate webrtc.ICECandidateInit) error {
		got = session
		return nil
	}
	t.Cleanup(func() { addICECandidateToSession = oldAdd })
	if err := routeSignallingCandidate(first, webrtc.ICECandidateInit{Candidate: "candidate"}); err != nil {
		t.Fatal(err)
	}
	if got != first {
		t.Fatalf("candidate routed to %p, want originating %p", got, first)
	}
}

func TestFailedOfferRetainsLastSuccessfulSignallingSession(t *testing.T) {
	first := &Session{}
	offerErr := errors.New("second offer failed")

	signallingSession, err := updateSignallingSession(nil, func() (*Session, error) {
		return first, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	signallingSession, err = updateSignallingSession(signallingSession, func() (*Session, error) {
		return nil, offerErr
	})
	if !errors.Is(err, offerErr) {
		t.Fatalf("second offer error=%v", err)
	}

	oldAdd := addICECandidateToSession
	var got *Session
	addICECandidateToSession = func(session *Session, candidate webrtc.ICECandidateInit) error {
		got = session
		return nil
	}
	t.Cleanup(func() { addICECandidateToSession = oldAdd })
	if err := routeSignallingCandidate(signallingSession, webrtc.ICECandidateInit{Candidate: "candidate"}); err != nil {
		t.Fatal(err)
	}
	if got != first {
		t.Fatalf("candidate routed to %p, want retained session %p", got, first)
	}
}

func TestSessionGenerationAccessIsRaceSafe(t *testing.T) {
	session := &Session{}
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		for generation := controlsession.Generation(1); generation <= 10_000; generation++ {
			session.managerGenerationStore(generation)
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		for range 10_000 {
			_ = session.managerGenerationLoad()
		}
	}()
	close(start)
	wg.Wait()
	if generation := session.managerGenerationLoad(); generation != 10_000 {
		t.Fatalf("final generation=%d, want 10000", generation)
	}
}

func TestGenerationPreparedBeforePublicationAllowsBoundaryClose(t *testing.T) {
	installSessionManagerTestSeams(t)
	oldPrepare := prepareSessionGeneration
	prepared := make(chan struct{})
	allowPublication := make(chan struct{})
	prepareSessionGeneration = func(session *Session, generation controlsession.Generation) {
		oldPrepare(session, generation)
		close(prepared)
		<-allowPublication
	}
	t.Cleanup(func() { prepareSessionGeneration = oldPrepare })

	session := &Session{}
	activationDone := make(chan error, 1)
	go func() {
		_, err := activateSession(context.Background(), session, "boundary-activation")
		activationDone <- err
	}()
	<-prepared
	boundGeneration := session.managerGenerationLoad()
	if boundGeneration == 0 {
		t.Fatal("generation was not stored at preparation boundary")
	}

	closeDone := make(chan controlsession.Receipt, 1)
	go func() { closeDone <- closeManagedSession(session, "boundary-close") }()
	close(allowPublication)
	if err := <-activationDone; err != nil {
		t.Fatal(err)
	}
	receipt := <-closeDone
	if receipt.Outcome != controlsession.OutcomeReleased || receipt.Generation != boundGeneration {
		t.Fatalf("boundary close receipt=%+v boundGeneration=%d", receipt, boundGeneration)
	}
	if snapshot := currentSessionSnapshot(); snapshot.HasCurrent {
		t.Fatalf("boundary close did not clear exact published generation: %+v", snapshot)
	}
}

func TestFailedCandidateActivationClosesPeerConnection(t *testing.T) {
	installSessionManagerTestSeams(t)
	peerConnection, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{peerConnection: peerConnection}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	receipt, err := activateCandidateSession(ctx, session, "forced-failure")
	if err == nil || receipt.Outcome != controlsession.OutcomeUnknown {
		t.Fatalf("activation err=%v receipt=%+v", err, receipt)
	}
	if snapshot := currentSessionSnapshot(); snapshot.HasCurrent {
		t.Fatalf("failed candidate was published: %+v", snapshot)
	}
	if state := peerConnection.ConnectionState(); state != webrtc.PeerConnectionStateClosed {
		t.Fatalf("failed candidate peer connection state=%s, want closed", state)
	}
}

func TestClosingStaleSessionDoesNotClearCurrent(t *testing.T) {
	installSessionManagerTestSeams(t)
	old := &Session{}
	_, _ = activateSession(context.Background(), old, "first")
	current := &Session{}
	_, _ = activateSession(context.Background(), current, "second")
	closeManagedSession(old, "old-close")
	if snapshot := currentSessionSnapshot(); snapshot.Current != current || !snapshot.HasCurrent {
		t.Fatalf("stale close cleared current: %+v", snapshot)
	}
}

func TestQuiesceWaitsBlockedGadgetWriterAndRejectsPostZeroWrite(t *testing.T) {
	installSessionManagerTestSeams(t)
	session := &Session{}
	if _, err := activateSession(context.Background(), session, "initial"); err != nil {
		t.Fatal(err)
	}
	oldAbs := absMouseReportWrite
	writeStarted := make(chan struct{})
	unblockWrite := make(chan struct{})
	var rawWrites atomic.Int32
	absMouseReportWrite = func(int, int, uint8) error {
		rawWrites.Add(1)
		close(writeStarted)
		<-unblockWrite
		return nil
	}
	t.Cleanup(func() { absMouseReportWrite = oldAbs })

	writeDone := make(chan error, 1)
	go func() { writeDone <- rpcAbsMouseReportForSession(session, 1, 2, 0) }()
	<-writeStarted
	releaseDone := make(chan controlsession.Receipt, 1)
	go func() { releaseDone <- rpcQuiesceAndZero(session, "blocked-writer") }()

	for !sessionManager.Snapshot().Draining {
		runtime.Gosched()
	}
	if err := rpcAbsMouseReportForSession(session, 3, 4, 0); !errors.Is(err, errStaleControlSession) {
		t.Fatalf("draining write error=%v", err)
	}
	select {
	case <-releaseDone:
		t.Fatal("maintenance zero ran before blocked ordinary writer released")
	default:
	}
	close(unblockWrite)
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
	receipt := <-releaseDone
	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.OrdinaryLeasesZero {
		t.Fatalf("receipt=%+v", receipt)
	}
	if err := rpcAbsMouseReportForSession(session, 5, 6, 0); !errors.Is(err, errStaleControlSession) {
		t.Fatalf("post-zero write error=%v", err)
	}
	if rawWrites.Load() != 1 {
		t.Fatalf("raw writes=%d, want 1", rawWrites.Load())
	}
}

func TestQuiesceCancelsAndJoinsMacroAndPasteProducers(t *testing.T) {
	installSessionManagerTestSeams(t)
	session := &Session{}
	if _, err := activateSession(context.Background(), session, "initial"); err != nil {
		t.Fatal(err)
	}
	macro, ok := sessionManager.StartProducer(session.managerGenerationLoad(), controlsession.ProducerMacro)
	if !ok {
		t.Fatal("macro producer rejected")
	}
	paste, ok := sessionManager.StartProducer(session.managerGenerationLoad(), controlsession.ProducerPaste)
	if !ok {
		t.Fatal("paste producer rejected")
	}
	done := make(chan controlsession.Receipt, 1)
	go func() { done <- rpcQuiesceAndZero(session, "cancel-producers") }()
	<-macro.Context().Done()
	<-paste.Context().Done()
	select {
	case <-done:
		t.Fatal("quiesce returned before producers joined")
	default:
	}
	macro.Done()
	paste.Done()
	receipt := <-done
	if !receipt.ProducersJoined || !receipt.MacroInactive || !receipt.PasteInactive {
		t.Fatalf("receipt=%+v", receipt)
	}
}
