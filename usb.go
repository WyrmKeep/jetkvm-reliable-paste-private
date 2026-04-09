package kvm

import (
	"time"

	"github.com/jetkvm/kvm/internal/usbgadget"
)

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
	return gadget.KeyboardReport(modifier, keys)
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
