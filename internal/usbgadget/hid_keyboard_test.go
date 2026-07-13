package usbgadget

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func newKeyboardTestGadget(t *testing.T) *UsbGadget {
	t.Helper()
	g := NewTestGadget(time.Now)
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		return nil
	}
	t.Cleanup(g.cancelAllAutoReleaseTimers)
	return g
}

func requireKeysDownState(t *testing.T, state KeysDownState, modifier byte, keys []byte) {
	t.Helper()
	require.Equal(t, modifier, state.Modifier)
	require.Equal(t, keys, []byte(state.Keys))
}

func requireNoAutoReleaseTimer(t *testing.T, g *UsbGadget, key byte) {
	t.Helper()
	g.kbdAutoReleaseLock.Lock()
	defer g.kbdAutoReleaseLock.Unlock()
	require.Nil(t, g.kbdAutoReleaseTimers[key])
}

func requireAutoReleaseTimer(t *testing.T, g *UsbGadget, key byte) *keyboardAutoReleaseTimer {
	t.Helper()
	g.kbdAutoReleaseLock.Lock()
	defer g.kbdAutoReleaseLock.Unlock()
	timer := g.kbdAutoReleaseTimers[key]
	require.NotNil(t, timer)
	return timer
}

func TestConcurrentKeypressReportAndClearUseSingleKeyboardMutex(t *testing.T) {
	g := newKeyboardTestGadget(t)

	keypressWriteStarted := make(chan struct{})
	allowKeypressWrite := make(chan struct{})
	clearDone := make(chan error, 1)
	keypressDone := make(chan error, 1)

	var once sync.Once
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		if modifier == 0 && len(keys) == hidKeyBufferSize && keys[0] == 0x04 {
			once.Do(func() { close(keypressWriteStarted) })
			select {
			case <-allowKeypressWrite:
			case <-time.After(2 * time.Second):
				return errors.New("timed out waiting to release blocked keypress write")
			}
		}
		return nil
	}

	go func() {
		keypressDone <- g.KeypressReport(0x04, true)
	}()
	select {
	case <-keypressWriteStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("keypress write did not start")
	}

	go func() {
		clearDone <- g.KeyboardReport(0, []byte{0, 0, 0, 0, 0, 0})
	}()

	// Without the full keyboard mutex, the clear report can complete while the
	// keypress write is blocked, then the stale keypress update runs last and
	// leaves the key stuck in keysDownState. With the mutex, clear waits until
	// the keypress transaction has fully completed.
	clearCompleted := false
	select {
	case err := <-clearDone:
		require.NoError(t, err)
		clearCompleted = true
	case <-time.After(50 * time.Millisecond):
	}

	close(allowKeypressWrite)

	require.NoError(t, <-keypressDone)
	if !clearCompleted {
		require.NoError(t, <-clearDone)
	}
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
}

func TestKeypressReportWriteFailureDoesNotUpdateStateOrScheduleTimer(t *testing.T) {
	g := newKeyboardTestGadget(t)
	writeErr := errors.New("keyboard write failed")
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		return writeErr
	}

	err := g.KeypressReport(0x04, true)

	require.ErrorIs(t, err, writeErr)
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, 0x04)
}

func TestKeypressReportModifierDoesNotScheduleAutoRelease(t *testing.T) {
	g := newKeyboardTestGadget(t)

	require.NoError(t, g.KeypressReport(LeftShift, true))

	requireKeysDownState(t, g.GetKeysDownState(), ModifierMaskLeftShift, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, LeftShift)
}

func TestKeypressReportNonModifierSchedulesAutoRelease(t *testing.T) {
	g := newKeyboardTestGadget(t)

	require.NoError(t, g.KeypressReport(0x04, true))

	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0x04, 0, 0, 0, 0, 0})
	requireAutoReleaseTimer(t, g, 0x04)
}

func TestClearKeyboardStateCancelsTimersAndWritesClearReport(t *testing.T) {
	g := newKeyboardTestGadget(t)
	g.keysDownState = KeysDownState{
		Modifier: ModifierMaskLeftShift,
		Keys:     []byte{0x04, 0, 0, 0, 0, 0},
	}
	g.scheduleAutoRelease(0x04)

	var reports []KeysDownState
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		reports = append(reports, KeysDownState{Modifier: modifier, Keys: append([]byte(nil), keys...)})
		return nil
	}

	require.NoError(t, g.ClearKeyboardState())

	require.Len(t, reports, 1)
	requireKeysDownState(t, reports[0], 0, []byte{0, 0, 0, 0, 0, 0})
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, 0x04)
}

