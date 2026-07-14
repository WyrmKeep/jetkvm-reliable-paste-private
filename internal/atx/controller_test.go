package atx

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
)

type writeResult struct {
	n   int
	err error
}

type recordingWriter struct {
	mu      sync.Mutex
	writes  []string
	results []writeResult
}

func (w *recordingWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writes = append(w.writes, string(value))
	if len(w.results) == 0 {
		return len(value), nil
	}
	result := w.results[0]
	w.results = w.results[1:]
	return result.n, result.err
}

func (w *recordingWriter) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.writes...)
}

type recordingSleeper struct {
	mu        sync.Mutex
	durations []time.Duration
	started   chan time.Duration
	release   chan struct{}
}

func (s *recordingSleeper) Sleep(ctx context.Context, duration time.Duration) error {
	s.mu.Lock()
	s.durations = append(s.durations, duration)
	s.mu.Unlock()
	if s.started != nil {
		s.started <- duration
	}
	if s.release == nil {
		return nil
	}
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *recordingSleeper) snapshot() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.durations...)
}

func readyController(
	writer *recordingWriter,
	sleeper *recordingSleeper,
	manager *controlsession.Manager[string],
) *Controller {
	return NewController(Dependencies{
		Writer:      writer,
		Sleeper:     sleeper,
		Producers:   manager,
		Extension:   func() bool { return true },
		SerialReady: func() bool { return true },
	})
}

func TestExecuteUsesExactSemanticSequenceAndTiming(t *testing.T) {
	manager := controlsession.New[string]()
	snapshot := manager.PublishInitial("owner")
	writer := &recordingWriter{}
	sleeper := &recordingSleeper{}
	controller := readyController(writer, sleeper, manager)

	receipt := controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)

	if receipt.Outcome != OutcomeApplied || !receipt.ON.Completed || !receipt.HoldCompleted || !receipt.OFF.Completed || !receipt.SerialSequenceCompleted {
		t.Fatalf("incomplete receipt: %+v", receipt)
	}
	if receipt.AcknowledgedAt.IsZero() {
		t.Fatal("definitive receipt omitted acknowledgement time")
	}
	if got := writer.snapshot(); len(got) != 3 || got[0] != "\n" || got[1] != "BTN_PWR_ON\n" || got[2] != "BTN_PWR_OFF\n" {
		t.Fatalf("unexpected writes: %#v", got)
	}
	if got := sleeper.snapshot(); len(got) != 1 || got[0] != 200*time.Millisecond {
		t.Fatalf("unexpected sleeps: %#v", got)
	}
	duplicate := controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)
	if duplicate.Outcome != OutcomeAlreadyApplied || !duplicate.Replayed || !duplicate.AcknowledgedAt.Equal(receipt.AcknowledgedAt) || len(writer.snapshot()) != 3 {
		t.Fatalf("duplicate was not a byte-free stable replay: %+v", duplicate)
	}
}

func TestExecuteSerializesAcrossTheWholeOnHoldOffSequence(t *testing.T) {
	manager := controlsession.New[string]()
	snapshot := manager.PublishInitial("owner")
	writer := &recordingWriter{}
	sleeper := &recordingSleeper{
		started: make(chan time.Duration, 2),
		release: make(chan struct{}, 2),
	}
	controller := readyController(writer, sleeper, manager)
	firstDone := make(chan Receipt, 1)
	secondDone := make(chan Receipt, 1)

	go func() {
		firstDone <- controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)
	}()
	<-sleeper.started
	go func() {
		secondDone <- controller.Execute(context.Background(), snapshot.Generation, "request-2", ActionPressReset)
	}()
	time.Sleep(10 * time.Millisecond)
	if got := writer.snapshot(); len(got) != 2 {
		t.Fatalf("second request wrote before first OFF: %#v", got)
	}
	sleeper.release <- struct{}{}
	if receipt := <-firstDone; receipt.Outcome != OutcomeApplied {
		t.Fatalf("first receipt: %+v", receipt)
	}
	<-sleeper.started
	sleeper.release <- struct{}{}
	if receipt := <-secondDone; receipt.Outcome != OutcomeApplied {
		t.Fatalf("second receipt: %+v", receipt)
	}
	if got := writer.snapshot(); len(got) != 6 || got[2] != "BTN_PWR_OFF\n" || got[3] != "\n" {
		t.Fatalf("sequences interleaved: %#v", got)
	}
}

func TestExecuteNeverRepeatsOnAndAttemptsOffCleanupAfterOffFailure(t *testing.T) {
	manager := controlsession.New[string]()
	snapshot := manager.PublishInitial("owner")
	writer := &recordingWriter{results: []writeResult{
		{n: 1},
		{n: len("BTN_PWR_ON\n")},
		{n: 0, err: errors.New("off failed")},
		{n: len("BTN_PWR_OFF\n")},
	}}
	controller := readyController(writer, &recordingSleeper{}, manager)

	receipt := controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)

	if receipt.Outcome != OutcomeUnknown || receipt.ErrorPhase != PhaseOFF || !receipt.Cleanup.Attempted || !receipt.Cleanup.Completed {
		t.Fatalf("unexpected receipt: %+v", receipt)
	}
	if got := writer.snapshot(); len(got) != 4 || got[1] != "BTN_PWR_ON\n" || got[2] != "BTN_PWR_OFF\n" || got[3] != "BTN_PWR_OFF\n" {
		t.Fatalf("unexpected cleanup writes: %#v", got)
	}
	duplicate := controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)
	if duplicate.Outcome != OutcomeUnknown || !duplicate.Replayed || len(writer.snapshot()) != 4 {
		t.Fatalf("unknown terminal was replayed physically: %+v writes=%#v", duplicate, writer.snapshot())
	}
}

func TestExecuteRejectsInactiveUnreadyStaleAndConflictingRequestsBeforeWrites(t *testing.T) {
	manager := controlsession.New[string]()
	snapshot := manager.PublishInitial("owner")
	writer := &recordingWriter{}
	controller := NewController(Dependencies{
		Writer:      writer,
		Sleeper:     &recordingSleeper{},
		Producers:   manager,
		Extension:   func() bool { return false },
		SerialReady: func() bool { return false },
	})

	inactive := controller.Execute(context.Background(), snapshot.Generation, "request-1", ActionPressPower)
	if inactive.Outcome != OutcomeNotSent || inactive.ErrorPhase != PhaseAdmission || inactive.ErrorCode != ErrorExtensionInactive {
		t.Fatalf("inactive receipt: %+v", inactive)
	}
	stale := controller.Execute(context.Background(), snapshot.Generation+1, "request-2", ActionPressPower)
	if stale.Outcome != OutcomeNotSent || stale.ErrorCode != ErrorGenerationStale {
		t.Fatalf("stale receipt: %+v", stale)
	}
	if len(writer.snapshot()) != 0 {
		t.Fatalf("admission failure wrote: %#v", writer.snapshot())
	}
}
