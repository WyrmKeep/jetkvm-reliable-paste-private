# JetKVM Paste Reliability Fix -- Final Handoff

Date: 2026-03-16
PR: #37 (fix/paste-reliability branch)
Issues closed: #30, #31, #32, #33, #34, #35, #36, #38
Result: 32k characters pasted with zero corruption in ~7 minutes

---

## Root Cause

`write()` to `/dev/hidg0` returns when the Linux kernel accepts the HID
report into its internal USB gadget buffer, NOT when the host actually
receives it over USB. The host polls the USB interrupt endpoint at an
interval determined by `bInterval` (not configurable via configfs on this
device, defaults to the kernel's f_hid default for the negotiated USB speed).

Under sustained paste input, this creates a chain of failures:

1. The JetKVM device writes HID reports to `/dev/hidg0` faster than the
   host USB stack polls them
2. Reports queue in the kernel's USB endpoint FIFO
3. The device signals macro completion while reports are still in transit
4. The host's Windows per-thread message queue (10,000 message limit) fills
   because Notepad's rendering slows as the document grows
5. Windows silently drops new messages -- including WM_KEYUP
6. Dropped WM_KEYUP leaves modifiers stuck (Shift key stuck produces $ for
   4, # for 3, garbled uppercase throughout)

### Why clicking into the target window fixes it

WM_LBUTTONDOWN forces Windows to:
- Re-evaluate focus via NtUserSetFocus
- Cancel any active keyboard repeat
- Flush stale keyboard state
- Process the click synchronously, giving the message pump time to catch up

### Why pausing alone doesn't fix it

A pause on the frontend (JavaScript setTimeout) runs on the wrong side of
the kernel buffer. The host continues processing buffered reports from the
kernel FIFO during the "pause." Characters keep appearing even though the
frontend has stopped sending.

### Why mouse movement doesn't fix it

WM_MOUSEMOVE is low-priority, coalesced, and does NOT trigger focus
re-evaluation or keyboard state reset.

---

## The Working Fix

Two-layer approach:

### Layer 1: Backend drain delay (Go, per-batch)

File: `jsonrpc.go`, in `rpcExecuteKeyboardMacro`

```go
time.Sleep(50 * time.Millisecond)
```

After `rpcDoExecuteKeyboardMacro` returns (all writes to /dev/hidg0
accepted by kernel), sleep 50ms to let the last few reports in the kernel
FIFO reach the host before signaling completion to the frontend.

### Layer 2: Frontend chunk pause (TypeScript, every 5000 chars)

File: `ui/src/hooks/useKeyboard.ts`, in `executePasteText`

Every 5000 characters, insert a 2000ms pause to let the Windows message
queue + Notepad rendering fully drain at chunk boundaries.

This is configurable via two input fields in the paste modal:
- **Chunk size (chars)**: default 5000
- **Chunk pause (ms)**: default 2000

### Performance

| Metric | Value |
|--------|-------|
| File size | 32,768 characters |
| Corruption | Zero |
| Total time | ~7 minutes |
| Backend drain overhead | 534 batches * 50ms = ~27 seconds |
| Frontend chunk overhead | 6 pauses * 2 seconds = ~12 seconds |
| Profile | Fast mode, debug off |

---

## All Fixes in PR #37

### Fix 1: waitForPasteMacroCompletion race condition (#30)
- File: `ui/src/hooks/useKeyboard.ts`
- Zustand `subscribe` was firing on ANY store state change, not just
  `isPasteInProgress` transitions. Added `lastValue` tracking to filter
  out noise from `keysDownState` updates.

### Fix 2: longRunThreshold/longRunPauseMs silently dropped (#31)
- File: `ui/src/hooks/useKeyboard.ts`
- Fields were passed from PasteModal but never declared in
  `ExecutePasteTextOptions`. Added to interface and destructuring.

### Fix 3: Error in macro completion signal (#32)
- Files: `jsonrpc.go`, `internal/hidrpc/message.go`, `internal/hidrpc/hidrpc.go`,
  `hidrpc.go`, `ui/src/hooks/hidRpc.ts`, `ui/src/hooks/stores.ts`,
  `ui/src/hooks/useKeyboard.ts`
- `KeyboardMacroState` now includes an `Error` string field. Frontend can
  distinguish success from HID write failure.

### Fix 4: Goroutine leak in onHidMessage (#33)
- File: `hidrpc.go`
- Changed `make(chan interface{})` to `make(chan interface{}, 1)`.
  One-character fix preventing one leaked goroutine per batch.

### Fix 5: Guard UpdateKeysDown behind successful write (#34)
- File: `internal/usbgadget/hid_keyboard.go`
- `UpdateKeysDown` was called unconditionally. Now only called after
  successful `keyboardWriteHidFile`.

### Fix 6: Replace time.After with reusable timer (#35)
- File: `jsonrpc.go`
- Single `time.NewTimer` reused via `Reset()` across all macro steps.
  Eliminates timer leak on cancel.

### Fix 7: Post-macro drain delay (#36)
- File: `jsonrpc.go`
- 50ms `time.Sleep` after macro execution, before signaling completion.

### Fix 8: Frontend chunk pause (#38)
- Files: `ui/src/hooks/useKeyboard.ts`, `ui/src/components/popovers/PasteModal.tsx`
- 2000ms pause every 5000 characters. Tunable via UI controls.

---

## What Was Tried and Didn't Work

| Approach | Why it failed |
|----------|---------------|
| Frontend breathing pauses (250ms, 500ms) | Wrong side of kernel buffer -- host keeps typing from USB FIFO |
| Frontend segment resets (keyboard state clear + pause) | Reset report gets queued BEHIND buffered reports in the same FIFO |
| Frontend 1000ms pauses with keyboard reset | Reset never reaches host before buffered reports drain |
| Proportional backend drain (660ms/batch) | Works but too slow (12 min for 32k) |
| Reduced backend drain (100ms) + frontend chunk pause | Untested at the time; 50ms + 2000ms chunk proved sufficient |

Key lesson: **"You cannot reset a FIFO queue by adding a message to the end of it."**

---

## Investigation Timeline

### Phase 1: Initial team analysis (4 agents)
- Backend Expert: traced full HID pipeline, found goroutine leak, timer leak,
  UpdateKeysDown bug, currentSession race
- Frontend Expert: found completion race, longRunThreshold dropped, dead code
- Researcher: mapped full architecture, ranked evidence
- Devil's Advocate: challenged focus hypothesis, found IsPaste flag bug

### Phase 2: Corruption screenshot analysis
- Identified stuck Shift modifier pattern: $ = Shift+4, # = Shift+3
- Ruled out "characters going to different window" theory
- Confirmed HID report loss causing modifier state divergence

### Phase 3: USB HID protocol deep dive (3 agents)
- USB HID Expert: Windows message queue overflow theory (10,000 limit),
  per-thread queue fills at ~500 messages/sec
- Focus Investigator: mass storage bandwidth contention, no mouse suppression
  during paste, lastUserInput data race
- RCA Challenger: keyboard repeat interaction, host-side rendering backlog

### Phase 4: Backend buffer discovery (3 agents)
- Go HID Pipeline Expert: write() returns before USB delivery -- THE root cause
- Go Timing Expert: calculated buffer lag, found 50ms drain insufficient
- Devil's Advocate: challenged queue theory, identified completion signal timing

### Phase 5: Tuning
- 660ms per-batch drain: works, 12 min for 32k (too slow)
- 100ms per-batch + 3s chunk pause: untested
- 50ms per-batch + 2s chunk pause per 5k chars: **7 min, zero corruption**

---

## Tuning Guide

If corruption appears on a different host or with a different target application:

1. **Increase chunk pause**: Try 3000ms, then 5000ms. This gives the host more
   time to process at chunk boundaries.

2. **Decrease chunk size**: Try 3000 chars, then 2000 chars. More frequent
   pauses with the same duration.

3. **Increase backend drain**: Edit `jsonrpc.go` line ~1055, change
   `time.Sleep(50 * time.Millisecond)` to a higher value. 200ms is safe,
   660ms is proven reliable.

4. **Switch to reliable profile**: Uses smaller batches (128 vs 320 steps)
   and higher key delay (3ms vs 2ms).

The chunk size and chunk pause are tunable from the paste modal UI without
redeploying. The backend drain requires a code change + redeploy.

---

## Key Files

| File | What |
|------|------|
| `jsonrpc.go` ~1035-1080 | Macro execution, drain delay, completion signal |
| `ui/src/hooks/useKeyboard.ts` | Paste execution, chunk pause, completion detection |
| `ui/src/components/popovers/PasteModal.tsx` | Paste modal UI, controls, profile config |
| `ui/src/hooks/hidRpc.ts` | HID RPC wire protocol (keyboard macro state message) |
| `ui/src/hooks/stores.ts` | Zustand store (isPasteInProgress, pasteError) |
| `internal/usbgadget/hid_keyboard.go` | Keyboard HID write path, /dev/hidg0 |
| `internal/usbgadget/utils.go` | writeWithTimeout implementation |
| `internal/hidrpc/message.go` | KeyboardMacroState struct (with Error field) |
| `hidrpc.go` | HID RPC message dispatch, onHidMessage timeout |

---

## Device Details

- JetKVM device at 192.168.1.36
- USB composite gadget: keyboard (hidg0) + abs mouse (hidg1) + rel mouse (hidg2) + mass storage
- Gadget max_speed: super-speed-plus
- bInterval: not configurable via configfs, defaults to kernel f_hid default
- HID write timeout: 100ms
- Deploy: `./dev_deploy.sh -r 192.168.1.36 --skip-native-build`
