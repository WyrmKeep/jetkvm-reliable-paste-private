# USB Disconnect Status Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect USB cable disconnection on self-powered JetKVM hardware where sysfs alone may not report the change, and surface the correct status on both web UI and physical display.

**Architecture:** Replace the package-level USB state polling with a `usbMonitor` struct that combines sysfs reads with HID write-failure evidence to derive an `effectiveState`. Only `raw == "configured"` plus strong write-failure evidence produces `"not attached"`. Ordered channel-based delivery replaces fire-and-forget goroutines. Frontend adds `"unknown"` state handling.

**Tech Stack:** Go (backend), React/TypeScript (frontend), zustand (state), zerolog (logging)

**Spec:** `docs/superpowers/specs/2026-04-09-usb-status-disconnect-design.md`

---

### Task 1: Write health tracking in usbgadget package

**Files:**
- Modify: `internal/usbgadget/usbgadget.go:51-98` (add fields to UsbGadget struct)
- Create: `internal/usbgadget/write_health.go` (new file for write health logic)
- Create: `internal/usbgadget/write_health_test.go`

- [ ] **Step 1: Create `write_health.go` with types and `isDisconnectWriteErr`**

```go
// internal/usbgadget/write_health.go
package usbgadget

import (
	"errors"
	"syscall"
	"time"

	"github.com/jetkvm/kvm/internal/sync"
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
```

- [ ] **Step 2: Add write health fields to UsbGadget struct**

In `internal/usbgadget/usbgadget.go`, add these fields to the `UsbGadget` struct after `lastUserInput time.Time` (line 85):

```go
	writeHealthLock   sync.Mutex
	writeWindow       []writeRecord
	hasEverWritten    bool
	overrideActive    bool
	writeHealthClock  func() time.Time // injectable for tests; nil uses time.Now
```

- [ ] **Step 3: Add `RecordWriteResult`, `GetWriteHealth`, `IsWritePathUnhealthy`, and `ClearWriteHealth` methods**

Append to `internal/usbgadget/write_health.go`:

```go
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
	WindowSize      int
	DisconnectErrors int
	ErrorRate       float64
	HasEverWritten  bool
	OverrideActive  bool
	ThresholdMet    bool
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
```

- [ ] **Step 4: Write tests for write health**

```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd internal/usbgadget && go test -run TestWriteHealth -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add internal/usbgadget/write_health.go internal/usbgadget/write_health_test.go internal/usbgadget/usbgadget.go
git commit -m "feat(usb): add write health tracking to usbgadget

Sliding window of HID write outcomes for disconnect detection heuristic.
Only syscall.EIO/ENODEV/ESHUTDOWN/EPIPE count as disconnect-like errors.
Threshold requires prior successful write and >80% error rate in 5s window."
```

---

### Task 2: Instrument HID write functions with RecordWriteResult

**Files:**
- Modify: `internal/usbgadget/hid_keyboard.go:365-382` (KeyboardReport)
- Modify: `internal/usbgadget/hid_keyboard.go:493-509` (KeypressReport)
- Modify: `internal/usbgadget/hid_mouse_absolute.go:88-106` (AbsMouseReport)
- Modify: `internal/usbgadget/hid_mouse_absolute.go:108-124` (AbsMouseWheelReport)
- Modify: `internal/usbgadget/hid_mouse_relative.go:78-94` (RelMouseReport)

- [ ] **Step 1: Add RecordWriteResult to KeyboardReport**

In `internal/usbgadget/hid_keyboard.go`, modify `KeyboardReport` (line 365):

