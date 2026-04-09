# USB Connection Status Disconnect Detection

**Issue**: jetkvm/kvm#41 — USB connection status doesn't update when USB is disconnected  
**Date**: 2026-04-09  
**Status**: Approved (v2)

## Problem

When the USB data cable is physically disconnected from the host computer, the JetKVM device continues to show "Connected" on both the physical display and the web UI. Reloading the web UI does not fix it. HDMI status updates correctly.

### Root Cause

The USB status is determined by polling `/sys/class/udc/<udc>/state` every 500ms (`usb.go:22-27`). On self-powered JetKVM hardware (separate power supply, common with the included splitter), VBUS stays high after the data cable is removed. The DWC3 USB device controller may keep the sysfs state as `"configured"` or transition to `"suspended"` — never `"not attached"` — because it still sees VBUS.

HDMI works because it uses event-driven detection via a native callback (`native.go:38-42`), not sysfs polling.

### Secondary Issues

1. **Log bug** (`usb.go:109-110`): `usbState` is updated before the log reads it for the "from" field, so logs show the same value for both "from" and "to".
2. **Race in event push** (`usb.go:90-98`): `triggerUSBStateUpdate()` reads `usbState` in a goroutine without holding `usbStateLock`. Two rapid state changes can be pushed out of order.
3. **Frontend ignores `"unknown"` state**: The `USBStates` type (`stores.ts:489`) doesn't include `"unknown"`, which the backend can return on startup or sysfs read errors.
4. **Frontend ordering hazard**: The original plan proposed both an explicit `getUSBState` fetch and a backend `OnOpen` push. These two sources can race each other, with a stale snapshot overwriting a newer push.

## Contract

**Only raw `"configured"` plus strong write-failure evidence can produce an effective state of `"not attached"`.**

Raw `"suspended"` always passes through as `"suspended"`, even with write failures — host sleep, selective suspend, and re-enumeration paths are indistinguishable from physical unplug at this layer.

**Known limitations** (documented, not bugs):
- Idle unplug on hardware where sysfs stays `"configured"` is NOT detected. There is no userspace signal without active HID writes.
- Silent reconnect (replug without input) on the same hardware class is NOT detected. Recovery requires either a successful HID write or a raw sysfs state transition.

## Solution

Three layers: backend correctness, backend heuristic detection, frontend robustness.

### Layer 1: Backend — Fix log bug and event ordering

**File: `usb.go`**

In `checkUSBState()`:
- Save old state before overwriting: `oldState := usbState` before `usbState = newState`
- Use `oldState` in the log line

Replace fire-and-forget goroutines in `triggerUSBStateUpdate()` with a channel-based ordered delivery mechanism. The `usbMonitor` (Layer 2) owns this channel; a single consumer goroutine reads updates and publishes to both the display (`requestDisplayUpdate`) and the RPC channel (`writeJSONRPCEvent`) in order.

### Layer 2: Backend — USB Monitor with write-health heuristic

#### Architecture

Create a `usbMonitor` struct that encapsulates all USB state tracking, replacing the package-level `usbState`/`usbStateLock` variables.

```go
type usbMonitor struct {
    gadget    *usbgadget.UsbGadget
    clock     func() time.Time     // injectable for tests
    readState func() string         // injectable sysfs reader for tests
    logger    zerolog.Logger

    mu             sync.Mutex
    rawState       string           // what sysfs says
    effectiveState string           // what we report
    overrideActive bool             // true when effective != raw
    hasEverWritten bool             // at least one successful write seen
    writeWindow    []writeRecord    // sliding window

    stateCh        chan stateUpdate // ordered delivery to consumers
}

type writeRecord struct {
    at  time.Time
    err error   // nil = success
}

type stateUpdate struct {
    raw       string
    effective string
    reason    string
}
```

#### Effective state derivation rules

On each poll tick (500ms):

