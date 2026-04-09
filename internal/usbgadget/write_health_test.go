// internal/usbgadget/write_health_test.go
package usbgadget

import (
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func newTestGadgetWithClock(clock func() time.Time) *UsbGadget {
	return NewTestGadget(clock)
}

func TestIsDisconnectWriteErr(t *testing.T) {
	assert.True(t, isDisconnectWriteErr(syscall.EIO))
	assert.True(t, isDisconnectWriteErr(syscall.ENODEV))
	assert.True(t, isDisconnectWriteErr(syscall.ESHUTDOWN))
	assert.True(t, isDisconnectWriteErr(syscall.EPIPE))
	assert.False(t, isDisconnectWriteErr(syscall.EAGAIN))
	assert.False(t, isDisconnectWriteErr(nil))
}

func TestWriteHealth_NoWritesNoThreshold(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })
	snap := g.GetWriteHealth()
	assert.False(t, snap.ThresholdMet)
	assert.Equal(t, 0, snap.WindowSize)
}

func TestWriteHealth_SuccessResetsOverride(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	// Record a success to set hasEverWritten
	g.RecordWriteResult(nil)
	assert.True(t, g.GetWriteHealth().HasEverWritten)

	// Record enough failures to meet threshold
	for i := 0; i < 5; i++ {
		g.RecordWriteResult(syscall.EIO)
	}
	g.SetOverrideActive()
	assert.True(t, g.GetWriteHealth().OverrideActive)

	// A success clears the override
	g.RecordWriteResult(nil)
	assert.False(t, g.GetWriteHealth().OverrideActive)
}

func TestWriteHealth_ThresholdRequiresHasEverWritten(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	// Record failures without any prior success
	for i := 0; i < 5; i++ {
		g.RecordWriteResult(syscall.EIO)
	}
	snap := g.GetWriteHealth()
	assert.False(t, snap.ThresholdMet, "threshold should not be met without prior success")
}

func TestWriteHealth_ThresholdMetWithHighErrorRate(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	g.RecordWriteResult(nil) // set hasEverWritten
	for i := 0; i < 4; i++ {
		g.RecordWriteResult(syscall.EIO)
	}
	snap := g.GetWriteHealth()
	// 5 total: 1 success, 4 EIO = 80% error rate, threshold is >80% so NOT met
	assert.False(t, snap.ThresholdMet)

	g.RecordWriteResult(syscall.ENODEV) // now 6 total: 1 success, 5 disconnect = 83%
	snap = g.GetWriteHealth()
	assert.True(t, snap.ThresholdMet)
}

func TestWriteHealth_NonDisconnectErrorsIgnored(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	g.RecordWriteResult(nil) // set hasEverWritten
	for i := 0; i < 5; i++ {
		g.RecordWriteResult(syscall.EAGAIN) // not a disconnect error
	}
	snap := g.GetWriteHealth()
	assert.False(t, snap.ThresholdMet, "EAGAIN should not count as disconnect")
}

func TestWriteHealth_WindowExpiry(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	g.RecordWriteResult(nil) // success at t=0

	// Failures at t=0
	for i := 0; i < 4; i++ {
		g.RecordWriteResult(syscall.EIO)
	}

	// Advance past window
	now = now.Add(writeHealthWindow + time.Second)
	snap := g.GetWriteHealth()
	assert.Equal(t, 0, snap.WindowSize, "old records should expire")
}

func TestWriteHealth_ClearResetsEverything(t *testing.T) {
	now := time.Now()
	g := newTestGadgetWithClock(func() time.Time { return now })

	g.RecordWriteResult(nil)
	g.RecordWriteResult(syscall.EIO)
	g.SetOverrideActive()

	g.ClearWriteHealth()
	snap := g.GetWriteHealth()
	assert.Equal(t, 0, snap.WindowSize)
	assert.False(t, snap.OverrideActive)
	// Note: hasEverWritten is NOT cleared by ClearWriteHealth; it persists across raw state changes
}
