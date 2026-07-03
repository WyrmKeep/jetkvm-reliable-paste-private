package usbgadget

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type testHIDTeeRecord struct {
	MonotonicNS int64  `json:"monotonic_ns"`
	WallNS      int64  `json:"wall_ns"`
	Modifier    byte   `json:"modifier"`
	Keys        []byte `json:"keys"`
	Result      string `json:"result"`
}

func steppedHIDTeeClock() func() (int64, int64) {
	var monotonicNS int64
	wallNS := int64(1_800_000_000_000_000_000)
	return func() (int64, int64) {
		monotonicNS += 11_000_000
		wallNS += 11_000_000
		return monotonicNS, wallNS
	}
}

func readTestHIDTeeRecords(t *testing.T, path string) []testHIDTeeRecord {
	t.Helper()

	content, err := os.ReadFile(path)
	require.NoError(t, err)

	trimmed := strings.TrimSpace(string(content))
	if trimmed == "" {
		return nil
	}

	lines := strings.Split(trimmed, "\n")
	records := make([]testHIDTeeRecord, 0, len(lines))
	for _, line := range lines {
		var record testHIDTeeRecord
		require.NoError(t, json.Unmarshal([]byte(line), &record))
		records = append(records, record)
	}
	return records
}

func TestKeyboardHIDTeeDisabledByDefault(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "jetkvm-hid-tee.log")
	rotatedPath := filepath.Join(dir, "jetkvm-hid-tee.log.1")

	t.Setenv("JETKVM_HID_TEE", "")
	tee := newKeyboardHIDTeeFromEnvWithConfig(logPath, rotatedPath, 1024, steppedHIDTeeClock(), nil)
	require.Nil(t, tee)

	t.Setenv("JETKVM_HID_TEE", "true")
	tee = newKeyboardHIDTeeFromEnvWithConfig(logPath, rotatedPath, 1024, steppedHIDTeeClock(), nil)

	require.Nil(t, tee)
	matches, err := filepath.Glob(filepath.Join(dir, "jetkvm-hid-tee*"))
	require.NoError(t, err)
	require.Empty(t, matches)
}

func TestKeyboardHIDTeeRecordsWriteResult(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "jetkvm-hid-tee.log")
	rotatedPath := filepath.Join(dir, "jetkvm-hid-tee.log.1")
	tee, err := newKeyboardHIDTee(logPath, rotatedPath, 64*1024, steppedHIDTeeClock(), nil)
	require.NoError(t, err)
	defer func() {
		require.NoError(t, tee.Close())
	}()

	tee.Record(0x02, []byte{0x04}, nil)
	tee.Record(0x00, []byte{1, 2, 3, 4, 5, 6, 7}, errors.New("write failed"))
	require.NoError(t, tee.Flush())

	records := readTestHIDTeeRecords(t, logPath)
	require.Len(t, records, 2)
	require.Equal(t, int64(11_000_000), records[1].MonotonicNS-records[0].MonotonicNS)
	require.Equal(t, byte(0x02), records[0].Modifier)
	require.Equal(t, []byte{0x04, 0, 0, 0, 0, 0}, records[0].Keys)
	require.Equal(t, "ok", records[0].Result)
	require.Equal(t, []byte{1, 2, 3, 4, 5, 6}, records[1].Keys)
	require.Equal(t, "write failed", records[1].Result)
}

func TestKeyboardHIDTeeRotatesOnceAtCap(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "jetkvm-hid-tee.log")
	rotatedPath := filepath.Join(dir, "jetkvm-hid-tee.log.1")
	const maxBytes int64 = 512
	tee, err := newKeyboardHIDTee(logPath, rotatedPath, maxBytes, steppedHIDTeeClock(), nil)
	require.NoError(t, err)
	defer func() {
		require.NoError(t, tee.Close())
	}()

	for i := 0; i < 40; i++ {
		tee.Record(byte(i), []byte{byte(i)}, nil)
	}
	require.NoError(t, tee.Flush())

	currentInfo, err := os.Stat(logPath)
	require.NoError(t, err)
	rotatedInfo, err := os.Stat(rotatedPath)
	require.NoError(t, err)
	require.LessOrEqual(t, currentInfo.Size(), maxBytes)
	require.LessOrEqual(t, rotatedInfo.Size(), maxBytes)

	matches, err := filepath.Glob(filepath.Join(dir, "jetkvm-hid-tee*"))
	require.NoError(t, err)
	require.ElementsMatch(t, []string{logPath, rotatedPath}, matches)

	records := append(readTestHIDTeeRecords(t, rotatedPath), readTestHIDTeeRecords(t, logPath)...)
	require.NotEmpty(t, records)
	require.Equal(t, byte(39), records[len(records)-1].Modifier)
}
