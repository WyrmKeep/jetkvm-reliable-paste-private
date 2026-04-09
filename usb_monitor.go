// usb_monitor.go
package kvm

import (
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"

	"github.com/rs/zerolog"

	stdsync "sync"
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

	mu             stdsync.Mutex
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
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.effectiveState
}

// RawState returns the current raw sysfs USB state.
func (m *usbMonitor) RawState() string {
	m.mu.Lock()
	defer m.mu.Unlock()
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

	m.mu.Lock()
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
	m.mu.Unlock()

	// Step 4: Publish if effective changed (outside lock to avoid blocking on channel)
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
