package usbgadget

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestKeyboardHidReportSequenceWritesReportsAndUpdatesFinalState(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	defer reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	reports := []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, time.Millisecond),
		NewKeyboardHidReport(0, []byte{0, 0, 0, 0, 0, 0}, 0),
	}

	gotCh := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		got := make([]byte, 16)
		_, err := io.ReadFull(reader, got)
		if err != nil {
			errCh <- err
			return
		}
		gotCh <- got
	}()

	if err := g.KeyboardHidReportSequence(context.Background(), reports); err != nil {
		t.Fatalf("KeyboardHidReportSequence returned error: %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("read sequence bytes: %v", err)
	case got := <-gotCh:
		want := []byte{
			ModifierMaskLeftShift, 0, 0x04, 0, 0, 0, 0, 0,
			0, 0, 0, 0, 0, 0, 0, 0,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("sequence bytes mismatch:\n got %v\nwant %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading sequence bytes")
	}

	state := g.GetKeysDownState()
	if state.Modifier != 0 || !reflect.DeepEqual([]byte(state.Keys), []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("final keysDown state mismatch: %+v", state)
	}
}

func TestKeyboardHidReportSequenceCancelsDelayWithClearReport(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	defer reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	firstReport := make(chan []byte, 1)
	clearReport := make(chan []byte, 1)
	readErr := make(chan error, 1)
	go func() {
		first := make([]byte, 8)
		if _, err := io.ReadFull(reader, first); err != nil {
			readErr <- err
			return
		}
		firstReport <- first
		cancel()

		clear := make([]byte, 8)
		if _, err := io.ReadFull(reader, clear); err != nil {
			readErr <- err
			return
		}
		clearReport <- clear
	}()

	reports := []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, time.Hour),
		NewKeyboardHidReport(0, []byte{0, 0, 0, 0, 0, 0}, 0),
	}
	err = g.KeyboardHidReportSequence(ctx, reports)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	select {
	case err := <-readErr:
		t.Fatalf("read report: %v", err)
	case got := <-firstReport:
		want := []byte{ModifierMaskLeftShift, 0, 0x04, 0, 0, 0, 0, 0}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("first report mismatch:\n got %v\nwant %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading first report")
	}

	select {
	case err := <-readErr:
		t.Fatalf("read clear report: %v", err)
	case got := <-clearReport:
		want := []byte{0, 0, 0, 0, 0, 0, 0, 0}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("clear report mismatch:\n got %v\nwant %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading clear report")
	}

	state := g.GetKeysDownState()
	if state.Modifier != 0 || !reflect.DeepEqual([]byte(state.Keys), []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("final keysDown state mismatch: %+v", state)
	}
}

func TestKeyboardHidReportSequenceCancelsBeforeNextReportWithClearReport(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	defer reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	ctx := &cancelAfterErrChecksContext{nilErrs: 2}
	gotCh := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		got := make([]byte, 16)
		_, err := io.ReadFull(reader, got)
		if err != nil {
			errCh <- err
			return
		}
		gotCh <- got
	}()

	err = g.KeyboardHidReportSequence(ctx, []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, 0),
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x05}, 0),
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("read reports: %v", err)
	case got := <-gotCh:
		want := []byte{
			ModifierMaskLeftShift, 0, 0x04, 0, 0, 0, 0, 0,
			0, 0, 0, 0, 0, 0, 0, 0,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("cancel boundary reports mismatch:\n got %v\nwant %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading cancel boundary reports")
	}

	state := g.GetKeysDownState()
	if state.Modifier != 0 || !reflect.DeepEqual([]byte(state.Keys), []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("final keysDown state mismatch: %+v", state)
	}
}

func TestKeyboardHidReportSequencePreservesDelayBetweenReports(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	defer reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	reportTimes := make(chan time.Time, 2)
	readErr := make(chan error, 1)
	go func() {
		for i := 0; i < 2; i++ {
			report := make([]byte, 8)
			if _, err := io.ReadFull(reader, report); err != nil {
				readErr <- err
				return
			}
			reportTimes <- time.Now()
		}
	}()

	const delay = 25 * time.Millisecond
	err = g.KeyboardHidReportSequence(context.Background(), []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, delay),
		NewKeyboardHidReport(0, []byte{0, 0, 0, 0, 0, 0}, 0),
	})
	if err != nil {
		t.Fatalf("KeyboardHidReportSequence returned error: %v", err)
	}

	var first, second time.Time
	for i := 0; i < 2; i++ {
		select {
		case err := <-readErr:
			t.Fatalf("read report: %v", err)
		case ts := <-reportTimes:
			if i == 0 {
				first = ts
			} else {
				second = ts
			}
		case <-time.After(time.Second):
			t.Fatal("timed out reading timed reports")
		}
	}

	if elapsed := second.Sub(first); elapsed < delay/2 {
		t.Fatalf("reports were written too close together: elapsed %s, expected at least %s", elapsed, delay/2)
	}
}