```go
func (u *UsbGadget) KeyboardReport(modifier byte, keys []byte) error {
	defer u.resetUserInputTime()

	if len(keys) > hidKeyBufferSize {
		keys = keys[:hidKeyBufferSize]
	}
	if len(keys) < hidKeyBufferSize {
		keys = append(keys, make([]byte, hidKeyBufferSize-len(keys))...)
	}

	err := u.keyboardWriteHidFile(modifier, keys)
	u.RecordWriteResult(err)
	if err != nil {
		u.log.Warn().Uint8("modifier", modifier).Uints8("keys", keys).Msg("Could not write keyboard report to hidg0")
	}

	u.UpdateKeysDown(modifier, keys)
	return err
}
```

- [ ] **Step 2: Add RecordWriteResult to keypressReport (internal)**

In `internal/usbgadget/hid_keyboard.go`, modify `keypressReport` (line 489):

```go
	err := u.keyboardWriteHidFile(modifier, keys)
	u.RecordWriteResult(err)
	return u.UpdateKeysDown(modifier, keys), err
```

- [ ] **Step 3: Add RecordWriteResult to AbsMouseReport**

In `internal/usbgadget/hid_mouse_absolute.go`, modify `AbsMouseReport` (line 88):

```go
func (u *UsbGadget) AbsMouseReport(x int, y int, buttons uint8) error {
	u.absMouseLock.Lock()
	defer u.absMouseLock.Unlock()

	err := u.absMouseWriteHidFile([]byte{
		1,            // Report ID 1
		buttons,      // Buttons
		byte(x),      // X Low Byte
		byte(x >> 8), // X High Byte
		byte(y),      // Y Low Byte
		byte(y >> 8), // Y High Byte
	})
	u.RecordWriteResult(err)
	if err != nil {
		return err
	}

	u.resetUserInputTime()
	return nil
}
```

- [ ] **Step 4: Add RecordWriteResult to AbsMouseWheelReport**

In `internal/usbgadget/hid_mouse_absolute.go`, modify `AbsMouseWheelReport` (line 108):

```go
func (u *UsbGadget) AbsMouseWheelReport(wheelY int8) error {
	u.absMouseLock.Lock()
	defer u.absMouseLock.Unlock()

	// Only send a report if the value is non-zero
	if wheelY == 0 {
		return nil
	}

	err := u.absMouseWriteHidFile([]byte{
		2,            // Report ID 2
		byte(wheelY), // Wheel Y (signed)
	})
	u.RecordWriteResult(err)

	u.resetUserInputTime()
	return err
}
```

- [ ] **Step 5: Add RecordWriteResult to RelMouseReport**

In `internal/usbgadget/hid_mouse_relative.go`, modify `RelMouseReport` (line 78):

```go
func (u *UsbGadget) RelMouseReport(mx int8, my int8, buttons uint8) error {
	u.relMouseLock.Lock()
	defer u.relMouseLock.Unlock()

	err := u.relMouseWriteHidFile([]byte{
		buttons,  // Buttons
		byte(mx), // X
		byte(my), // Y
		0,        // Wheel
	})
	u.RecordWriteResult(err)
	if err != nil {
		return err
	}

	u.resetUserInputTime()
	return nil
}
```

- [ ] **Step 6: Verify the package compiles**

Run: `cd internal/usbgadget && go build ./...`
Expected: Clean build, no errors

- [ ] **Step 7: Commit**

```bash
git add internal/usbgadget/hid_keyboard.go internal/usbgadget/hid_mouse_absolute.go internal/usbgadget/hid_mouse_relative.go
git commit -m "feat(usb): instrument HID writes with RecordWriteResult

Every keyboard, mouse, and wheel write now records its outcome in the
write health sliding window for disconnect detection."
```

---

### Task 3: Create USB monitor with state derivation and ordered delivery

**Files:**
- Create: `usb_monitor.go` (new file for usbMonitor struct)
- Create: `usb_monitor_test.go` (tests for the state machine)

- [ ] **Step 1: Write the failing test scaffold**

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -run TestMonitor -v`
Expected: FAIL — `usbMonitor` type not defined

- [ ] **Step 3: Write the usbMonitor implementation**

```go
// usb_monitor.go
package kvm

