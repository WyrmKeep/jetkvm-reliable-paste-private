# Design: Pipeline Batch Execution with bufferedAmount Flow Control

**Issue:** #39
**Date:** 2026-04-08
**Status:** Approved

## Problem

Each paste batch follows a synchronous cycle: frontend sends batch via WebRTC, subscribes to Zustand `isPasteInProgress` store, waits for backend completion (~520-600ms per batch), then sends the next batch. The pipeline is idle during backend execution. For 534 batches this means ~4.6 minutes of sequential execution.

The root cause is the cancel-on-arrival pattern in `rpcExecuteKeyboardMacro` (`jsonrpc.go:1038`): `cancelKeyboardMacro()` kills any running macro when a new one arrives, so the frontend must wait for each batch to complete before sending the next.

## Solution

Replace per-batch ACK with `bufferedAmount`-based flow control on the WebRTC data channel. SCTP handles reliability and ordering natively — application-level per-batch ACKs are unnecessary for correctness.

### Design Decision: Queue inside `rpcExecuteKeyboardMacro` (Option A)

The macro function becomes enqueue-and-return instead of execute-and-block. A dedicated drain goroutine executes macros sequentially. This was chosen over restructuring the HID dispatch layer (Option B) because:

- The `onHidMessage` 1-second timeout is satisfied (enqueue returns in <1ms)
- No changes to `hidrpc.go` — avoids blast radius on all HID message types
- Eliminates all three race conditions from #42 (global state, completion during setup, rapid flickers)
- Compatible with #43 (timer reuse) and #44 (batch mutex) inside the drain goroutine

## Architecture

### 1. Backend — Macro Queue

#### New state (near existing `keyboardMacroCancel` in `jsonrpc.go`)

```go
var (
    macroQueue     chan []hidrpc.KeyboardMacroStep
    macroQueueOnce sync.Once
    macroQueueCtx  context.Context    // cancelled to stop drain goroutine
    macroQueueStop context.CancelFunc
)
```

#### Queue lifecycle

- **Start:** `startMacroQueue()` called once when the first session is established. Creates the channel (`make(chan []hidrpc.KeyboardMacroStep, 64)` — capacity 64, enough for ~40 batches in-flight from frontend plus headroom) and spawns the drain goroutine.
- **Drain goroutine:** Loops on `range macroQueue`, executing each macro via `rpcDoExecuteKeyboardMacro(ctx, macro)`. After each macro completes, sends `KeyboardMacroState{State: false}` as it does today.
- **Stop:** Called on session close/takeover. Cancels the drain context (which cancels the current macro mid-execution), then drains remaining items from the channel without executing them.

#### Modified `rpcExecuteKeyboardMacro`

```go
func rpcExecuteKeyboardMacro(macro []hidrpc.KeyboardMacroStep) error {
    macroID := keyboardMacroSequence.Add(1)
    logger.Info().Uint64("macro_id", macroID).Int("step_count", len(macro)).Msg("enqueuing keyboard macro")

    // Non-blocking enqueue. If queue is full, log and drop.
    // Should not happen with frontend bufferedAmount flow control.
    select {
    case macroQueue <- macro:
        return nil
    default:
        logger.Warn().Uint64("macro_id", macroID).Msg("macro queue full, dropping batch")
        return fmt.Errorf("macro queue full")
    }
}
```

#### Modified cancel behavior

`cancelKeyboardMacro()` becomes `cancelAndDrainMacroQueue()`:

1. Cancel the current macro's context (stops mid-execution, resets keyboard state)
2. Drain the channel: `for { select { case <-macroQueue: default: return } }`
3. Called from the same sites as today:
   - Session takeover (`web.go:248`)
   - ICE close (`webrtc.go:430`)
   - Cloud handler (`cloud.go:481`)
   - Explicit cancel (`rpcCancelKeyboardMacro`)

#### Key invariant

Only one macro executes at a time — the drain goroutine is the single consumer. No mutex needed beyond the channel itself.

### 2. Frontend — bufferedAmount Flow Control

#### Flow control constants

```typescript
const PASTE_LOW_WATERMARK = 64 * 1024;   // 64KB — resume sending
const PASTE_HIGH_WATERMARK = 256 * 1024; // 256KB — pause sending
```

Lower than file upload watermarks (256KB/1MB) because paste batches are small (~6KB) and the backend queue should stay shallow. Allows ~40 batches in-flight before pausing.

#### Modified `executePasteText` send loop

Replace the synchronous ACK loop (`useKeyboard.ts:494`) with:

```typescript
const channel = rpcHidChannel;
const prevThreshold = channel.bufferedAmountLowThreshold;
channel.bufferedAmountLowThreshold = PASTE_LOW_WATERMARK;

let paused = false;
let resolve: (() => void) | null = null;

const waitForDrain = () => new Promise<void>(r => { resolve = r; });
const onLow = () => { paused = false; resolve?.(); };
channel.addEventListener("bufferedamountlow", onLow);

try {
    for (let index = 0; index < batches.length; index++) {
        if (signal?.aborted) throw new Error("Paste execution aborted");

        sendKeyboardMacroEventHidRpc(batches[index]);

        if (channel.bufferedAmount >= PASTE_HIGH_WATERMARK) {
            paused = true;
            await waitForDrain();
        }

        onProgress?.({ completedBatches: index + 1, totalBatches: batches.length });
    }
} finally {
    channel.removeEventListener("bufferedamountlow", onLow);
    channel.bufferedAmountLowThreshold = prevThreshold;
}
```