func TestKeyboardHidReportSequencePreventsKeyboardReportInterleaving(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	defer reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	gotCh := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		first := make([]byte, 8)
		if _, err := io.ReadFull(reader, first); err != nil {
			errCh <- err
			return
		}

		keyboardWriteDone := make(chan error, 1)
		go func() {
			keyboardWriteDone <- g.keyboardWriteHidFile(0, []byte{0x06, 0, 0, 0, 0, 0})
		}()

		rest := make([]byte, 16)
		if _, err := io.ReadFull(reader, rest); err != nil {
			errCh <- err
			return
		}
		if err := <-keyboardWriteDone; err != nil {
			errCh <- err
			return
		}
		gotCh <- append(first, rest...)
	}()

	err = g.KeyboardHidReportSequence(context.Background(), []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, 25*time.Millisecond),
		NewKeyboardHidReport(0, []byte{0, 0, 0, 0, 0, 0}, 0),
	})
	if err != nil {
		t.Fatalf("KeyboardHidReportSequence returned error: %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("read reports: %v", err)
	case got := <-gotCh:
		want := []byte{
			ModifierMaskLeftShift, 0, 0x04, 0, 0, 0, 0, 0,
			0, 0, 0, 0, 0, 0, 0, 0,
			0, 0, 0x06, 0, 0, 0, 0, 0,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("interleaved report order mismatch:\n got %v\nwant %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading interleaving reports")
	}
}

func TestKeyboardHidReportSequenceDoesNotUpdateKeysDownOnFailedFirstWrite(t *testing.T) {
	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	reader.Close()
	defer writer.Close()
	g.keyboardHidFile = writer

	err = g.KeyboardHidReportSequence(context.Background(), []KeyboardHidReport{
		NewKeyboardHidReport(ModifierMaskLeftShift, []byte{0x04}, 0),
	})
	if err == nil {
		t.Fatal("expected write error")
	}

	var partial *KeyboardSequencePartialWriteError
	if !errors.As(err, &partial) {
		t.Fatalf("expected KeyboardSequencePartialWriteError, got %T: %v", err, err)
	}
	if partial.Completed != 0 {
		t.Fatalf("expected no completed writes, got %d", partial.Completed)
	}

	state := g.GetKeysDownState()
	if state.Modifier != 0 || !reflect.DeepEqual([]byte(state.Keys), []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("keysDown state should remain clear after failed first write: %+v", state)
	}
}

type cancelAfterErrChecksContext struct {
	nilErrs int
}

func (c *cancelAfterErrChecksContext) Deadline() (time.Time, bool) {
	return time.Time{}, false
}

func (c *cancelAfterErrChecksContext) Done() <-chan struct{} {
	return nil
}

func (c *cancelAfterErrChecksContext) Err() error {
	if c.nilErrs > 0 {
		c.nilErrs--
		return nil
	}
	return context.Canceled
}

func (c *cancelAfterErrChecksContext) Value(key any) any {
	return nil
}

func BenchmarkKeyboardHidReportSequence(b *testing.B) {
	g := newBenchmarkKeyboardGadget(b)
	reports := benchmarkKeyboardReports()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := g.KeyboardHidReportSequence(context.Background(), reports); err != nil {
			b.Fatalf("KeyboardHidReportSequence: %v", err)
		}
	}
}

func BenchmarkKeyboardReportLoop(b *testing.B) {
	g := newBenchmarkKeyboardGadget(b)
	reports := benchmarkKeyboardReports()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, report := range reports {
			if err := g.KeyboardReport(report.Modifier, report.Keys[:]); err != nil {
				b.Fatalf("KeyboardReport: %v", err)
			}
		}
	}
}

func newBenchmarkKeyboardGadget(b *testing.B) *UsbGadget {
	b.Helper()

	g := NewUsbGadget("test", &Devices{Keyboard: true}, nil, nil)
	reader, writer, err := os.Pipe()
	if err != nil {
		b.Fatalf("create pipe: %v", err)
	}
	g.keyboardHidFile = writer

	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, reader)
		close(drained)
	}()

	b.Cleanup(func() {
		writer.Close()
		reader.Close()
		<-drained
	})

	return g
}

func benchmarkKeyboardReports() []KeyboardHidReport {
	reports := make([]KeyboardHidReport, 0, 64)
	for i := 0; i < 32; i++ {
		key := byte(0x04 + i%26)
		reports = append(reports,
			NewKeyboardHidReport(ModifierMaskLeftShift, []byte{key}, 0),
			NewKeyboardHidReport(0, []byte{0, 0, 0, 0, 0, 0}, 0),
		)
	}
	return reports
}