func startAutoReleaseCallbackBlockedBeforeKeyboardLock(
	t *testing.T,
	g *UsbGadget,
	key byte,
) (release func(), done <-chan struct{}) {
	t.Helper()

	callbackStarted := make(chan struct{})
	continueCallback := make(chan struct{})
	callbackDone := make(chan struct{})
	var releaseOnce sync.Once
	releaseCallback := func() {
		releaseOnce.Do(func() { close(continueCallback) })
	}
	t.Cleanup(releaseCallback)
	g.beforeAutoReleaseKeyboardLock = func() {
		close(callbackStarted)
		<-continueCallback
	}

	timer := &keyboardAutoReleaseTimer{}
	timer.timer = time.AfterFunc(0, func() {
		defer close(callbackDone)
		g.performAutoRelease(key, timer)
	})
	g.kbdAutoReleaseLock.Lock()
	g.kbdAutoReleaseTimers[key] = timer
	g.kbdAutoReleaseLock.Unlock()

	<-callbackStarted
	return releaseCallback, callbackDone
}

func TestAutoReleaseCallbackBeforeClearWritesReleaseThenClear(t *testing.T) {
	g := newKeyboardTestGadget(t)
	const key = byte(0x04)
	g.keysDownState = KeysDownState{
		Keys: []byte{key, 0, 0, 0, 0, 0},
	}

	var reports []KeysDownState
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		reports = append(reports, KeysDownState{Modifier: modifier, Keys: append([]byte(nil), keys...)})
		return nil
	}

	releaseCallback, callbackDone := startAutoReleaseCallbackBlockedBeforeKeyboardLock(t, g, key)
	releaseCallback()
	<-callbackDone
	require.Len(t, reports, 1)
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, key)

	require.NoError(t, g.ClearKeyboardState())
	require.Len(t, reports, 2)
	requireKeysDownState(t, reports[0], 0, []byte{0, 0, 0, 0, 0, 0})
	requireKeysDownState(t, reports[1], 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, key)
}

func TestClearKeyboardStateWinsOverFiredAutoReleaseCallback(t *testing.T) {
	g := newKeyboardTestGadget(t)
	const key = byte(0x04)
	g.keysDownState = KeysDownState{
		Keys: []byte{key, 0, 0, 0, 0, 0},
	}

	var reports []KeysDownState
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		reports = append(reports, KeysDownState{Modifier: modifier, Keys: append([]byte(nil), keys...)})
		return nil
	}

	releaseCallback, callbackDone := startAutoReleaseCallbackBlockedBeforeKeyboardLock(t, g, key)

	require.NoError(t, g.ClearKeyboardState())
	require.Len(t, reports, 1)
	requireNoAutoReleaseTimer(t, g, key)
	releaseCallback()
	<-callbackDone

	require.Len(t, reports, 1)
	requireKeysDownState(t, reports[0], 0, []byte{0, 0, 0, 0, 0, 0})
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, key)
}

func TestFiredAutoReleaseCallbackCannotConsumeReplacementTimer(t *testing.T) {
	g := newKeyboardTestGadget(t)
	const key = byte(0x04)
	g.keysDownState = KeysDownState{
		Keys: []byte{key, 0, 0, 0, 0, 0},
	}

	var reports []KeysDownState
	g.keyboardWriteFunc = func(modifier byte, keys []byte) error {
		reports = append(reports, KeysDownState{Modifier: modifier, Keys: append([]byte(nil), keys...)})
		return nil
	}

	releaseOldCallback, oldCallbackDone := startAutoReleaseCallbackBlockedBeforeKeyboardLock(t, g, key)

	require.NoError(t, g.ClearKeyboardState())
	require.Len(t, reports, 1)
	requireKeysDownState(t, reports[0], 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, key)

	var replacementCallback func()
	g.autoReleaseAfterFunc = func(_ time.Duration, callback func()) *time.Timer {
		replacementCallback = callback
		return time.NewTimer(time.Hour)
	}
	require.NoError(t, g.KeypressReport(key, true))
	replacementTimer := requireAutoReleaseTimer(t, g, key)
	require.Len(t, reports, 2)
	requireKeysDownState(t, reports[1], 0, []byte{key, 0, 0, 0, 0, 0})

	releaseOldCallback()
	<-oldCallbackDone

	require.Len(t, reports, 2, "stale callback must not write a release")
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{key, 0, 0, 0, 0, 0})
	require.Same(t, replacementTimer, requireAutoReleaseTimer(t, g, key))

	g.beforeAutoReleaseKeyboardLock = nil
	require.NotNil(t, replacementCallback)
	replacementCallback()

	require.Len(t, reports, 3)
	requireKeysDownState(t, reports[2], 0, []byte{0, 0, 0, 0, 0, 0})
	requireKeysDownState(t, g.GetKeysDownState(), 0, []byte{0, 0, 0, 0, 0, 0})
	requireNoAutoReleaseTimer(t, g, key)
}
