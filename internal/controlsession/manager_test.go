package controlsession

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testSession struct{ name string }

func TestGenerationIsMonotonicAcrossTakeoverAndClose(t *testing.T) {
	m := New[*testSession]()
	first := m.PublishInitial(&testSession{name: "first"})
	if first.Generation != 1 || !first.HasCurrent {
		t.Fatalf("first snapshot = %+v", first)
	}

	second, receipt := m.Takeover(context.Background(), &testSession{name: "second"}, "takeover-1", successfulZero)
	if receipt.Outcome != OutcomeReleased || second.Generation != 2 || second.Current.name != "second" {
		t.Fatalf("takeover snapshot=%+v receipt=%+v", second, receipt)
	}
	if receipt.Generation != first.Generation || receipt.OperationID != "takeover-1" {
		t.Fatalf("uncorrelated receipt: %+v", receipt)
	}

	closed := m.Close(context.Background(), second.Generation, "close-2", successfulZero)
	if closed.Outcome != OutcomeReleased || m.Snapshot().HasCurrent {
		t.Fatalf("close receipt=%+v snapshot=%+v", closed, m.Snapshot())
	}
	third := m.PublishInitial(&testSession{name: "third"})
	if third.Generation != 3 {
		t.Fatalf("generation reused after close: %+v", third)
	}
}

func TestOrdinaryLeaseAcquiresOnlyForCurrentOpenGeneration(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	lease, ok := m.Acquire(s.Generation)
	if !ok || !lease.Valid() || m.OrdinaryCount() != 1 {
		t.Fatalf("lease=%+v ok=%v count=%d", lease, ok, m.OrdinaryCount())
	}
	lease.Release()
	lease.Release()
	if m.OrdinaryCount() != 0 {
		t.Fatalf("release was not idempotent: %d", m.OrdinaryCount())
	}
	if _, ok := m.Acquire(s.Generation + 1); ok {
		t.Fatal("future generation acquired")
	}
}

func TestQuiesceDrainsWorkersAndRejectsBlockedQueuedAndNewWork(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	worker, ok := m.StartProducer(s.Generation, ProducerMacro)
	if !ok {
		t.Fatal("producer not registered")
	}
	lease, ok := m.Acquire(s.Generation)
	if !ok {
		t.Fatal("ordinary lease not acquired")
	}

	zeroStarted := make(chan struct{})
	done := make(chan Receipt, 1)
	go func() {
		done <- m.QuiesceAndZero(context.Background(), s.Generation, "release", func(maintenance MaintenanceLease) (error, error) {
			if !maintenance.Valid() {
				t.Error("manager supplied invalid maintenance lease")
			}
			close(zeroStarted)
			return nil, nil
		})
	}()

	select {
	case <-worker.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("producer was not cancelled")
	}
	if _, ok := m.Acquire(s.Generation); ok {
		t.Fatal("draining generation accepted a new ordinary lease")
	}
	if _, ok := m.StartProducer(s.Generation, ProducerPaste); ok {
		t.Fatal("draining generation accepted a queued producer")
	}
	select {
	case <-zeroStarted:
		t.Fatal("maintenance ran before producer join and ordinary-zero")
	default:
	}
	worker.Done()
	lease.Release()

	receipt := <-done
	if !receipt.Draining || !receipt.ProducersJoined || !receipt.MacroInactive || !receipt.PasteInactive || !receipt.OrdinaryLeasesZero || !receipt.KeyboardZero || !receipt.PointerZero {
		t.Fatalf("incomplete receipt: %+v", receipt)
	}
}

func TestMaintenanceHandlerIsNotAProducerItJoins(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	called := false
	receipt := m.QuiesceAndZero(ctx, s.Generation, "release", func(maintenance MaintenanceLease) (error, error) {
		called = true
		return nil, nil
	})
	if !called || receipt.Outcome != OutcomeReleased || !receipt.ProducersJoined {
		t.Fatalf("maintenance self-joined or failed: called=%v receipt=%+v", called, receipt)
	}
}

