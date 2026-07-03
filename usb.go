package kvm

import (
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"
)

// lastKeyboardReportTime is the unix-nano timestamp of the most recent
// keyboard HID report written through the app (interactive or macro).
// Used by wakeTargetForPaste to detect an idle host before a paste.
var lastKeyboardReportTime atomic.Int64

// pasteDropEvery, when > 0 (set via env JETKVM_PASTE_DROP at startup),
// makes rpcKeyboardReport silently drop every Nth non-empty keyboard report
// — i.e. simulate a single dropped keystroke. This is a TEST-ONLY fault
// injector for validating the OCR verify/auto-repair stack against realistic
// sparse loss WITHOUT the CPU stress that also degrades the video/OCR. It is
// off unless the env var is set, and only the dev build's launch sets it.
var pasteDropEvery = func() int64 {
	if v, err := strconv.Atoi(os.Getenv("JETKVM_PASTE_DROP")); err == nil && v > 0 {
		return int64(v)
	}
	return 0
}()
var keyboardReportSeq atomic.Int64

var gadget *usbgadget.UsbGadget
var usbMonitorInstance *usbMonitor

// initUsbGadget initializes the USB gadget.
// call it only after the config is loaded.
func initUsbGadget() {
	gadget = usbgadget.NewUsbGadget(
		"jetkvm",
		config.UsbDevices,
		config.UsbConfig,
		usbLogger,
	)

	usbMonitorInstance = newUsbMonitor(
		gadget,
		time.Now,
		gadget.GetUsbState,
		usbLogger,
	)

	// Start the polling loop
	go func() {
		for {
			usbMonitorInstance.tick()
			time.Sleep(500 * time.Millisecond)
		}
	}()

	// Start the state update consumer
	go usbStateConsumer()

	gadget.SetOnKeyboardStateChange(func(state usbgadget.KeyboardState) {
		if currentSession != nil {
			currentSession.reportHidRPCKeyboardLedState(state)
		}
	})

	gadget.SetOnKeysDownChange(func(state usbgadget.KeysDownState) {
		if currentSession != nil {
			currentSession.enqueueKeysDownState(state)
		}
	})

	gadget.SetOnKeepAliveReset(func() {
		if currentSession != nil {
			currentSession.resetKeepAliveTime()
		}
	})

	// open the keyboard hid file to listen for keyboard events
	if err := gadget.OpenKeyboardHidFile(); err != nil {
		usbLogger.Error().Err(err).Msg("failed to open keyboard hid file")
	}
}

func rpcKeyboardReport(modifier byte, keys []byte) error {
	lastKeyboardReportTime.Store(time.Now().UnixNano())
	if pasteDropEvery > 0 {
		// Only drop "key down" reports (a non-zero modifier or key) — dropping
		// a reset/clear report wouldn't lose a character. Simulates one missed
		// keystroke so the host counter ends up short, exercising verify/repair.
		nonEmpty := modifier != 0
		for _, k := range keys {
			if k != 0 {
				nonEmpty = true
				break
			}
		}
		if nonEmpty && keyboardReportSeq.Add(1)%pasteDropEvery == 0 {
			usbLogger.Warn().Msg("paste-drop: simulating dropped keyboard report")
			return nil
		}
	}
	return gadget.KeyboardReport(modifier, keys)
}

func flushKeyboardHIDTee() {
	if gadget == nil {
		return
	}
	if err := gadget.FlushKeyboardHIDTee(); err != nil {
		usbLogger.Warn().Err(err).Msg("failed to flush keyboard HID tee")
	}
}

func rpcKeypressReport(key byte, press bool) error {
	return gadget.KeypressReport(key, press)
}

func rpcAbsMouseReport(x int, y int, buttons uint8) error {
	return gadget.AbsMouseReport(x, y, buttons)
}

func rpcRelMouseReport(dx int8, dy int8, buttons uint8) error {
	return gadget.RelMouseReport(dx, dy, buttons)
}

func rpcWheelReport(wheelY int8) error {
	return gadget.AbsMouseWheelReport(wheelY)
}

func rpcGetKeyboardLedState() (state usbgadget.KeyboardState) {
	return gadget.GetKeyboardState()
}

func rpcGetKeysDownState() (state usbgadget.KeysDownState) {
	return gadget.GetKeysDownState()
}

func rpcGetUSBState() (state string) {
	if usbMonitorInstance != nil {
		return usbMonitorInstance.EffectiveState()
	}
	return gadget.GetUsbState()
}

// triggerUSBStateUpdate pushes the current effective state through the monitor's channel.
func triggerUSBStateUpdate() {
	if usbMonitorInstance == nil {
		return
	}
	state := usbMonitorInstance.EffectiveState()
	select {
	case usbMonitorInstance.stateCh <- stateUpdate{
		raw:       usbMonitorInstance.RawState(),
		effective: state,
		reason:    "session_init",
	}:
	default:
		usbLogger.Warn().Msg("USB state update channel full during triggerUSBStateUpdate")
	}
}

// usbStateConsumer reads from the monitor's state channel and publishes to display + RPC.
func usbStateConsumer() {
	for update := range usbMonitorInstance.stateCh {
		requestDisplayUpdate(true, "usb_state_changed")
		if currentSession != nil {
			writeJSONRPCEvent("usbState", update.effective, currentSession)
		}
	}
}
