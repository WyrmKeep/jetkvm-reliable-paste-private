package pastepacing

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestSlowWritesAndLateWakesCannotCompressPhases(t *testing.T) {
	for _, gap := range []time.Duration{2, 20, 45} {
		for _, stall := range []time.Duration{0, 2, 10, 50, 250} {
			t.Run(fmt.Sprintf("gap%d-stall%d", gap, stall), func(t *testing.T) {
				delays := []time.Duration{5, gap, 10, gap, 5, gap}
				for i := range delays {
					delays[i] *= time.Millisecond
				}
				now := time.Unix(0, 0)
				completed := make([]time.Time, len(delays))
				starts := make([]time.Time, len(delays))
				waits := 0
				err := run(context.Background(), delays, func(i int) error {
					starts[i] = now
					if i == 0 || i == 2 {
						now = now.Add(stall * time.Millisecond)
					}
					completed[i] = now
					return nil
				}, func() time.Time { return now }, func(_ context.Context, deadline time.Time) error {
					if deadline.Sub(completed[waits]) != delays[waits] {
						t.Fatalf("phase %d lost its minimum delay", waits)
					}
					now = deadline
					if waits == 1 {
						now = now.Add(stall * time.Millisecond)
					}
					waits++
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				for i := 1; i < len(delays); i++ {
					if starts[i].Sub(completed[i-1]) < delays[i-1] {
						t.Fatalf("phase %d compressed after delay", i-1)
					}
				}
				if now.Sub(completed[len(delays)-1]) < delays[len(delays)-1] {
					t.Fatal("final release gap was skipped")
				}
			})
		}
	}
}

func TestCancellationAndWriteFailureStopTheSequence(t *testing.T) {
	for _, scenario := range []string{"before", "write", "wait"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sentinel := errors.New("write failure")
			writes, waits := 0, 0
			if scenario == "before" {
				cancel()
			}
			err := run(ctx, []time.Duration{5 * time.Millisecond, 20 * time.Millisecond}, func(int) error {
				writes++
				if scenario == "write" {
					return sentinel
				}
				return nil
			}, time.Now, func(context.Context, time.Time) error {
				waits++
				cancel()
				return ctx.Err()
			})
			want := context.Canceled
			if scenario == "write" {
				want = sentinel
			}
			if !errors.Is(err, want) {
				t.Fatalf("got %v, want %v", err, want)
			}
			if scenario == "before" && writes != 0 {
				t.Fatal("wrote after cancellation")
			}
			if writes > 1 || waits > 1 {
				t.Fatal("continued after failure")
			}
		})
	}
}

func TestNegativeDelayFailsBeforeAnyWrite(t *testing.T) {
	writes := 0
	err := Run(context.Background(), []time.Duration{0, -time.Millisecond}, func(int) error {
		writes++
		return nil
	})
	if err == nil || writes != 0 {
		t.Fatalf("err=%v writes=%d", err, writes)
	}
}

func TestRealTimerWaitIsCancellable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wrote := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, []time.Duration{time.Hour}, func(int) error { close(wrote); return nil })
	}()
	<-wrote
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation waited for the phase timer")
	}
}

func TestFinalReleaseSurvivesBatchBoundary(t *testing.T) {
	now := time.Unix(0, 0)
	lastWrite := now
	wait := func(_ context.Context, deadline time.Time) error { now = deadline; return nil }
	write := func(int) error { lastWrite = now; return nil }
	if err := run(context.Background(), []time.Duration{5 * time.Millisecond, 20 * time.Millisecond}, write, func() time.Time { return now }, wait); err != nil {
		t.Fatal(err)
	}
	if now.Sub(lastWrite) != 20*time.Millisecond {
		t.Fatal("missing final release delay")
	}
	nextStart := now
	if err := run(context.Background(), []time.Duration{5 * time.Millisecond}, write, func() time.Time { return now }, wait); err != nil {
		t.Fatal(err)
	}
	if lastWrite != nextStart {
		t.Fatal("next batch timing changed")
	}
}
