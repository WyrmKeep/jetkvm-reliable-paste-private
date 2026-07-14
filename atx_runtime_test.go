//go:build hosttest

package kvm

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

func TestATXRuntimeSerialReadinessAndWriterAreAtomic(t *testing.T) {
	first := &bytes.Buffer{}
	second := &bytes.Buffer{}
	clearATXSerialReady(0)
	t.Cleanup(func() { clearATXSerialReady(0) })

	if isATXSerialReady() {
		t.Fatal("serial unexpectedly ready")
	}
	if accepted, err := (atxRuntimeWriter{}).Write([]byte("ON")); accepted != 0 || !errors.Is(err, errATXSerialUnavailable) {
		t.Fatalf("unready write accepted=%d err=%v", accepted, err)
	}

	firstToken := setATXSerialReady(first)
	if !isATXSerialReady() {
		t.Fatal("serial did not become ready")
	}
	secondToken := setATXSerialReady(second)
	if !isATXSerialReady() {
		t.Fatal("stale reader cleared current serial readiness")
	}
	if accepted, err := (atxRuntimeWriter{}).Write([]byte("ON")); accepted != 2 || err != nil || second.String() != "ON" {
		t.Fatalf("write accepted=%d err=%v payload=%q", accepted, err, second.String())
	}
	clearATXSerialReady(firstToken)
	if !isATXSerialReady() {
		t.Fatal("stale generation cleared current serial readiness")
	}

	clearATXSerialReady(secondToken)
	if isATXSerialReady() {
		t.Fatal("current reader did not clear readiness")
	}
}

func TestATXRuntimeCachedLEDStateHasIndependentObservationTime(t *testing.T) {
	atxRuntime.mu.Lock()
	atxRuntime.power = false
	atxRuntime.hdd = false
	atxRuntime.reset = false
	atxRuntime.powerBtn = false
	atxRuntime.observedAt = time.Time{}
	atxRuntime.mu.Unlock()

	if state := readATXCachedState(); state.Available || !state.ObservedAt.IsZero() {
		t.Fatalf("unobserved cache reported available: %+v", state)
	}
	observedAt := time.Date(2026, 7, 14, 1, 2, 3, 0, time.FixedZone("test", 3600))
	if !updateATXCachedState(true, false, true, false, observedAt) {
		t.Fatal("first observation did not report a change")
	}
	state := readATXCachedState()
	if !state.Available || !state.Power || state.HDD || !state.ObservedAt.Equal(observedAt.UTC()) {
		t.Fatalf("unexpected cache: %+v", state)
	}
	if updateATXCachedState(true, false, true, false, observedAt.Add(time.Second)) {
		t.Fatal("timestamp-only update reported a state change")
	}
	if state := readATXCachedState(); !state.ObservedAt.Equal(observedAt.Add(time.Second).UTC()) {
		t.Fatalf("timestamp was not refreshed: %+v", state)
	}
}