#### Removals

- **`waitForPasteMacroCompletion()`** (`useKeyboard.ts:159-181`) — deleted. This is the synchronous ACK subscription causing the pipeline stall. Also eliminates race conditions from #42.
- **`executePasteMacro()` / `executeMacroRemote()` paste path** — simplified. No Zustand subscription for flow control.
- **Adaptive pacing options** (`tailPauseMs`, `stressPauseMs`, `stressDurationMs`) — become unused. These compensated for synchronous ACK latency; `bufferedAmount` is the natural backpressure mechanism. Fields kept for backward compat but have no effect.

#### Shared channel safety

The HID channel carries keyboard reports, mouse events, and keepalives alongside paste macros. During paste:

- `bufferedAmountLowThreshold` is temporarily set for paste flow control
- Restored in the `finally` block when paste completes or is cancelled
- Other HID traffic is negligible during paste (user can't type while pasting)

### 3. Progress Tracking & Completion Signaling

#### Progress model

| Aspect | Today | Pipeline |
|--------|-------|----------|
| Metric | completed batches (ACK-confirmed) | submitted batches (sent to channel) |
| Meaning | "backend finished this batch" | "batch is in the pipeline" |
| Latency | Stalls during 520ms execution | Flows continuously |

#### Three-phase progress

```typescript
type PastePhase = "sending" | "draining" | "done";
```

1. **Sending** — batches being submitted. Progress = `submittedBatches / totalBatches`.
2. **Draining** — all batches submitted, waiting for backend to finish executing final queued macros. Progress holds at 100% with "finishing..." indicator. Detected when send loop completes but backend hasn't sent final `KeyboardMacroState{State: false}`.
3. **Done** — backend signals final completion OR timeout after `(estimatedBatchDuration * remainingQueueDepth) + 5000ms`.

#### Completion signal handling

- **During sending:** Frontend ignores `KeyboardMacroState` for flow control (uses `bufferedAmount`)
- **During draining:** Listens for final `State: false` to transition to "done"
- **`isPasteInProgress` Zustand state** remains for UI controls (disable keyboard, show cancel button) but no longer drives batch flow control

#### PasteModal.tsx changes

- Progress bar driven by `submittedBatches / totalBatches`
- Phase indicator: "Sending..." -> "Finishing..." -> "Done"
- Cancel button works throughout all phases
- No layout/design changes

## Files to Modify

### Backend

| File | Change |
|------|--------|
| `jsonrpc.go` | Remove `cancelKeyboardMacro()` at line 1038. Add `macroQueue` channel, `startMacroQueue()`, drain goroutine, `cancelAndDrainMacroQueue()`. Modify `rpcExecuteKeyboardMacro` to enqueue. |
| `webrtc.go:430` | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |
| `web.go:248` | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |
| `cloud.go:481` | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |

### Frontend

| File | Change |
|------|--------|
| `ui/src/hooks/useKeyboard.ts` | Remove `waitForPasteMacroCompletion()`. Replace send loop in `executePasteText` with `bufferedAmount` flow control. |
| `ui/src/components/popovers/PasteModal.tsx` | Update progress tracking for three-phase model (sending/draining/done). |

### Files NOT modified

| File | Reason |
|------|--------|
| `internal/hidrpc/hidrpc.go` | HID dispatch layer unchanged — enqueue returns within 1-second timeout |
| `ui/src/utils/pasteBatches.ts` | Batch building logic unchanged — only submission changes |
| `ui/src/hooks/stores.ts` | `isPasteInProgress` semantics preserved for UI state |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Host-side input queue overflow (target machine falls behind on USB HID) | `bufferedAmount` watermarks limit pipeline depth. Backend executes at same rate as today. |
| Shared HID channel interference during paste | Threshold restored in `finally` block. Other traffic negligible during paste. |
| Macro queue unbounded growth | Frontend `bufferedAmount` provides backpressure. Non-blocking enqueue drops if full (safety net). |
| Cancel must drain queue AND stop current macro | `cancelAndDrainMacroQueue()` handles both: drain channel + cancel context. |
| Backward compat with older backends | Coordinated change — backend and frontend must update together. Version gating not needed since this is a single release. |
| pion/webrtc deadlock (#2439) | Browser-side `RTCDataChannel.send()` is non-blocking. Not a concern for JS. Go side does not use `OnBufferedAmountLow`. |

## Related Issues

- **Supersedes #42** — pipeline eliminates per-batch completion waiting, removing all three race conditions
- **Depends on #41** — consolidating duplicate batching ensures a single correct batch-building path
- **Benefits from #43** — timer reuse in drain goroutine reduces GC pressure per queued macro
- **Benefits from #44** — batch mutex acquisition reduces per-character lock overhead
- **Related to #40** — correct byte limits ensure pipeline messages are properly sized

## Device Suitability (RV1106 ARM7, 256MB RAM)

- Channel + goroutine: ~96 bytes + ~4KB stack — negligible
- Queued macro memory: ~6KB/batch * ~40 max in-flight = ~240KB worst case
- Less GC pressure than today (persistent goroutine vs per-batch goroutine spawn)
- Same pattern already proven for USB mass storage uploads on this hardware
