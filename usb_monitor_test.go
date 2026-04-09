// usb_monitor_test.go
package kvm

import (
	"syscall"
	"testing"
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockSysfs struct {
	state string
}

func (m *mockSysfs) read() string {
	return m.state
}

// newTestMonitor creates a usbMonitor with a real (minimal) UsbGadget for write health
// tracking and injectable clock/sysfs. Uses NewTestGadget (exported test helper from usbgadget).
func newTestMonitor(sysfs *mockSysfs, clock func() time.Time) *usbMonitor {
	g := usbgadget.NewTestGadget(clock)
	return newUsbMonitor(g, clock, sysfs.read, nil)
}

// drainStateUpdates reads all pending updates from stateCh (non-blocking).
func drainStateUpdates(m *usbMonitor) []stateUpdate {
	var updates []stateUpdate
	for {
		select {
		case u := <-m.stateCh:
			updates = append(updates, u)
		default:
			return updates
		}
	}
}

func TestMonitor_StartupNotAttached(t *testing.T) {
	sysfs := &mockSysfs{state: "not attached"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()

	assert.Equal(t, "not attached", m.EffectiveState())
	updates := drainStateUpdates(m)
	require.Len(t, updates, 1)
	assert.Equal(t, "not attached", updates[0].effective)
}

func TestMonitor_NormalConfigured(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()

	assert.Equal(t, "configured", m.EffectiveState())
}

func TestMonitor_ActiveUnplugSysfsStuck(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick() // initial: configured
	drainStateUpdates(m)

	// Simulate successful write then failures
	m.RecordWriteResult(nil) // hasEverWritten = true
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EIO)
	}

	m.tick()

	assert.Equal(t, "not attached", m.EffectiveState())
	updates := drainStateUpdates(m)
	require.Len(t, updates, 1)
	assert.Equal(t, "not attached", updates[0].effective)
	assert.Equal(t, "configured", updates[0].raw)
}

func TestMonitor_ActiveUnplugSysfsUpdates(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	// Sysfs correctly reports disconnect
	sysfs.state = "not attached"
	m.tick()

	assert.Equal(t, "not attached", m.EffectiveState())
	updates := drainStateUpdates(m)
	require.Len(t, updates, 1)
	assert.Equal(t, "not attached", updates[0].effective)
	assert.Equal(t, "not attached", updates[0].raw)
}

func TestMonitor_ReconnectViaSuccessfulWrite(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	// Drive into override
	m.RecordWriteResult(nil)
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EIO)
	}
	m.tick()
	drainStateUpdates(m)
	assert.Equal(t, "not attached", m.EffectiveState())

	// Successful write clears override
	m.RecordWriteResult(nil)
	m.tick()

	assert.Equal(t, "configured", m.EffectiveState())
	updates := drainStateUpdates(m)
	require.Len(t, updates, 1)
	assert.Equal(t, "configured", updates[0].effective)
}

func TestMonitor_ReconnectViaSysfsChange(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	// Drive into override
	m.RecordWriteResult(nil)
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EIO)
	}
	m.tick()
	drainStateUpdates(m)

	// Sysfs transitions away
	sysfs.state = "not attached"
	m.tick()
	drainStateUpdates(m)

	// Sysfs comes back
	sysfs.state = "configured"
	m.tick()

	assert.Equal(t, "configured", m.EffectiveState())
}

func TestMonitor_SuspendedNeverPromoted(t *testing.T) {
	sysfs := &mockSysfs{state: "suspended"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()

	assert.Equal(t, "suspended", m.EffectiveState())
}

func TestMonitor_SuspendedWithWriteFailuresStillSuspended(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	m.RecordWriteResult(nil) // hasEverWritten

	// Transition to suspended
	sysfs.state = "suspended"
	m.tick()
	drainStateUpdates(m)

	// Failures during suspend
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EIO)
	}
	m.tick()

	assert.Equal(t, "suspended", m.EffectiveState(), "suspended must never be promoted to not attached")
}

func TestMonitor_NoEverWrittenNoOverride(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	// Failures without any prior success
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EIO)
	}
	m.tick()

	assert.Equal(t, "configured", m.EffectiveState())
}

func TestMonitor_UnknownPassthrough(t *testing.T) {
	sysfs := &mockSysfs{state: "unknown"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()

	assert.Equal(t, "unknown", m.EffectiveState())
}

func TestMonitor_TransientEagainIgnored(t *testing.T) {
	sysfs := &mockSysfs{state: "configured"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	drainStateUpdates(m)

	m.RecordWriteResult(nil)
	for i := 0; i < 5; i++ {
		m.RecordWriteResult(syscall.EAGAIN)
	}
	m.tick()

	assert.Equal(t, "configured", m.EffectiveState())
}

func TestMonitor_OrderedDelivery(t *testing.T) {
	sysfs := &mockSysfs{state: "not attached"}
	now := time.Now()
	m := newTestMonitor(sysfs, func() time.Time { return now })

	m.tick()
	sysfs.state = "configured"
	m.tick()
	sysfs.state = "suspended"
	m.tick()

	updates := drainStateUpdates(m)
	require.Len(t, updates, 3)
	assert.Equal(t, "not attached", updates[0].effective)
	assert.Equal(t, "configured", updates[1].effective)
	assert.Equal(t, "suspended", updates[2].effective)
}