import (
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"

	"github.com/rs/zerolog"
)

type stateUpdate struct {
	raw       string
	effective string
	reason    string
}

type usbMonitor struct {
	gadget    *usbgadget.UsbGadget
	clock     func() time.Time
	readState func() string
	logger    *zerolog.Logger

	rawState       string
	effectiveState string

	stateCh chan stateUpdate
}

func newUsbMonitor(
	gadget *usbgadget.UsbGadget,
	clock func() time.Time,
	readState func() string,
	logger *zerolog.Logger,
) *usbMonitor {
	if clock == nil {
		clock = time.Now
	}
	return &usbMonitor{
		gadget:         gadget,
		clock:          clock,
		readState:      readState,
		logger:         logger,
		rawState:       "",
		effectiveState: "",
		stateCh:        make(chan stateUpdate, 8),
	}
}

// EffectiveState returns the current effective USB state.
func (m *usbMonitor) EffectiveState() string {
	return m.effectiveState
}

// RawState returns the current raw sysfs USB state.
func (m *usbMonitor) RawState() string {
	return m.rawState
}

// RecordWriteResult delegates to the gadget's write health tracking.
func (m *usbMonitor) RecordWriteResult(err error) {
	if m.gadget != nil {
		m.gadget.RecordWriteResult(err)
	}
}

// tick performs one poll cycle: read sysfs, derive effective state, publish changes.
func (m *usbMonitor) tick() {
	newRaw := m.readState()
	oldRaw := m.rawState
	oldEffective := m.effectiveState

	// Step 2: If raw changed, clear override and write window
	if newRaw != oldRaw && oldRaw != "" {
		if m.gadget != nil {
			m.gadget.ClearWriteHealth()
		}
	}
	m.rawState = newRaw

	// Step 3: Derive effective state
	effective := m.deriveEffective(newRaw)
	m.effectiveState = effective

	// Step 4: Publish if effective changed
	if effective != oldEffective {
		reason := "sysfs"
		if effective != newRaw {
			reason = "write_failure"
		}

		if m.logger != nil {
			var snap usbgadget.WriteHealthSnapshot
			if m.gadget != nil {
				snap = m.gadget.GetWriteHealth()
			}
			m.logger.Info().
				Str("raw_state", newRaw).
				Str("effective_state", effective).
				Str("from_effective", oldEffective).
				Bool("override_active", snap.OverrideActive).
				Str("override_reason", reason).
				Int("write_window_size", snap.WindowSize).
				Float64("write_error_rate", snap.ErrorRate).
				Bool("has_ever_written", snap.HasEverWritten).
				Bool("write_path_unhealthy", snap.ThresholdMet).
				Msg("USB state changed")
		}

		// Non-blocking send; if channel is full, log and skip
		select {
		case m.stateCh <- stateUpdate{raw: newRaw, effective: effective, reason: reason}:
		default:
			if m.logger != nil {
				m.logger.Warn().Msg("USB state update channel full, dropping update")
			}
		}
	}
}