func TestStaleAndMissingGenerationNeverWrite(t *testing.T) {
	m := New[*testSession]()
	first := m.PublishInitial(&testSession{name: "one"})
	second, _ := m.Takeover(context.Background(), &testSession{name: "two"}, "takeover", successfulZero)
	var writes atomic.Int32
	for _, generation := range []Generation{0, first.Generation, second.Generation + 1} {
		receipt := m.QuiesceAndZero(context.Background(), generation, "stale", func(MaintenanceLease) (error, error) {
			writes.Add(1)
			return nil, nil
		})
		if receipt.Outcome != OutcomeStale || receipt.KeyboardZero || receipt.PointerZero {
			t.Fatalf("generation %d receipt=%+v", generation, receipt)
		}
	}
	if writes.Load() != 0 {
		t.Fatalf("stale quiesce wrote %d times", writes.Load())
	}
}

func TestTimeoutReturnsUnknownAndLeavesGenerationDrained(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	worker, _ := m.StartProducer(s.Generation, ProducerPaste)
	ctx, cancel := context.WithDeadline(context.Background(), time.Unix(1, 0))
	defer cancel()
	var writes atomic.Int32
	receipt := m.QuiesceAndZero(ctx, s.Generation, "timeout", func(MaintenanceLease) (error, error) {
		writes.Add(1)
		return nil, nil
	})
	if receipt.Outcome != OutcomeUnknown || !receipt.Draining || receipt.ProducersJoined || writes.Load() != 0 {
		t.Fatalf("timeout receipt=%+v writes=%d", receipt, writes.Load())
	}
	if _, ok := m.Acquire(s.Generation); ok {
		t.Fatal("timed-out drained generation reopened")
	}
	worker.Done()
}

func TestExpiredContextWithoutProducersNeverRunsMaintenance(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	ctx, cancel := context.WithDeadline(context.Background(), time.Unix(1, 0))
	defer cancel()
	var writes atomic.Int32

	receipt := m.QuiesceAndZero(ctx, s.Generation, "expired", func(MaintenanceLease) (error, error) {
		writes.Add(1)
		return nil, nil
	})

	if receipt.Outcome != OutcomeUnknown || !receipt.Draining || !receipt.ProducersJoined || !receipt.OrdinaryLeasesZero {
		t.Fatalf("expired receipt=%+v", receipt)
	}
	if receipt.KeyboardZero || receipt.PointerZero || writes.Load() != 0 {
		t.Fatalf("expired context wrote: receipt=%+v writes=%d", receipt, writes.Load())
	}
}

func TestContextCancellationDuringMaintenanceNeverReclaims(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	ctx, cancel := context.WithCancel(context.Background())
	receipt := m.QuiesceAndZero(ctx, s.Generation, "cancel-during-zero", func(MaintenanceLease) (error, error) {
		cancel()
		return nil, nil
	})

	if receipt.Outcome != OutcomeUnknown || !receipt.KeyboardZero || !receipt.PointerZero {
		t.Fatalf("cancelled maintenance receipt=%+v", receipt)
	}
	if _, ok := m.Acquire(s.Generation); ok {
		t.Fatal("context cancellation during maintenance reopened generation")
	}
}

func TestNoPostZeroWrites(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	var zeroed atomic.Bool
	receipt := m.QuiesceAndZero(context.Background(), s.Generation, "release", func(MaintenanceLease) (error, error) {
		zeroed.Store(true)
		return nil, nil
	})
	if receipt.Outcome != OutcomeReleased || !zeroed.Load() {
		t.Fatalf("receipt=%+v zeroed=%v", receipt, zeroed.Load())
	}
	if _, ok := m.Acquire(s.Generation); ok {
		t.Fatal("post-zero ordinary write lease acquired")
	}
}

func TestMaintenanceLeaseExpiresWhenZeroCallbackReturns(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	var captured MaintenanceLease
	receipt := m.QuiesceAndZero(context.Background(), s.Generation, "release", func(maintenance MaintenanceLease) (error, error) {
		captured = maintenance
		if !maintenance.Valid() {
			t.Fatal("maintenance lease was invalid inside zero callback")
		}
		return nil, nil
	})
	if receipt.Outcome != OutcomeReleased {
		t.Fatalf("receipt=%+v", receipt)
	}
	if captured.Valid() {
		t.Fatal("maintenance lease remained valid after zero callback")
	}
}

