# USB Connection Status Disconnect Detection

**Issue**: jetkvm/kvm#41 — USB connection status doesn't update when USB is disconnected  
**Date**: 2026-04-09  
**Status**: Approved

## Problem

When the USB data cable is physically disconnected from the host computer, the JetKVM device continues to show "Connected" on both the physical display and the web UI. Reloading the web UI does not fix it. HDMI status updates correctly.

### Root Cause

The USB status is determined by polling `/sys/class/udc/<udc>/state` every 500ms (`usb.go:22-27`). On self-powered JetKVM hardware (separate power supply, common with the included splitter), VBUS stays high after the data cable is removed. The DWC3 USB device controller may keep the sysfs state as `"configured"` or only transition to `"suspended"` — never `"not attached"` — because it still sees VBUS.

HDMI works because it uses event-driven detection via a native callback (`native.go:38-42`), not sysfs polling.

### Secondary Issues

1. **Log bug** (`usb.go:109-110`): `usbState` is updated before the log reads it for the "from" field, so logs show the same value for both "from" and "to".
2. **Race in event push** (`usb.go:90-98`): `triggerUSBStateUpdate()` reads `usbState` in a goroutine without holding `usbStateLock`.
3. **No initial USB state fetch in frontend**: Unlike HDMI (`getVideoState` at `devices.$id.tsx:770`), the frontend never explicitly fetches `getUSBState` on connect. The backend pushes via `d.OnOpen()` (`webrtc.go:361`) but this is less robust.
4. **Frontend ignores `"unknown"` state**: The `USBStates` type (`stores.ts:489`) doesn't include `"unknown"`, which the backend can return on startup or sysfs read errors.

## Solution

Three-layer fix: backend correctness, backend heuristic detection, frontend robustness.

### Layer 1: Backend — Fix log bug and race condition

**File: `usb.go`**

In `checkUSBState()`:
- Save old state before overwriting: `oldState := usbState` before `usbState = newState`
- Use `oldState` in the log line

In `triggerUSBStateUpdate()`:
- Capture `usbState` into a local variable before launching the goroutine
- The goroutine uses the captured value instead of reading the shared variable

### Layer 2: Backend — HID write failure heuristic

When sysfs doesn't report disconnect, use HID write outcomes as a secondary signal.

**File: `internal/usbgadget/usbgadget.go`**

Add write health tracking to `UsbGadget`:
- `consecutiveWriteErrors int` — incremented on HID write failure, reset on success
- `lastSuccessfulWrite time.Time` — updated on each successful HID write
- `writeHealthLock sync.Mutex` — protects these fields
- `RecordWriteResult(err error)` — called after each HID write (keyboard, abs mouse, rel mouse, wheel)
- `GetWriteHealth() (consecutiveErrors int, lastSuccess time.Time)` — read by the polling loop

**Files: `hid_keyboard.go`, `hid_mouse_absolute.go`, `hid_mouse_relative.go`**

After each write operation (`keyboardWriteHidFile`, `AbsMouseReport`, `RelMouseReport`, `AbsMouseWheelReport`), call `u.RecordWriteResult(err)`.

**File: `usb.go`**

Enhanced `checkUSBState()` logic:
1. Read sysfs state (existing)
2. If sysfs says `"configured"`, check `gadget.GetWriteHealth()`:
   - If `consecutiveWriteErrors > 3` AND `time.Since(lastSuccess) > 2s` → override state to `"not attached"`
3. If sysfs says `"suspended"`, track how long it's been suspended:
   - If suspended for > 5s continuously → override state to `"not attached"`
   - Reset the suspended timer when state changes away from `"suspended"`
4. Proceed with existing change detection logic

New package-level field: `suspendedSince time.Time` to track when `"suspended"` started.

### Layer 3: Frontend — Initial fetch and unknown state handling

**File: `ui/src/routes/devices.$id.tsx`**

Add a `useEffect` that calls `getUSBState` when the RPC data channel opens, following the same pattern as `getVideoState` (line 770). This is redundant with the backend's `OnOpen` push but eliminates race conditions.

**File: `ui/src/hooks/stores.ts`**

Add `"unknown"` to the `USBStates` type union.

**File: `ui/src/components/USBStateStatus.tsx`**

Add `"unknown"` to `USBStateMap` (label: "Unknown") and `StatusCardProps` (gray/loading style matching `"attached"` treatment).

## Files Changed

| File | Change |
|------|--------|
| `usb.go` | Fix log bug, fix race, add suspended timer, add write health check to polling |
| `internal/usbgadget/usbgadget.go` | Add write health tracking fields and methods |
| `internal/usbgadget/hid_keyboard.go` | Call `RecordWriteResult` after keyboard writes |
| `internal/usbgadget/hid_mouse_absolute.go` | Call `RecordWriteResult` after abs mouse/wheel writes |
| `internal/usbgadget/hid_mouse_relative.go` | Call `RecordWriteResult` after rel mouse writes |
| `ui/src/routes/devices.$id.tsx` | Add `getUSBState` fetch on RPC channel open |
| `ui/src/hooks/stores.ts` | Add `"unknown"` to `USBStates` type |
| `ui/src/components/USBStateStatus.tsx` | Add `"unknown"` state mapping and visual treatment |

## Design Decisions

- **Passive monitoring only**: No phantom HID reports are sent to probe connectivity. Only real user-initiated writes are monitored. This avoids unintended input on the host.
- **Threshold-based**: 3 consecutive write failures AND 2s since last success prevents false positives from transient errors.
- **Suspended timeout (5s)**: Normal USB suspend from host sleep is typically accompanied by resume. A 5s sustained suspend without resume is treated as disconnect. Users can't interact during suspend regardless, so this is a reasonable heuristic.
- **Redundant frontend fetch**: The explicit `getUSBState` call duplicates the backend's `OnOpen` push but adds resilience against race conditions in WebRTC channel setup.