1. Read raw state from sysfs via `readState()`.
2. If `raw` changed from previous `rawState`: clear override (`overrideActive = false`), reset write window. This ensures stale failure data from a previous connection state does not contaminate the new state.
3. Apply override logic:
   - `raw == "configured"` AND `overrideActive` is true → `effective = "not attached"`
   - `raw == "configured"` AND write-health threshold is met (see below) → `effective = "not attached"`, set `overrideActive = true`
   - `raw == "suspended"` → `effective = "suspended"` (always pass through, never promote)
   - All other raw states → `effective = raw` (pass through)
4. If `effective` changed from previous `effectiveState`: send `stateUpdate` to `stateCh`.

#### Write-health state machine

**Window**: Sliding time window of the last 5 seconds of write attempts.

**Minimum sample count**: At least 3 write attempts in the window AND `hasEverWritten == true`. If either condition is not met, the heuristic does not apply (pass through raw state).

**Threshold**: More than 80% of writes in the window failed with disconnect-like errors.

**Disconnect-like errors**: Detected via a single `isDisconnectWriteErr(err error) bool` helper that uses `errors.Is` to unwrap:
- `syscall.EIO`
- `syscall.ENODEV`
- `syscall.ESHUTDOWN`
- `syscall.EPIPE`

All other errors (e.g., `EAGAIN`, `ETIMEDOUT`) are recorded in the window but do not count toward the disconnect threshold.

**Recording writes**: `RecordWriteResult(err error)` is called after every HID write (keyboard, abs mouse, rel mouse, wheel). On `err == nil`, also sets `hasEverWritten = true`.

**Latch behavior**: Once `overrideActive` is set to true, it remains true until explicitly cleared. It clears on:
- A successful HID write (`RecordWriteResult(nil)`)
- Any change in `rawState` (sysfs reports a different value than before)

On clear: `overrideActive = false`, write window is reset, `effectiveState` is re-derived from current `rawState`.

#### Ordered event delivery

The `stateCh` channel replaces the goroutine-per-event pattern. A single long-running consumer goroutine reads from `stateCh` and publishes to:
- `requestDisplayUpdate(true, reason)` for the physical display
- `writeJSONRPCEvent("usbState", effective, currentSession)` for the web UI

This guarantees in-order delivery. The channel is buffered (capacity 8) to avoid blocking the poll loop.

#### `rpcGetUSBState` change

`rpcGetUSBState()` returns `monitor.EffectiveState()` instead of reading raw sysfs directly. This ensures the RPC response is consistent with what was last pushed to the UI.

#### Diagnostic flag

Expose `monitor.IsWritePathUnhealthy() bool` which returns true when the write-failure threshold is met, regardless of whether an override is active. This is for logging and a future debug endpoint — it provides extra fidelity during `"suspended"` without changing the user-facing connection state.

### Layer 3: Frontend — Single source of truth and unknown state

**File: `ui/src/routes/devices.$id.tsx`**

Use the backend's `OnOpen` push (`webrtc.go:358-363`) as the sole source of initial USB state. Do NOT add a redundant `getUSBState` fetch. This eliminates the transport-level race between two independent state sources.

The push goes through the monitor's ordered channel, so the frontend receives the `effectiveState` in order.

**File: `ui/src/hooks/stores.ts`**

Add `"unknown"` to the `USBStates` type union:
```ts
export type USBStates = "configured" | "attached" | "not attached" | "suspended" | "addressed" | "unknown";
```

**File: `ui/src/components/USBStateStatus.tsx`**

Add `"unknown"` to `USBStateMap` (label: "Unknown") and `StatusCardProps` (gray style matching `"attached"` treatment with a loading spinner).

### Surfaces consuming USB state

Both the web UI and the physical display consume the same `effectiveState`:

- **Web UI**: Receives `"usbState"` events via `writeJSONRPCEvent` → `onJsonRpcRequest` handler in `devices.$id.tsx:674` → `setUsbState` in zustand store → `USBStateStatus` component and `InfoBar` component.
- **Physical display**: `updateDisplayUsbState()` in `display.go:43-50` reads the package-level `usbState` variable, which is now managed by the monitor. Checks `usbState == "configured"` for "Connected", everything else shows "Disconnected".

No separate display-side changes are needed. The monitor updates the package-level variable (or exposes a getter that `updateDisplayUsbState` calls) before requesting display updates.