func TestMissingZeroAcknowledgementReturnsUnknownAndKeepsDrained(t *testing.T) {
	m := New[*testSession]()
	s := m.PublishInitial(&testSession{name: "one"})
	missingAck := errors.New("zero acknowledgement missing")
	receipt := m.QuiesceAndZero(context.Background(), s.Generation, "missing-ack", func(MaintenanceLease) (error, error) {
		return nil, missingAck
	})
	if receipt.Outcome != OutcomeUnknown || !receipt.KeyboardZero || receipt.PointerZero {
		t.Fatalf("receipt=%+v", receipt)
	}
	if _, ok := m.Acquire(s.Generation); ok {
		t.Fatal("unknown generation reopened after missing acknowledgement")
	}
}

func TestFirstTakeoverPerformsZeroBeforePublishing(t *testing.T) {
	m := New[*testSession]()
	next := &testSession{name: "first"}
	var zeroCalls atomic.Int32
	var prepared atomic.Bool

	snapshot, receipt := m.TakeoverPrepared(
		context.Background(),
		next,
		"initial",
		func(generation Generation) {
			if zeroCalls.Load() != 1 {
				t.Fatalf("prepared before zero: calls=%d", zeroCalls.Load())
			}
			if generation != 1 {
				t.Fatalf("prepared generation=%d, want 1", generation)
			}
			prepared.Store(true)
		},
		func(maintenance MaintenanceLease) (error, error) {
			if !maintenance.Valid() {
				t.Fatal("initial zero received invalid maintenance lease")
			}
			if m.Snapshot().HasCurrent {
				t.Fatal("initial session was published before zero")
			}
			zeroCalls.Add(1)
			return nil, nil
		},
	)

	if zeroCalls.Load() != 1 || !prepared.Load() {
		t.Fatalf("zeroCalls=%d prepared=%v", zeroCalls.Load(), prepared.Load())
	}
	if snapshot.Current != next || !snapshot.HasCurrent || snapshot.Generation != 1 || snapshot.Draining {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if receipt.OperationID != "initial" || receipt.Generation != snapshot.Generation ||
		receipt.Outcome != OutcomeReleased || receipt.Draining ||
		!receipt.ProducersJoined || !receipt.MacroInactive || !receipt.PasteInactive ||
		!receipt.OrdinaryLeasesZero || !receipt.KeyboardZero || !receipt.PointerZero {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestFirstTakeoverHonorsPreCanceledContextWithoutPublishing(t *testing.T) {
	m := New[*testSession]()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var zeroCalls atomic.Int32
	var prepareCalls atomic.Int32

	snapshot, receipt := m.TakeoverPrepared(
		ctx,
		&testSession{name: "never-published"},
		"canceled-initial",
		func(Generation) { prepareCalls.Add(1) },
		func(MaintenanceLease) (error, error) {
			zeroCalls.Add(1)
			return nil, nil
		},
	)

	if snapshot.HasCurrent || m.Snapshot().HasCurrent {
		t.Fatalf("canceled takeover published snapshot=%+v current=%+v", snapshot, m.Snapshot())
	}
	if zeroCalls.Load() != 0 || prepareCalls.Load() != 0 {
		t.Fatalf("zeroCalls=%d prepareCalls=%d", zeroCalls.Load(), prepareCalls.Load())
	}
	if receipt.OperationID != "canceled-initial" || receipt.Generation != 1 ||
		receipt.Outcome != OutcomeUnknown || receipt.Draining || receipt.ProducersJoined ||
		receipt.MacroInactive || receipt.PasteInactive || receipt.OrdinaryLeasesZero ||
		receipt.KeyboardZero || receipt.PointerZero {
		t.Fatalf("fabricated canceled receipt=%+v", receipt)
	}
}

func TestFirstTakeoverZeroFailureDoesNotPublishOrPrepare(t *testing.T) {
	m := New[*testSession]()
	zeroErr := errors.New("pointer zero failed")
	var prepareCalls atomic.Int32

	snapshot, receipt := m.TakeoverPrepared(
		context.Background(),
		&testSession{name: "never-published"},
		"failed-initial",
		func(Generation) { prepareCalls.Add(1) },
		func(MaintenanceLease) (error, error) { return nil, zeroErr },
	)

	if snapshot.HasCurrent || m.Snapshot().HasCurrent || prepareCalls.Load() != 0 {
		t.Fatalf("failed takeover snapshot=%+v current=%+v prepareCalls=%d", snapshot, m.Snapshot(), prepareCalls.Load())
	}
	if receipt.Outcome != OutcomeUnknown || receipt.Draining ||
		!receipt.ProducersJoined || !receipt.MacroInactive || !receipt.PasteInactive ||
		!receipt.OrdinaryLeasesZero || !receipt.KeyboardZero || receipt.PointerZero {
		t.Fatalf("failed zero receipt=%+v", receipt)
	}
}

func TestFirstTakeoverCancellationDuringZeroDoesNotPublishOrPrepare(t *testing.T) {
	m := New[*testSession]()
	ctx, cancel := context.WithCancel(context.Background())
	var prepareCalls atomic.Int32

	snapshot, receipt := m.TakeoverPrepared(
		ctx,
		&testSession{name: "never-published"},
		"cancel-during-initial-zero",
		func(Generation) { prepareCalls.Add(1) },
		func(MaintenanceLease) (error, error) {
			cancel()
			return nil, nil
		},
	)

	if snapshot.HasCurrent || m.Snapshot().HasCurrent || prepareCalls.Load() != 0 {
		t.Fatalf("canceled takeover snapshot=%+v current=%+v prepareCalls=%d", snapshot, m.Snapshot(), prepareCalls.Load())
	}
	if receipt.Outcome != OutcomeUnknown || receipt.Draining ||
		!receipt.ProducersJoined || !receipt.MacroInactive || !receipt.PasteInactive ||
		!receipt.OrdinaryLeasesZero || !receipt.KeyboardZero || !receipt.PointerZero {
		t.Fatalf("canceled zero receipt=%+v", receipt)
	}
}

func TestFirstTakeoverCancellationDuringPreparationDoesNotPublish(t *testing.T) {
	m := New[*testSession]()
	ctx, cancel := context.WithCancel(context.Background())
	var preparedGeneration Generation

	snapshot, receipt := m.TakeoverPrepared(
		ctx,
		&testSession{name: "never-published"},
		"cancel-during-preparation",
		func(generation Generation) {
			preparedGeneration = generation
			cancel()
		},
		successfulZero,
	)

	afterCanceled := m.Snapshot()
	if preparedGeneration != 1 || snapshot.HasCurrent || afterCanceled.HasCurrent || afterCanceled.Generation != preparedGeneration {
		t.Fatalf("preparedGeneration=%d snapshot=%+v current=%+v", preparedGeneration, snapshot, afterCanceled)
	}
	if receipt.Outcome != OutcomeUnknown || receipt.Draining ||
		!receipt.ProducersJoined || !receipt.OrdinaryLeasesZero ||
		!receipt.KeyboardZero || !receipt.PointerZero {
		t.Fatalf("canceled preparation receipt=%+v", receipt)
	}
	next, nextReceipt := m.Takeover(
		context.Background(),
		&testSession{name: "next"},
		"after-canceled-preparation",
		successfulZero,
	)
	if nextReceipt.Outcome != OutcomeReleased || next.Generation != 2 {
		t.Fatalf("abandoned generation was reused: snapshot=%+v receipt=%+v", next, nextReceipt)
	}
}

func TestNearSimultaneousTakeoversPublishOneGenerationAtATime(t *testing.T) {
	m := New[*testSession]()
	m.PublishInitial(&testSession{name: "initial"})
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan Snapshot[*testSession], 2)
	for _, name := range []string{"a", "b"} {
		name := name
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			snapshot, receipt := m.Takeover(context.Background(), &testSession{name: name}, "takeover-"+name, successfulZero)
			if receipt.Outcome != OutcomeReleased {
				t.Errorf("%s receipt=%+v", name, receipt)
			}
			results <- snapshot
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	seen := map[Generation]bool{}
	for snapshot := range results {
		seen[snapshot.Generation] = true
	}
	if !seen[2] || !seen[3] || m.Snapshot().Generation != 3 {
		t.Fatalf("takeover generations=%v final=%+v", seen, m.Snapshot())
	}
}

func successfulZero(MaintenanceLease) (error, error) { return nil, nil }
