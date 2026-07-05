package usbgadget

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

const (
	keyboardHIDTeeEnv         = "JETKVM_HID_TEE"
	keyboardHIDTeeLogPath     = "/tmp/jetkvm-hid-tee.log"
	keyboardHIDTeeRotatedPath = "/tmp/jetkvm-hid-tee.log.1"
	keyboardHIDTeeMaxBytes    = 8 * 1024 * 1024
	keyboardHIDTeeBufferSize  = 64 * 1024
)

var keyboardHIDTeeProcessStart = time.Now()

type keyboardHIDTeeClock func() (monotonicNS int64, wallNS int64)

type keyboardHIDTeeRecord struct {
	MonotonicNS int64                  `json:"monotonic_ns"`
	WallNS      int64                  `json:"wall_ns"`
	Modifier    byte                   `json:"modifier"`
	Keys        [hidKeyBufferSize]byte `json:"keys"`
	Result      string                 `json:"result"`
}

type keyboardHIDTee struct {
	mu           sync.Mutex
	logPath      string
	rotatedPath  string
	maxBytes     int64
	bytesWritten int64
	clock        keyboardHIDTeeClock
	logger       *zerolog.Logger
	file         *os.File
	writer       *bufio.Writer
	closed       bool
	failed       bool
}

func defaultKeyboardHIDTeeClock() (int64, int64) {
	now := time.Now()
	return now.Sub(keyboardHIDTeeProcessStart).Nanoseconds(), now.UnixNano()
}

func newKeyboardHIDTeeFromEnv(logger *zerolog.Logger) *keyboardHIDTee {
	return newKeyboardHIDTeeFromEnvWithConfig(
		keyboardHIDTeeLogPath,
		keyboardHIDTeeRotatedPath,
		keyboardHIDTeeMaxBytes,
		defaultKeyboardHIDTeeClock,
		logger,
	)
}

func newKeyboardHIDTeeFromEnvWithConfig(
	logPath string,
	rotatedPath string,
	maxBytes int64,
	clock keyboardHIDTeeClock,
	logger *zerolog.Logger,
) *keyboardHIDTee {
	if os.Getenv(keyboardHIDTeeEnv) != "1" {
		return nil
	}

	tee, err := newKeyboardHIDTee(logPath, rotatedPath, maxBytes, clock, logger)
	if err != nil {
		if logger != nil {
			logger.Warn().Err(err).Str("path", logPath).Msg("failed to enable keyboard HID tee")
		}
		return nil
	}
	if logger != nil {
		logger.Info().Str("path", logPath).Int64("max_bytes", maxBytes).Msg("keyboard HID tee enabled")
	}
	return tee
}

func newKeyboardHIDTee(
	logPath string,
	rotatedPath string,
	maxBytes int64,
	clock keyboardHIDTeeClock,
	logger *zerolog.Logger,
) (*keyboardHIDTee, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("keyboard HID tee max bytes must be positive")
	}
	if clock == nil {
		clock = defaultKeyboardHIDTeeClock
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}

	return &keyboardHIDTee{
		logPath:     logPath,
		rotatedPath: rotatedPath,
		maxBytes:    maxBytes,
		clock:       clock,
		logger:      logger,
		file:        file,
		writer:      bufio.NewWriterSize(file, keyboardHIDTeeBufferSize),
	}, nil
}

func (t *keyboardHIDTee) Record(modifier byte, keys []byte, writeErr error) {
	if t == nil {
		return
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.failed {
		return
	}

	var normalizedKeys [hidKeyBufferSize]byte
	copy(normalizedKeys[:], keys)

	result := "ok"
	if writeErr != nil {
		result = writeErr.Error()
	}
	monotonicNS, wallNS := t.clock()
	record := keyboardHIDTeeRecord{
		MonotonicNS: monotonicNS,
		WallNS:      wallNS,
		Modifier:    modifier,
		Keys:        normalizedKeys,
		Result:      result,
	}

	line, err := json.Marshal(record)
	if err != nil {
		t.failLocked(err)
		return
	}
	line = append(line, '\n')
	if err := t.writeLocked(line); err != nil {
		t.failLocked(err)
	}
}

func (t *keyboardHIDTee) Flush() error {
	if t == nil {
		return nil
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.failed || t.writer == nil {
		return nil
	}
	return t.writer.Flush()
}

func (t *keyboardHIDTee) Close() error {
	if t == nil {
		return nil
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closeLocked()
}

func (t *keyboardHIDTee) writeLocked(line []byte) error {
	if t.maxBytes > 0 && t.bytesWritten > 0 && t.bytesWritten+int64(len(line)) > t.maxBytes {
		if err := t.rotateLocked(); err != nil {
			return err
		}
	}

	n, err := t.writer.Write(line)
	t.bytesWritten += int64(n)
	return err
}

func (t *keyboardHIDTee) rotateLocked() error {
	if t.writer != nil {
		if err := t.writer.Flush(); err != nil {
			return err
		}
	}
	if t.file != nil {
		if err := t.file.Close(); err != nil {
			return err
		}
		t.file = nil
	}
	if err := os.Remove(t.rotatedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(t.logPath, t.rotatedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	file, err := os.OpenFile(t.logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	t.file = file
	t.writer = bufio.NewWriterSize(file, keyboardHIDTeeBufferSize)
	t.bytesWritten = 0
	return nil
}

func (t *keyboardHIDTee) failLocked(err error) {
	t.failed = true
	if t.logger != nil {
		t.logger.Warn().Err(err).Str("path", t.logPath).Msg("keyboard HID tee disabled after write failure")
	}
	_ = t.closeLocked()
}

func (t *keyboardHIDTee) closeLocked() error {
	if t.closed {
		return nil
	}
	t.closed = true

	var err error
	if t.writer != nil {
		err = errors.Join(err, t.writer.Flush())
		t.writer = nil
	}
	if t.file != nil {
		err = errors.Join(err, t.file.Close())
		t.file = nil
	}
	return err
}

func (u *UsbGadget) FlushKeyboardHIDTee() error {
	if u == nil || u.keyboardHIDTee == nil {
		return nil
	}
	return u.keyboardHIDTee.Flush()
}