## Observability

Each state transition is logged with structured fields:
- `raw_state`: what sysfs reported
- `effective_state`: what was published
- `override_active`: whether the heuristic overrode the raw state
- `override_reason`: `"write_failure"` or `"none"`
- `write_window_size`: number of samples in window
- `write_error_rate`: percentage of disconnect-like errors
- `has_ever_written`: whether any successful write has occurred

The `isWritePathUnhealthy` diagnostic flag is also logged on each transition for correlation.

## Files Changed

| File | Change |
|------|--------|
| `usb.go` | Replace package-level state with `usbMonitor`, fix log bug, channel-based delivery |
| `internal/usbgadget/usbgadget.go` | Add `RecordWriteResult`, `GetWriteHealth`, `isDisconnectWriteErr` |
| `internal/usbgadget/hid_keyboard.go` | Call `RecordWriteResult` after keyboard writes |
| `internal/usbgadget/hid_mouse_absolute.go` | Call `RecordWriteResult` after abs mouse/wheel writes |
| `internal/usbgadget/hid_mouse_relative.go` | Call `RecordWriteResult` after rel mouse writes |
| `display.go` | Update `updateDisplayUsbState` to read from monitor |
| `webrtc.go` | Update `OnOpen` handler to use monitor's push |
| `ui/src/hooks/stores.ts` | Add `"unknown"` to `USBStates` type |
| `ui/src/components/USBStateStatus.tsx` | Add `"unknown"` state mapping and visual treatment |
| `usb_monitor_test.go` (new) | Unit tests for the monitor state machine |

## Acceptance Criteria

### Must-pass test cases

| # | Scenario | Raw sysfs | Write activity | Expected effective | Notes |
|---|----------|-----------|----------------|-------------------|-------|
| 1 | Startup without host | `"not attached"` | None | `"not attached"` | Heuristic not applied (no writes) |
| 2 | Normal connected operation | `"configured"` | Succeeding | `"configured"` | Pass through |
| 3 | Active unplug, sysfs stuck | `"configured"` | Failing (EIO) | `"not attached"` | Override after threshold met |
| 4 | Active unplug, sysfs updates | `"not attached"` | Failing | `"not attached"` | Raw change, pass through |
| 5 | Reconnect after heuristic disconnect (write) | `"configured"` | Success after failures | `"configured"` | Successful write clears override |
| 6 | Reconnect after heuristic disconnect (sysfs) | Transitions away and back | None | Follows raw | Raw change clears override |
| 7 | Host sleep | `"suspended"` | None | `"suspended"` | Pass through, never promote |
| 8 | Host sleep + attempted input fails | `"suspended"` | Failing | `"suspended"` | Still pass through |
| 9 | Quick unplug/replug, sysfs unchanged | `"configured"` throughout | Fail then succeed | `"not attached"` then `"configured"` | Override then clear |
| 10 | Transient write errors (EAGAIN) | `"configured"` | Mixed, non-disconnect errors | `"configured"` | Non-disconnect errors don't count |
| 11 | Sysfs read error | Returns `"unknown"` | Any | `"unknown"` | Pass through |
| 12 | No prior successful write | `"configured"` | Failing (first writes ever) | `"configured"` | Heuristic requires `hasEverWritten` |
| 13 | Two rapid state changes | Varies | Any | Both delivered in order | Channel guarantees ordering |
| 14 | Idle unplug, sysfs stuck | `"configured"` | None (idle) | `"configured"` | **Known limitation**: not detected |
| 15 | Silent reconnect, sysfs stuck | `"configured"` | None (idle) | Stays `"not attached"` if latched | **Known limitation**: not detected |

### Monitor testability

The `usbMonitor` accepts injected dependencies:
- `clock func() time.Time` — for deterministic window expiry in tests
- `readState func() string` — stub sysfs reads
- `RecordWriteResult` is called directly — acts as the write-result stream

Tests drive the monitor by calling `readState` stubs, `RecordWriteResult`, and `tick()` (the poll function), then asserting on `effectiveState` and `stateCh` output.