// deriveEffective applies the override rules from the spec.
func (m *usbMonitor) deriveEffective(raw string) string {
	switch raw {
	case "configured":
		if m.gadget != nil {
			snap := m.gadget.GetWriteHealth()
			if snap.OverrideActive {
				return "not attached"
			}
			if snap.ThresholdMet {
				m.gadget.SetOverrideActive()
				return "not attached"
			}
		}
		return "configured"
	case "suspended":
		return "suspended" // never promote
	default:
		return raw
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -run TestMonitor -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add usb_monitor.go usb_monitor_test.go
git commit -m "feat(usb): add usbMonitor state machine with ordered delivery

Derives effectiveState from raw sysfs + write health evidence.
Only configured + strong write failures produces not attached.
Suspended always passes through. Channel-based ordered delivery."
```

---

### Task 4: Replace package-level USB state with usbMonitor

**Files:**
- Modify: `usb.go` (replace usbState/usbStateLock, update initUsbGadget, checkUSBState, triggerUSBStateUpdate, rpcGetUSBState)
- Modify: `display.go:43-50` (update updateDisplayUsbState to use monitor)
- Modify: `webrtc.go:361` (update OnOpen handler)

- [ ] **Step 1: Rewrite `usb.go` to use usbMonitor**

Replace the entire state management section of `usb.go`. The new file:

```go
package kvm

import (
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"
)

var gadget *usbgadget.UsbGadget
var usbMonitorInstance *usbMonitor

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
		if currentSession != nil {
			currentSession.reportHidRPCKeyboardLedState(state)
		}
	})

	gadget.SetOnKeysDownChange(func(state usbgadget.KeysDownState) {
		if currentSession != nil {
			currentSession.enqueueKeysDownState(state)
		}
	})

	gadget.SetOnKeepAliveReset(func() {
		if currentSession != nil {
			currentSession.resetKeepAliveTime()
		}
	})

	// open the keyboard hid file to listen for keyboard events
	if err := gadget.OpenKeyboardHidFile(); err != nil {
		usbLogger.Error().Err(err).Msg("failed to open keyboard hid file")
	}
}

func rpcKeyboardReport(modifier byte, keys []byte) error {
	return gadget.KeyboardReport(modifier, keys)
}

func rpcKeypressReport(key byte, press bool) error {
	return gadget.KeypressReport(key, press)
}

func rpcAbsMouseReport(x int, y int, buttons uint8) error {
	return gadget.AbsMouseReport(x, y, buttons)
}

func rpcRelMouseReport(dx int8, dy int8, buttons uint8) error {
	return gadget.RelMouseReport(dx, dy, buttons)
}

func rpcWheelReport(wheelY int8) error {
	return gadget.AbsMouseWheelReport(wheelY)
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
		if currentSession != nil {
			writeJSONRPCEvent("usbState", update.effective, currentSession)
		}
	}
}
```

- [ ] **Step 2: Update `display.go` to read from monitor**

In `display.go`, modify `updateDisplayUsbState()` (line 43):

```go
func updateDisplayUsbState() {
	state := "unknown"
	if usbMonitorInstance != nil {
		state = usbMonitorInstance.EffectiveState()
	}
	if state == "configured" {
		nativeInstance.UpdateLabelIfChanged("usb_status_label", "Connected")
		_, _ = nativeInstance.UIObjAddState("usb_status_label", "LV_STATE_CHECKED")
	} else {
		nativeInstance.UpdateLabelIfChanged("usb_status_label", "Disconnected")
		_, _ = nativeInstance.UIObjClearState("usb_status_label", "LV_STATE_CHECKED")
	}
}
```

- [ ] **Step 3: Verify webrtc.go OnOpen handler still works**

The existing `webrtc.go:361` calls `triggerUSBStateUpdate()` which now pushes through the monitor's channel. No code change needed — just verify the call chain is correct.

Read `webrtc.go:358-363` to confirm `triggerUSBStateUpdate()` is still called in `d.OnOpen()`.

- [ ] **Step 4: Verify the project compiles**

Run: `go build ./...` (in WSL if needed for Linux-specific deps, or `GOOS=linux go build ./...`)
Expected: Clean build

- [ ] **Step 5: Run existing tests**

Run: `go test ./...`
Expected: All tests pass (including new monitor tests)

- [ ] **Step 6: Commit**

```bash
git add usb.go display.go
git commit -m "refactor(usb): replace package-level state with usbMonitor

