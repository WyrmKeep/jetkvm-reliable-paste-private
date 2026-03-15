package usbgadget

import "time"

const dwc3Path = "/sys/bus/platform/drivers/dwc3"

const hidWriteTimeout = 100 * time.Millisecond
