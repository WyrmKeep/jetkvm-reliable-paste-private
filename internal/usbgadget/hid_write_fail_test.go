package usbgadget

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/require"
)

func TestKeyboardWriteFailInjectorDisabledByDefaultAndInvalid(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "abc", "2.5", "wake_release"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(keyboardWriteFailEnv, value)
			require.Nil(t, newKeyboardWriteFailInjectorFromEnv())
		})
	}
}

func TestKeyboardWriteFailInjectorFailsEveryNthWrite(t *testing.T) {
	t.Setenv(keyboardWriteFailEnv, "3")
	injector := newKeyboardWriteFailInjectorFromEnv()
	require.NotNil(t, injector)

	require.NoError(t, injector.nextError())
	require.NoError(t, injector.nextError())
	require.ErrorIs(t, injector.nextError(), errInjectedKeyboardWriteFailure)
	require.NoError(t, injector.nextError())
	require.NoError(t, injector.nextError())
	require.ErrorIs(t, injector.nextError(), errInjectedKeyboardWriteFailure)
}

func TestKeyboardWriteFailInjectorWakeReleaseArmIsSingleUse(t *testing.T) {
	t.Setenv(keyboardWriteFailEnv, "wake-release")
	injector := newKeyboardWriteFailInjectorFromEnv()
	require.NotNil(t, injector)

	require.NoError(t, injector.nextError())
	injector.armWakeRelease()
	require.ErrorIs(t, injector.nextError(), errInjectedKeyboardWriteFailure)
	require.NoError(t, injector.nextError())
}

func TestKeyboardReportInjectedFailureRecordsTeeAndSkipsStateUpdate(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "jetkvm-hid-tee.log")
	rotatedPath := filepath.Join(dir, "jetkvm-hid-tee.log.1")

	oldInjector := keyboardWriteFailInjector
	keyboardWriteFailInjector = newKeyboardWriteFailInjectorEvery(1)
	t.Cleanup(func() {
		keyboardWriteFailInjector = oldInjector
	})

	g := NewTestGadget(func() time.Time { return time.Now() })
	tee, err := newKeyboardHIDTee(logPath, rotatedPath, 64*1024, steppedHIDTeeClock(), nil)
	require.NoError(t, err)
	g.keyboardHIDTee = tee
	g.keysDownState = KeysDownState{Modifier: 0, Keys: []byte{0, 0, 0, 0, 0, 0}}
	logger := zerolog.Nop()
	g.log = &logger
	defer func() {
		require.NoError(t, tee.Close())
	}()

	err = g.KeyboardReport(0x02, []byte{0x04, 0, 0, 0, 0, 0})

	require.ErrorIs(t, err, errInjectedKeyboardWriteFailure)
	require.Equal(t, byte(0), g.keysDownState.Modifier)
	require.Equal(t, []byte{0, 0, 0, 0, 0, 0}, []byte(g.keysDownState.Keys))
	require.NoError(t, tee.Flush())
	records := readTestHIDTeeRecords(t, logPath)
	require.Len(t, records, 1)
	require.Equal(t, byte(0x02), records[0].Modifier)
	require.Equal(t, []byte{0x04, 0, 0, 0, 0, 0}, records[0].Keys)
	require.True(t, errors.Is(err, errInjectedKeyboardWriteFailure))
	require.Contains(t, records[0].Result, "injected keyboard write failure")
}