Encapsulates raw/effective state, ordered channel delivery, and
write-health heuristic. Fixes log bug (old state captured before
overwrite). rpcGetUSBState now returns effectiveState."
```

---

### Task 5: Frontend — Add unknown state to USBStates type and component

**Files:**
- Modify: `ui/src/hooks/stores.ts:489` (add "unknown" to USBStates)
- Modify: `ui/src/components/USBStateStatus.tsx` (add unknown mapping)

- [ ] **Step 1: Add "unknown" to USBStates type**

In `ui/src/hooks/stores.ts`, line 489, change:

```ts
export type USBStates = "configured" | "attached" | "not attached" | "suspended" | "addressed";
```

to:

```ts
export type USBStates = "configured" | "attached" | "not attached" | "suspended" | "addressed" | "unknown";
```

- [ ] **Step 2: Add "unknown" to USBStateMap**

In `ui/src/components/USBStateStatus.tsx`, add to `USBStateMap` (after the `suspended` entry on line 24):

```ts
const USBStateMap: Record<USBStates, string> = {
  configured: m.usb_state_connected(),
  attached: m.usb_state_connecting(),
  addressed: m.usb_state_connecting(),
  "not attached": m.usb_state_disconnected(),
  suspended: m.usb_state_low_power_mode(),
  unknown: m.usb_state_connecting(),
};
```

- [ ] **Step 3: Add "unknown" to StatusCardProps**

In `ui/src/components/USBStateStatus.tsx`, add to `StatusCardProps` (after the `suspended` entry):

```ts
  unknown: {
    icon: ({ className }) => <LoadingSpinner className={cx(className)} />,
    iconClassName: "h-5 w-5 text-slate-400",
    statusIndicatorClassName: "bg-slate-300 border-slate-400",
  },
```

- [ ] **Step 4: Verify frontend builds**

Run: `cd ui && npm run build`
Expected: Clean build, no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/stores.ts ui/src/components/USBStateStatus.tsx
git commit -m "feat(ui): add unknown USB state to frontend

Handles the backend returning 'unknown' during startup or sysfs
read errors. Shows a loading spinner with gray status indicator."
```

---

### Task 6: Add localization key for unknown state

**Files:**
- Check: `ui/src/localizations/messages.js` or equivalent localization file for `usb_state_*` keys

- [ ] **Step 1: Find the localization file**

Run: `grep -r "usb_state_connected\|usb_state_connecting\|usb_state_disconnected" ui/src/ --include="*.ts" --include="*.js" -l`

- [ ] **Step 2: Add `usb_state_unknown` key**

If a localization file defines `usb_state_connecting`, add a sibling `usb_state_unknown` key with value `"Unknown"`. If localization uses a function pattern (like `m.usb_state_connecting()`), follow the same pattern.

Then update `USBStateMap` in `USBStateStatus.tsx` to use `m.usb_state_unknown()` instead of `m.usb_state_connecting()` for the `unknown` entry.

- [ ] **Step 3: Verify frontend builds**

Run: `cd ui && npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add ui/src/
git commit -m "feat(ui): add localization key for unknown USB state"
```

---

### Task 7: Verification — compile and test full project

**Files:** None (verification only)

- [ ] **Step 1: Run all Go tests**

Run: `go test ./... -v`
Expected: All pass, including `TestMonitor_*` and `TestWriteHealth_*`

- [ ] **Step 2: Run frontend build**

Run: `cd ui && npm run build`
Expected: Clean build

- [ ] **Step 3: Run linter if available**

Run: `golangci-lint run ./...` (if configured)
Expected: No new warnings

- [ ] **Step 4: Verify git status is clean**

Run: `git status`
Expected: Clean working tree, all changes committed

---

### Task 8: Final review and PR preparation

**Files:** None (review only)

- [ ] **Step 1: Review all commits**

Run: `git log --oneline main..HEAD`
Verify 6 commits are present covering: write health, HID instrumentation, monitor, usb.go refactor, frontend unknown state, localization.

- [ ] **Step 2: Review diff for unintended changes**

Run: `git diff main..HEAD --stat`
Verify only the expected files are modified.

- [ ] **Step 3: Squash or organize commits if needed**

If the commit history is clean, proceed. If any fixup commits were needed during development, consider squashing related commits.
