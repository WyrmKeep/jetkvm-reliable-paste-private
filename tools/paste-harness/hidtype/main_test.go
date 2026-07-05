package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
)

type recordingWriter struct {
	reports [][8]byte
}

func (w *recordingWriter) Write(p []byte) (int, error) {
	var report [8]byte
	copy(report[:], p)
	w.reports = append(w.reports, report)
	return len(p), nil
}

func TestUKLayoutMatchesFrontendTable(t *testing.T) {
	keymap, err := buildKeymap(layoutUK)
	if err != nil {
		t.Fatal(err)
	}

	expected := map[rune]hidKey{
		'"':  {code: 0x1F, mod: leftShift}, // Shift+Digit2
		'@':  {code: 0x34, mod: leftShift}, // Shift+Quote
		'#':  {code: 0x31, mod: 0},         // Backslash
		'~':  {code: 0x31, mod: leftShift}, // Shift+Backslash
		'\\': {code: 0x64, mod: 0},         // IntlBackslash
		'|':  {code: 0x64, mod: leftShift}, // Shift+IntlBackslash
		'£':  {code: 0x20, mod: leftShift}, // Shift+Digit3
		'¬':  {code: 0x35, mod: leftShift}, // Shift+Backquote
		'<':  {code: 0x36, mod: leftShift}, // Shift+Comma
		'>':  {code: 0x37, mod: leftShift}, // Shift+Period
	}

	for r, want := range expected {
		if got := keymap[r]; got != want {
			t.Fatalf("%q mapped to code=0x%02x mod=0x%02x, want code=0x%02x mod=0x%02x", r, got.code, got.mod, want.code, want.mod)
		}
	}
}

func TestUSLayoutPreservesLegacySymbolPositions(t *testing.T) {
	keymap, err := buildKeymap(layoutUS)
	if err != nil {
		t.Fatal(err)
	}

	expected := map[rune]hidKey{
		'@':  {code: 0x1F, mod: leftShift},
		'"':  {code: 0x34, mod: leftShift},
		'#':  {code: 0x20, mod: leftShift},
		'~':  {code: 0x35, mod: leftShift},
		'\\': {code: 0x31, mod: 0},
		'|':  {code: 0x31, mod: leftShift},
		'<':  {code: 0x36, mod: leftShift},
		'>':  {code: 0x37, mod: leftShift},
	}

	for r, want := range expected {
		if got := keymap[r]; got != want {
			t.Fatalf("%q mapped to code=0x%02x mod=0x%02x, want code=0x%02x mod=0x%02x", r, got.code, got.mod, want.code, want.mod)
		}
	}
	if _, ok := keymap['£']; ok {
		t.Fatal("US layout must not type £ because the legacy table could not produce it")
	}
}

func TestClearReportBeforeFirstCharacterAndAfterLast(t *testing.T) {
	keymap, err := buildKeymap(layoutUK)
	if err != nil {
		t.Fatal(err)
	}
	writer := &recordingWriter{}
	var lat []int64
	st := stats{}
	out := &hidOutput{writer: writer, lat: &lat, stats: &st}

	elapsed := typeInput(out, runOptions{text: []byte("a"), keymap: keymap})
	finalizeStats(&st, lat, elapsed)

	want := [][8]byte{
		clearReport(),
		keyReport(0, 0x04),
		clearReport(),
		clearReport(),
	}
	if !slices.Equal(writer.reports, want) {
		t.Fatalf("reports = %#v, want %#v", writer.reports, want)
	}
	if st.CharsTyped != 1 || st.Writes != len(want) || st.Skipped != 0 {
		t.Fatalf("stats = %+v, want 1 char, %d writes, 0 skipped", st, len(want))
	}
}

func TestClearOptionLeavesZeroReportBeforeText(t *testing.T) {
	keymap, err := buildKeymap(layoutUK)
	if err != nil {
		t.Fatal(err)
	}
	writer := &recordingWriter{}
	out := &hidOutput{writer: writer, stats: &stats{}}

	typeInput(out, runOptions{text: []byte("a"), keymap: keymap, clearDoc: true})

	if len(writer.reports) < 8 {
		t.Fatalf("expected clear sequence plus text, got %d reports", len(writer.reports))
	}
	if writer.reports[0] != clearReport() {
		t.Fatalf("first report = %#v, want all-zero", writer.reports[0])
	}
	if writer.reports[1] != keyReport(leftCtrl, 0x04) {
		t.Fatalf("document clear did not start with Ctrl+A: %#v", writer.reports[1])
	}
	if writer.reports[5] != clearReport() {
		t.Fatalf("report before first text char = %#v, want all-zero", writer.reports[5])
	}
	if writer.reports[6] != keyReport(0, 0x04) {
		t.Fatalf("first text report = %#v, want lowercase a", writer.reports[6])
	}
	if writer.reports[len(writer.reports)-1] != clearReport() {
		t.Fatalf("last report = %#v, want all-zero", writer.reports[len(writer.reports)-1])
	}
}

func TestHidTeeWritesReportJsonLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "jetkvm-hid-tee.log")
	tee, err := newHidTee(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tee.close()

	writer := &recordingWriter{}
	out := &hidOutput{writer: writer, tee: tee, stats: &stats{}}
	out.write(keyReport(leftShift, 0x04))

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record hidTeeRecord
	if err := json.Unmarshal(content, &record); err != nil {
		t.Fatalf("tee record is not JSON: %v\n%s", err, content)
	}
	if record.Modifier != leftShift || !slices.Equal(record.Keys, []int{0x04, 0, 0, 0, 0, 0}) || record.Result != "ok" {
		t.Fatalf("record = %+v, want shifted KeyA ok", record)
	}
}

func TestUnsupportedLayoutFails(t *testing.T) {
	if _, err := buildKeymap("dvorak"); err != errUnsupportedLayout {
		t.Fatalf("buildKeymap returned %v, want errUnsupportedLayout", err)
	}
}

func TestSignalExitCodes(t *testing.T) {
	if got := exitCodeForSignal(syscall.SIGINT); got != 130 {
		t.Fatalf("SIGINT exit code = %d, want 130", got)
	}
	if got := exitCodeForSignal(syscall.SIGTERM); got != 143 {
		t.Fatalf("SIGTERM exit code = %d, want 143", got)
	}
}
