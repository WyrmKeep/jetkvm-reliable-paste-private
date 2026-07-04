package usbgadget

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
)

const keyboardWriteFailEnv = "JETKVM_PASTE_WRITE_FAIL"

var errInjectedKeyboardWriteFailure = errors.New("injected keyboard write failure")

type keyboardWriteFailMode uint8

const (
	keyboardWriteFailEveryNth keyboardWriteFailMode = iota + 1
	keyboardWriteFailWakeRelease
)

type keyboardWriteFailureInjector struct {
	mode             keyboardWriteFailMode
	every            int64
	seq              atomic.Int64
	wakeReleaseArmed atomic.Bool
}

var keyboardWriteFailInjector = newKeyboardWriteFailInjectorFromEnv()

func newKeyboardWriteFailInjectorFromEnv() *keyboardWriteFailureInjector {
	value := strings.TrimSpace(os.Getenv(keyboardWriteFailEnv))
	if value == "wake-release" {
		return &keyboardWriteFailureInjector{mode: keyboardWriteFailWakeRelease}
	}

	every, err := strconv.Atoi(value)
	if err == nil && every > 0 {
		return newKeyboardWriteFailInjectorEvery(int64(every))
	}
	return nil
}

func newKeyboardWriteFailInjectorEvery(every int64) *keyboardWriteFailureInjector {
	if every <= 0 {
		return nil
	}
	return &keyboardWriteFailureInjector{
		mode:  keyboardWriteFailEveryNth,
		every: every,
	}
}

func (i *keyboardWriteFailureInjector) nextError() error {
	if i == nil {
		return nil
	}

	switch i.mode {
	case keyboardWriteFailEveryNth:
		if i.every > 0 && i.seq.Add(1)%i.every == 0 {
			return fmt.Errorf("%w: every %dth keyboard write", errInjectedKeyboardWriteFailure, i.every)
		}
	case keyboardWriteFailWakeRelease:
		if i.wakeReleaseArmed.Swap(false) {
			return fmt.Errorf("%w: wake-release", errInjectedKeyboardWriteFailure)
		}
	}
	return nil
}

func (i *keyboardWriteFailureInjector) armWakeRelease() {
	if i == nil || i.mode != keyboardWriteFailWakeRelease {
		return
	}
	i.wakeReleaseArmed.Store(true)
}

// ArmNextWakeReleaseWriteFailure marks the next keyboard write as the wake-tap
// release attempt for the targeted JETKVM_PASTE_WRITE_FAIL=wake-release mode.
func ArmNextWakeReleaseWriteFailure() {
	keyboardWriteFailInjector.armWakeRelease()
}

func maybeInjectKeyboardWriteFailure() error {
	if keyboardWriteFailInjector == nil {
		return nil
	}
	return keyboardWriteFailInjector.nextError()
}
