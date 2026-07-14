package kvm

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jetkvm/kvm/internal/atx"
)

var errATXSerialUnavailable = errors.New("ATX serial controller unavailable")

type atxRuntimeState struct {
	mu sync.RWMutex

	writer     io.Writer
	ready      bool
	generation uint64
	power      bool
	hdd        bool
	reset      bool
	powerBtn   bool
	observedAt time.Time
}

var atxRuntime atxRuntimeState
var legacyATXRequestCounter atomic.Uint64

type atxRuntimeWriter struct{}

func (atxRuntimeWriter) Write(payload []byte) (int, error) {
	atxRuntime.mu.RLock()
	defer atxRuntime.mu.RUnlock()
	if !atxRuntime.ready || atxRuntime.writer == nil {
		return 0, errATXSerialUnavailable
	}
	return atxRuntime.writer.Write(payload)
}

func setATXSerialReady(writer io.Writer) uint64 {
	atxRuntime.mu.Lock()
	defer atxRuntime.mu.Unlock()
	atxRuntime.generation++
	atxRuntime.writer = writer
	atxRuntime.ready = writer != nil
	return atxRuntime.generation
}

func clearATXSerialReady(generation uint64) {
	atxRuntime.mu.Lock()
	if generation == 0 || atxRuntime.generation == generation {
		atxRuntime.generation++
		atxRuntime.writer = nil
		atxRuntime.ready = false
	}
	atxRuntime.mu.Unlock()
}

func isATXSerialReady() bool {
	atxRuntime.mu.RLock()
	defer atxRuntime.mu.RUnlock()
	return atxRuntime.ready && atxRuntime.writer != nil
}

func updateATXCachedState(power, hdd, reset, powerButton bool, observedAt time.Time) bool {
	atxRuntime.mu.Lock()
	defer atxRuntime.mu.Unlock()
	changed := atxRuntime.power != power || atxRuntime.hdd != hdd || atxRuntime.reset != reset || atxRuntime.powerBtn != powerButton
	atxRuntime.power = power
	atxRuntime.hdd = hdd
	atxRuntime.reset = reset
	atxRuntime.powerBtn = powerButton
	atxRuntime.observedAt = observedAt.UTC()
	return changed
}

type atxCachedState struct {
	Power      bool
	HDD        bool
	ObservedAt time.Time
	Available  bool
}

func readATXCachedState() atxCachedState {
	atxRuntime.mu.RLock()
	defer atxRuntime.mu.RUnlock()
	return atxCachedState{
		Power:      atxRuntime.power,
		HDD:        atxRuntime.hdd,
		ObservedAt: atxRuntime.observedAt,
		Available:  !atxRuntime.observedAt.IsZero(),
	}
}

var atxActionController = atx.NewController(atx.Dependencies{
	Writer:      atxRuntimeWriter{},
	Producers:   sessionManager,
	Extension:   func() bool { return config.ActiveExtension == "atx-power" },
	SerialReady: isATXSerialReady,
})

func performATXAction(session *Session, requestID string, action atx.Action) atx.Receipt {
	if session == nil {
		return atx.Receipt{
			RequestID:  requestID,
			Action:     action,
			Outcome:    atx.OutcomeNotSent,
			ErrorCode:  atx.ErrorGenerationStale,
			ErrorPhase: atx.PhaseAdmission,
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	return atxActionController.Execute(
		ctx,
		session.managerGenerationLoad(),
		requestID,
		action,
	)
}

func nextLegacyATXRequestID() string {
	return "legacy-atx-" + formatUint(legacyATXRequestCounter.Add(1))
}

func formatUint(value uint64) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = digits[value%10]
		value /= 10
	}
	return string(buffer[index:])
}
