// internal/usbgadget/write_health.go
package usbgadget

import (
	"errors"
	"syscall"
	"time"
)

type writeRecord struct {
	at  time.Time
	err error // nil = success
}

// writeHealthWindow is the sliding window duration for write health tracking.
const writeHealthWindow = 5 * time.Second

// writeHealthMinSamples is the minimum number of write attempts in the window
// before the heuristic applies.
const writeHealthMinSamples = 3

// writeHealthThreshold is the fraction of disconnect-like errors that triggers override.
// Must be exceeded (strictly greater than), not just met.
const writeHealthThreshold = 0.80

// isDisconnectWriteErr returns true if err (possibly wrapped) is a syscall error
// that indicates the USB host has disconnected.
func isDisconnectWriteErr(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.EIO) ||
		errors.Is(err, syscall.ENODEV) ||
		errors.Is(err, syscall.ESHUTDOWN) ||
		errors.Is(err, syscall.EPIPE)
}

func (u *UsbGadget) writeHealthNow() time.Time {
	if u.writeHealthClock != nil {
		return u.writeHealthClock()
	}
	return time.Now()
}

// pruneWriteWindow removes records older than writeHealthWindow.
// Caller must hold writeHealthLock.
func (u *UsbGadget) pruneWriteWindow() {
	cutoff := u.writeHealthNow().Add(-writeHealthWindow)
	i := 0
	for i < len(u.writeWindow) && u.writeWindow[i].at.Before(cutoff) {
		i++
	}
	u.writeWindow = u.writeWindow[i:]
}

// RecordWriteResult records the outcome of an HID write for health tracking.
func (u *UsbGadget) RecordWriteResult(err error) {
	u.writeHealthLock.Lock()
	defer u.writeHealthLock.Unlock()

	now := u.writeHealthNow()
	u.writeWindow = append(u.writeWindow, writeRecord{at: now, err: err})
	u.pruneWriteWindow()

	if err == nil {
		u.hasEverWritten = true
		u.overrideActive = false
	}
}

// WriteHealthSnapshot holds a point-in-time view of write health state.
type WriteHealthSnapshot struct {
	WindowSize       int
	DisconnectErrors int
	ErrorRate        float64
	HasEverWritten   bool
	OverrideActive   bool
	ThresholdMet     bool
}

// GetWriteHealth returns a snapshot of the current write health state.
func (u *UsbGadget) GetWriteHealth() WriteHealthSnapshot {
	u.writeHealthLock.Lock()
	defer u.writeHealthLock.Unlock()

	u.pruneWriteWindow()

	snap := WriteHealthSnapshot{
		WindowSize:     len(u.writeWindow),
		HasEverWritten: u.hasEverWritten,
		OverrideActive: u.overrideActive,
	}

	if snap.WindowSize == 0 {
		return snap
	}

	for _, rec := range u.writeWindow {
		if isDisconnectWriteErr(rec.err) {
			snap.DisconnectErrors++
		}
	}
	snap.ErrorRate = float64(snap.DisconnectErrors) / float64(snap.WindowSize)
	snap.ThresholdMet = snap.HasEverWritten &&
		snap.WindowSize >= writeHealthMinSamples &&
		snap.ErrorRate > writeHealthThreshold

	return snap
}

// IsWritePathUnhealthy returns true when the write-failure threshold is met,
// regardless of whether an override is currently active. Useful for diagnostics.
func (u *UsbGadget) IsWritePathUnhealthy() bool {
	return u.GetWriteHealth().ThresholdMet
}

// SetOverrideActive marks the write-health override as latched.
// Called by the USB monitor when it derives effectiveState = "not attached".
func (u *UsbGadget) SetOverrideActive() {
	u.writeHealthLock.Lock()
	defer u.writeHealthLock.Unlock()
	u.overrideActive = true
}

// ClearWriteHealth resets the write window and override.
// Called when raw sysfs state changes to prevent stale data from contaminating new state.
func (u *UsbGadget) ClearWriteHealth() {
	u.writeHealthLock.Lock()
	defer u.writeHealthLock.Unlock()
	u.writeWindow = nil
	u.overrideActive = false
}

// NewTestGadget creates a minimal UsbGadget for testing write health.
// Only the write health fields and clock are initialized.
func NewTestGadget(clock func() time.Time) *UsbGadget {
	return &UsbGadget{
		writeHealthClock: clock,
	}
}
