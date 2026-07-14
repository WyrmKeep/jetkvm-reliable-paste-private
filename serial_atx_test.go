//go:build hosttest

package kvm

import (
	"errors"
	"io"
	"testing"

	"go.bug.st/serial"
)

type fakeATXSerialPort struct {
	setModeErr error
}

func (*fakeATXSerialPort) Read([]byte) (int, error)          { return 0, io.EOF }
func (*fakeATXSerialPort) Write(payload []byte) (int, error) { return len(payload), nil }
func (p *fakeATXSerialPort) SetMode(*serial.Mode) error      { return p.setModeErr }

func TestMountATXControlDoesNotPublishReadyAfterModeFailure(t *testing.T) {
	clearATXSerialReady(0)
	candidate := &fakeATXSerialPort{setModeErr: errors.New("mode failed")}
	runCalled := false

	err := mountATXControlWithPort(candidate, func(atxSerialPort, uint64) { runCalled = true })

	if err == nil || isATXSerialReady() || runCalled {
		t.Fatalf("err=%v ready=%v runCalled=%v", err, isATXSerialReady(), runCalled)
	}
}

func TestMountATXControlPublishesReadyOnlyAfterModeSucceeds(t *testing.T) {
	clearATXSerialReady(0)
	t.Cleanup(func() { clearATXSerialReady(0) })
	candidate := &fakeATXSerialPort{}
	runStarted := make(chan struct{}, 1)

	err := mountATXControlWithPort(candidate, func(atxSerialPort, uint64) { runStarted <- struct{}{} })

	if err != nil || !isATXSerialReady() {
		t.Fatalf("err=%v ready=%v", err, isATXSerialReady())
	}
	<-runStarted
}
