package kvm

import (
	"context"
	"testing"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
	"github.com/pion/webrtc/v4"
)

func installQueueLifecycleSession(t *testing.T) *Session {
	t.Helper()

	oldManager := sessionManager
	oldKeyboardZero := maintenanceKeyboardZeroWrite
	oldPointerZero := maintenancePointerZeroWrite
	maintenanceKeyboardZeroWrite = func(controlsession.MaintenanceLease) error { return nil }
	maintenancePointerZeroWrite = func(controlsession.MaintenanceLease) error { return nil }
	sessionManager = controlsession.New[*Session]()
	session := &Session{}
	snapshot := sessionManager.PublishInitial(session)
	session.managerGenerationStore(snapshot.Generation)
	session.initRPCQueue()
	t.Cleanup(func() {
		session.stopRPCQueue()
		maintenanceKeyboardZeroWrite = oldKeyboardZero
		maintenancePointerZeroWrite = oldPointerZero
		sessionManager = oldManager
	})
	return session
}

func waitQueueTest[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

func TestRPCQueueBlockedMaintenanceAdmissionReturnsDuringShutdown(t *testing.T) {
	session := installQueueLifecycleSession(t)
	session.rpcQueue = make(chan rpcQueueMessage, 1)
	session.rpcQueue <- rpcQueueMessage{}

	queueAdmission, ok := session.beginRPCQueueAdmission()
	if !ok {
		t.Fatal("RPC queue admission rejected")
	}
	admissionResult := make(chan bool, 1)
	go func() {
		enqueued := session.enqueueRPCQueueMessage(rpcQueueMessage{admission: queueAdmission})
		queueAdmission.Done()
		admissionResult <- enqueued
	}()

	// Match ICE teardown ordering: quiesce manager-owned work first, then stop
	// queue admission and join every sender before stopping the worker.
	receipt := closeManagedSession(session, "queue-close")
	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.ProducersJoined {
		t.Fatalf("managed close failed before queue shutdown: %+v", receipt)
	}
	stopDone := make(chan struct{})
	go func() {
		session.stopRPCQueue()
		close(stopDone)
	}()

	if enqueued := waitQueueTest(t, admissionResult, "blocked maintenance admission cancellation"); enqueued {
		t.Fatal("maintenance RPC was admitted to a full queue during shutdown")
	}
	waitQueueTest(t, stopDone, "RPC queue admission join")
	if session.rpcQueue == nil {
		t.Fatal("RPC queue was nilled during shutdown")
	}
}

func TestRPCQueueMaintenanceReleasesAdmissionBeforeSelfQuiesce(t *testing.T) {
	session := installQueueLifecycleSession(t)
	receiptCh := make(chan controlsession.Receipt, 1)
	session.rpcQueueHandler = func(webrtc.DataChannelMessage, *Session) {
		receiptCh <- rpcQuiesceAndZero(session, "maintenance")
	}
	session.startManagedWorkers()

	message := webrtc.DataChannelMessage{
		Data:     []byte(`{"jsonrpc":"2.0","method":"quiesceAndZero","params":{"operationId":"maintenance"},"id":1}`),
		IsString: true,
	}
	if !session.enqueueRPCMessage(message) {
		t.Fatal("maintenance RPC was not admitted")
	}

	receipt := waitQueueTest(t, receiptCh, "maintenance self-quiesce")
	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.ProducersJoined {
		t.Fatalf("maintenance RPC self-quiesced with incomplete receipt: %+v", receipt)
	}
}

func TestRPCQueueManagedCloseJoinsDispatchedOrdinaryWork(t *testing.T) {
	session := installQueueLifecycleSession(t)
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	session.rpcQueueHandler = func(webrtc.DataChannelMessage, *Session) {
		close(handlerStarted)
		<-releaseHandler
	}
	session.startManagedWorkers()

	message := webrtc.DataChannelMessage{
		Data:     []byte(`{"jsonrpc":"2.0","method":"ping","id":1}`),
		IsString: true,
	}
	if !session.enqueueRPCMessage(message) {
		t.Fatal("ordinary RPC was not admitted")
	}
	waitQueueTest(t, handlerStarted, "ordinary RPC dispatch")

	receiptCh := make(chan controlsession.Receipt, 1)
	go func() {
		receiptCh <- closeManagedSession(session, "ordinary-close")
	}()
	waitQueueTest(t, sessionManagerProducerCancellation(session), "ordinary RPC cancellation")
	select {
	case receipt := <-receiptCh:
		t.Fatalf("managed close returned before dispatched RPC cleanup: %+v", receipt)
	default:
	}

	close(releaseHandler)
	receipt := waitQueueTest(t, receiptCh, "ordinary RPC join")
	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.ProducersJoined {
		t.Fatalf("managed close did not join ordinary RPC: %+v", receipt)
	}
}

func sessionManagerProducerCancellation(session *Session) <-chan struct{} {
	// A producer context is not exposed after enqueue. Starting another producer
	// gives this test a deterministic observation point for the generation's
	// draining transition: the returned context is canceled with the dispatched
	// producer, and its Done is deliberately deferred until the handler returns.
	producer, ok := sessionManager.StartProducer(session.managerGenerationLoad(), controlsession.ProducerRPC)
	if !ok {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	ctx := producer.Context().Done()
	go func() {
		<-ctx
		producer.Done()
	}()
	return ctx
}

func TestCanceledPasteEnqueueRemainsRegisteredThroughTerminalState(t *testing.T) {
	session := installQueueLifecycleSession(t)
	oldKeyboardZero := maintenanceKeyboardZeroWrite
	oldPointerZero := maintenancePointerZeroWrite
	oldBeforeRollback := beforeCanceledMacroEnqueueRollback
	oldEmitHook := pasteStateEmitHook
	oldPasteDepth := pasteDepth.Load()
	oldPasteFailures := pasteFailures.Load()
	maintenanceKeyboardZeroWrite = func(controlsession.MaintenanceLease) error { return nil }
	maintenancePointerZeroWrite = func(controlsession.MaintenanceLease) error { return nil }
	pasteDepth.Store(1)
	pasteFailures.Store(0)

	rollbackPaused := make(chan struct{})
	releaseRollback := make(chan struct{})
	terminalStateReported := make(chan struct{})
	beforeCanceledMacroEnqueueRollback = func() {
		close(rollbackPaused)
		<-releaseRollback
	}
	pasteStateEmitHook = func(state bool) {
		if !state {
			close(terminalStateReported)
		}
	}
	t.Cleanup(func() {
		maintenanceKeyboardZeroWrite = oldKeyboardZero
		maintenancePointerZeroWrite = oldPointerZero
		beforeCanceledMacroEnqueueRollback = oldBeforeRollback
		pasteStateEmitHook = oldEmitHook
		pasteDepth.Store(oldPasteDepth)
		pasteFailures.Store(oldPasteFailures)
	})

	producer, ok := sessionManager.StartProducer(session.managerGenerationLoad(), controlsession.ProducerPaste)
	if !ok {
		t.Fatal("paste producer rejected")
	}
	fullQueue := make(chan queuedMacro, 1)
	fullQueue <- queuedMacro{}
	enqueueCtx, cancelEnqueue := context.WithCancel(context.Background())
	enqueueDone := make(chan error, 1)
	go func() {
		enqueueDone <- enqueueMacroItem(fullQueue, queuedMacro{
			isPaste:    true,
			session:    session,
			generation: session.managerGenerationLoad(),
			producer:   producer,
		}, enqueueCtx, 1)
	}()
	cancelEnqueue()
	waitQueueTest(t, rollbackPaused, "canceled paste rollback pause")

	receiptCh := make(chan controlsession.Receipt, 1)
	go func() {
		receiptCh <- rpcQuiesceAndZero(session, "paste-cleanup")
	}()
	waitQueueTest(t, producer.Context().Done(), "paste producer cancellation")
	select {
	case receipt := <-receiptCh:
		t.Fatalf("quiesce returned before paste-depth rollback: %+v", receipt)
	default:
	}

	close(releaseRollback)
	if err := waitQueueTest(t, enqueueDone, "paste enqueue cancellation"); err != context.Canceled {
		t.Fatalf("enqueue error = %v, want context.Canceled", err)
	}
	receipt := waitQueueTest(t, receiptCh, "quiesce after paste cleanup")
	select {
	case <-terminalStateReported:
	default:
		t.Fatal("quiesce receipt preceded terminal paste-state event")
	}
	if pasteDepth.Load() != 0 {
		t.Fatalf("paste depth = %d, want 0", pasteDepth.Load())
	}
	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.ProducersJoined || !receipt.PasteInactive {
		t.Fatalf("quiesce returned incomplete paste receipt: %+v", receipt)
	}
}
