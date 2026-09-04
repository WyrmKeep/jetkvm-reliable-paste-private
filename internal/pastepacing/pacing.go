// Package pastepacing runs HID phases without repaying scheduling lateness.
package pastepacing

import (
	"context"
	"fmt"
	"time"
)

// Run writes each phase and then preserves its complete delay. A successful
// write is the earliest observable device-side boundary, not a host receipt.
// Re-anchoring after every write deliberately makes configured rates upper
// bounds: a slow write or late wake must never compress the following phase.
// The final release delay is included, so a new batch cannot bypass it.
func Run(ctx context.Context, delays []time.Duration, write func(int) error) error {
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	waitUntil := func(ctx context.Context, deadline time.Time) error {
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return nil
			}
			timer.Reset(remaining)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				// Recheck the absolute deadline, including an early wake.
			}
		}
	}
	return run(ctx, delays, write, time.Now, waitUntil)
}

func run(ctx context.Context, delays []time.Duration, write func(int) error,
	now func() time.Time, waitUntil func(context.Context, time.Time) error) error {
	// Reject malformed plans before emitting any part of them.
	for _, delay := range delays {
		if delay < 0 {
			return fmt.Errorf("negative paste phase delay")
		}
	}
	for i, delay := range delays {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := write(i); err != nil {
			return err
		}
		if err := waitUntil(ctx, now().Add(delay)); err != nil {
			return err
		}
	}
	return ctx.Err()
}
