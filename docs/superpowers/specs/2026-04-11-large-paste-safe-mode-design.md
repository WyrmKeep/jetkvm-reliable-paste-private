# Large-Paste Safe Mode: Chunk-Aware Pauses with True Drain Boundaries

**Issues:** #38 (large-paste safe mode with chunk boundaries and host catch-up pauses)
**Date:** 2026-04-11
**Approach:** A — chunk policy co-located with `buildPasteMacroBatches` in `pasteMacro.ts`; `batchStats` widened with `sourceChars`; chunk-aware loop inside `executePasteText` that calls the Phase 1 `waitForPasteDrain("required", ...)` helper at chunk boundaries; abortable pause between chunks; extended `PasteProgress` with chunk index/total and a `"pausing"` phase; cosmetic rename of the 200 ms inter-macro drain delay in `drainMacroQueue` to a named constant (value unchanged).
**Branch:** `feat/large-paste-safe-mode`
**Predecessor:** Phase 1 (PR #49, merged 2026-04-10) — paste-depth semantics, shallow 64-slot queue, `waitForPasteDrain` helper with both `required` and `bestEffort` modes landed unused, IsPaste preserved end-to-end, non-paste macros no longer toggle `isPasteInProgress`.

## Problem

Very large pastes (32k+ characters, with 100k as the stress target in issue #38) corrupt on the target machine even with the Phase 1 correctness fixes in place. Phase 1 guaranteed that the *frontend sees a correct "paste finished" signal*, but the fundamental pacing problem remains: the host USB stack and target application fall behind a sustained burst, and once behind they stay behind for the tail of the paste.

### What the research verified (current `main`, post PR #49 + #50)

All line citations below are against the current `main` branch as of 2026-04-11.

#### Frontend — `ui/src/hooks/useKeyboard.ts`

- **`executePasteText` signature (lines 539–550)** takes `text, options` where options include `keyboard, delayMs, maxStepsPerBatch, maxBytesPerBatch, finalSettleMs, signal, onProgress, onTrace`. All existing fields will be preserved.
- **`buildPasteMacroBatches` is invoked at lines 552–558** and returns `{ batches, invalidChars, batchStats }`.
- **The inline drain wait was replaced in Phase 1** with a call to `waitForPasteDrain` at lines 610–617:
  ```typescript
  const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
  await waitForPasteDrain("bestEffort", drainTimeoutMs, signal);
  ```
- **`waitForPasteDrain` helper lives at lines 93–197** and already accepts `(mode: "required" | "bestEffort", timeoutMs, signal?, settleMs?, armWindowMs?)`. Both modes are implemented. The `"required"` branch at lines ~170–175 rejects with `Error("waitForPasteDrain: required drain timed out after ${timeoutMs}ms")`. **Phase 1 landed both modes; Phase 1 only uses `"bestEffort"`. Phase 2 is the first consumer of `"required"`.**
- **Flow control (lines 565–566)** defines `PASTE_LOW_WATERMARK = 64 * 1024`, `PASTE_HIGH_WATERMARK = 256 * 1024`. The `bufferedamountlow` listener is inside `executePasteText`; **the watermark values, threshold config, and the low-watermark drain-resume behavior are untouched in Phase 2**. Phase 2 additively wires the existing `waitForChannelDrain` helper to `signal` so cancel interrupts a high-watermark pause — a correctness fix, not a rewrite. See Race A below for the motivation.
- **Cancel path:** `onConfirmPaste` (line 98) creates an `AbortController`, passes `abortController.signal` as `signal` (line 110) to `executePasteText`. `waitForPasteDrain` subscribes via `signal?.addEventListener("abort", onAbort)` (line 168) and rejects on abort (line 141). Cancel cascade is already uniform; Phase 2 will plug `abortableSleep` into the same signal.

#### Frontend — `ui/src/utils/pasteMacro.ts`

- **`buildPasteMacroBatches` signature (lines 105–111):**
  ```typescript
  export function buildPasteMacroBatches(
    text: string,
    keyboard: KeyboardLayoutLike,
    delay: number,
    maxStepsPerBatch: number,
    maxBytesPerBatch: number,
  ): PasteMacroBatchResult
  ```
- **`batchStats` current shape (lines 24–27):**
  ```typescript
  batchStats: Array<{ stepCount: number; estimatedBytes: number }>;
  ```
  **`sourceChars` is NOT present.** Phase 2 adds it.
- **`estimateBatchBytes` (lines 30–36):** returns `6 + stepCount * 18`. Matches the CLAUDE.md invariant exactly. Phase 2 does not touch this formula.
- **Character iteration (lines 134–140):** char-by-char via `for (const char of text)`, normalized to NFC. Each iteration is one input character. `sourceChars` can be incremented per iteration and committed to the current `batchStats` entry alongside `stepCount` and `estimatedBytes`.

#### Frontend — `ui/src/components/popovers/PasteModal.tsx`

- **Progress state (line 42):** `{ completed: number; total: number; phase: "sending" | "draining" }`.
- **`onProgress` handler (lines 111–116):** maps `{ completedBatches, totalBatches }` into the progress state and sets `phase` via ternary.
- **`onTrace` handler (lines 118–123):** appends a trace line `batch ${trace.batchIndex}/${trace.totalBatches}: steps=... bytes=... buffered=...`.
- **No size-based UI branching today.** Modal renders identically for small and large pastes. Phase 2 will add a chunk subline (`Chunk X/Y`) and a `"pausing"` phase label, and extend the trace formatter to render the three new chunk trace kinds.

#### Backend — `jsonrpc.go`

- **`drainMacroQueue` (lines 1093–1140):** processes each queued macro in order, cancels per-macro context when done, decrements `pasteDepth` with edge-triggered `State:false` emit on 1→0, then `time.Sleep(200 * time.Millisecond)` before the next iteration.
- **The 200 ms literal at line 1138** is load-bearing from PR #41. Issue #38 explicitly tells us not to retune it in this PR. Phase 2's only `jsonrpc.go` change is to rename this literal to a named constant `pasteInterMacroDrainMs`, value unchanged.
- **`pasteDepth atomic.Int32`:** `Add(1)` on enqueue with `State:true` emitted on 0→1 (line 1226), `Add(-1)` on drain with `State:false` emitted on 1→0 (line 1128), rollback-safe on enqueue failure (line 1241), cancel sweep path (line 1199). **Phase 2 does not touch any of this.**
- **`waitForPasteDrain` helper in backend:** does not exist. The helper lives entirely in the frontend. The backend exposes `pasteDepth` via state messages; the frontend subscribes and waits.
- **`macroQueue` depth:** `macroQueueDepth = 64` (Phase 1 PR #49 / #48). **Not touched in Phase 2 — that's Phase 1's scope and Phase 1 already landed it.**
- **`queuedMacro` struct:** already carries `isPaste bool` and `session *Session`. Phase 2 does not extend this struct.

### What still needs to change

The cited state is what Phase 1 delivered. The gap to Phase 2's acceptance criteria is:

1. **No chunk policy** — there is no code that knows about `autoThresholdChars`, `chunkChars`, or `chunkPauseMs`. Large pastes run a single monolithic sending loop followed by a best-effort drain wait.
2. **No chunk accounting in `batchStats`** — the frontend cannot partition batches into chunks without a per-batch source-character count.
3. **`waitForPasteDrain("required", ...)` has zero call sites** — Phase 2 is the first consumer. A required drain timeout must surface as a real error (not a silent resolve), and the catch path in `executePasteText` must cover it. The required-drain timeout must be sized per chunk rather than a flat constant; at reliable-profile pacing on current `main`, a 5 000-char chunk takes ~55 s end-to-end, so a naive 15 s timeout (as an earlier draft proposed) would fire on every chunk boundary.
4. **No abortable sleep primitive** — Phase 2 needs a small `abortableSleep(ms, signal)` helper in `useKeyboard.ts` that `Promise.race`s a timeout against the `signal.abort` event and rejects on abort.
5. **`waitForChannelDrain` (the high-watermark pause inside `executePasteText`) ignores the abort signal** — current `main` wires it only to the persistent `bufferedamountlow` listener via a captured `drainResolve` ref. If the user cancels while the loop is parked on a full channel buffer, the cancel is effectively delayed until the buffer actually drains, which may be seconds. Phase 2 wires the existing helper to reject on `signal.abort()` as an additive correctness fix (no change to the watermark values or the low-watermark resume path).
6. **No chunk UI** — the modal has no `"pausing"` phase label and no chunk progress display.
7. **200 ms literal is a magic number** — naming it makes Phase 3b's timer-reuse landing site obvious and documents the load-bearing invariant in the declaration.

## Design

### Scope constraints

**Touch list (the only files changed in this PR):**
- `ui/src/utils/pasteMacro.ts` — `LargePastePolicy` type, `DEFAULT_LARGE_PASTE_POLICY`, `PasteBatchStat` named interface, `sourceChars` in batch stats, `partitionBatchesByChunkChars` pure helper
- `ui/src/hooks/useKeyboard.ts` — chunk-aware branch in `executePasteText`, `abortableSleep` helper, `PasteProgress` type extension, trace emission for the three new chunk kinds, abort-aware upgrade to the existing `waitForChannelDrain` pattern (adds `drainReject` slot and an abort listener; values and low-watermark resume behavior unchanged)
- `ui/src/components/popovers/PasteModal.tsx` — `"pausing"` phase label, `Chunk X/Y` subline, trace formatter switch for the new kinds
- `jsonrpc.go` — rename `200 * time.Millisecond` literal to `pasteInterMacroDrainMs` named constant, value unchanged

**Must NOT touch (Phase 2 forbidden list):**
- `PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK` numeric values, `bufferedAmountLowThreshold` assignment, and the basic `bufferedamountlow` drain-resume mechanism in `useKeyboard.ts` — #46's work, values preserved exactly. **Exception:** Phase 2 adds an abort-path to the existing `waitForChannelDrain` helper so cancel during a high-watermark pause rejects immediately. This is an additive correctness fix that does not change any existing field's value or rename the listener; pre-Phase-2 callers would not see a behavior difference in the non-abort path.
- Backend `macroQueue` depth or `queuedMacro` struct — Phase 1 scope, already landed
- `ui/src/utils/pasteBatches.ts` — profile retuning is Phase 3a scope
- `estimateBatchBytes` formula in `pasteMacro.ts` — already correct, untouched
- `pasteDepth` atomic logic, `emitPasteState`, or any edge-triggered transition — Phase 1 scope
- `hidrpc.go`, `internal/hidrpc/*`, `internal/usbgadget/*` — unrelated
- The 200 ms inter-macro sleep **value** — rename only, value preserved verbatim
- `CLAUDE.md`, `DEVELOPMENT.md`, `README.md`, `.github/workflows/`, `go.mod`, `package.json`, `package-lock.json`

### Frontend: `ui/src/utils/pasteMacro.ts`

#### 1. Named batch-stat interface with `sourceChars`

```typescript
export interface PasteBatchStat {
  stepCount: number;
  estimatedBytes: number;
  sourceChars: number;
}

export interface PasteMacroBatchResult {
  batches: MacroStep[][];
  invalidChars: string[];
  batchStats: PasteBatchStat[];
}
```

`sourceChars` is accumulated as the batcher iterates source characters (one increment per `for (const char of text)` iteration that produces at least one step in the current batch). Characters that cannot be mapped to keys (tracked in `invalidChars`) do not contribute to `sourceChars`.

#### 2. `LargePastePolicy` type and defaults

```typescript
export interface LargePastePolicy {
  autoThresholdChars: number;
  chunkChars: number;
  chunkPauseMs: number;
  // Floor for the per-chunk derived drain timeout. Actual per-chunk
  // timeout is computed at runtime from the chunk's step count and
  // batch count (see executePasteText), then max'd against this floor.
  chunkDrainTimeoutFloorMs: number;
}

export const DEFAULT_LARGE_PASTE_POLICY: LargePastePolicy = {
  autoThresholdChars: 5000,
  chunkChars: 5000,
  chunkPauseMs: 2000,
  chunkDrainTimeoutFloorMs: 60000,
};
```

Threshold, chunk size, and pause duration come directly from issue #38's "only documented-working setting." The drain-timeout floor is **not** a fixed timeout — it is only the lower bound for a runtime-derived per-chunk budget. The `chunkDrainTimeoutMs` field from an earlier draft of this spec used a flat 15 s value, which would fire prematurely for any reasonably sized chunk on the reliable profile: a 5 000-char chunk at reliable pacing (`keyDelayMs = 3`, byte-limited to ~66 steps/batch per `PASTE_PROFILES.reliable`) takes ~40 s of HID-layer execution (5 000 MacroSteps × 8 ms per step) plus ~15 s of inter-macro sleeps (~76 batches × 200 ms), i.e. ~55 s end-to-end. The derivation below accounts for this.

**Per-chunk drain-timeout derivation (computed inside `executePasteText`):**

```
chunkStepCount  = sum of batchStats[b].stepCount for b in [chunk.batchStartIndex, chunk.batchEndIndex)
chunkNumBatches = chunk.batchEndIndex - chunk.batchStartIndex
derivedDrainTimeoutMs
  = chunkStepCount  * 20   // ~10 ms per MacroStep × 2 safety margin (press 5 ms + reset up to 5 ms)
  + chunkNumBatches * 400  // 200 ms inter-macro sleep × 2 safety margin
  + 5000                    // flat slack
chunkDrainTimeoutMs = max(policy.chunkDrainTimeoutFloorMs, derivedDrainTimeoutMs)
```

Walkthrough for reliable profile, 5 000-char chunk, ~66 steps/batch:
- chunkStepCount ≈ 5 000 MacroSteps → 100 000 ms
- chunkNumBatches ≈ 76 → 30 400 ms
- + 5 000 ms slack
- derivedDrainTimeoutMs ≈ 135 400 ms (≈2.25 min)
- vs. measured worst case ~55 s → ~2.5× safety margin

Walkthrough for fast profile, 5 000-char chunk, ~152 steps/batch:
- chunkStepCount ≈ 5 000 MacroSteps → 100 000 ms
- chunkNumBatches ≈ 33 → 13 200 ms
- + 5 000 ms slack
- derivedDrainTimeoutMs ≈ 118 200 ms (≈2 min)
- vs. measured worst case ~40 s → ~3× safety margin

The floor (`60 000 ms`) only kicks in for very small chunks where the derivation would undershoot the minimum reasonable wait.

The constants `20`, `400`, and `5000` inside the derivation are tuned to the current Phase 1 pacing (`pasteInterMacroDrainMs = 200 ms`, `executeMacroRemote` press delay = 5 ms, reliable `keyDelayMs = 3`). If Phase 3a retunes any of those, this derivation must be re-checked. A comment in `executePasteText` calls this out.

#### 3. `partitionBatchesByChunkChars` pure helper

```typescript
export interface PasteChunkPlan {
  chunkIndex: number;         // 0-based
  batchStartIndex: number;    // inclusive
  batchEndIndex: number;      // exclusive
  sourceChars: number;        // sum of sourceChars for [start, end)
}

export function partitionBatchesByChunkChars(
  batchStats: PasteBatchStat[],
  chunkChars: number,
): PasteChunkPlan[]
```

Pure function: walks `batchStats`, accumulates `sourceChars`, emits a new chunk each time accumulation would exceed `chunkChars` (committing the current batch to the outgoing chunk before starting a new one — batch boundaries are respected, not split mid-batch). Guarantees:
- At least one chunk is returned if `batchStats` is non-empty.
- `sum(chunks[i].batchEndIndex - chunks[i].batchStartIndex) === batchStats.length`.
- Chunks are contiguous and cover all batches exactly once.

### Frontend: `ui/src/hooks/useKeyboard.ts`

#### 4. `abortableSleep` helper

```typescript
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

Module-level helper, not exported. Rejects on abort with a matching-shape error so `executePasteText`'s catch block treats it uniformly with the existing `waitForPasteDrain` rejection path.

#### 5. `PasteProgress` type extension

```typescript
export interface PasteProgress {
  completedBatches: number;
  totalBatches: number;
  phase: "sending" | "draining" | "pausing";  // was "sending" | "draining"
  chunkIndex: number;                          // NEW: 1-based, 0 when chunk mode off
  chunkTotal: number;                          // NEW: 0 when chunk mode off
}
```

`chunkTotal === 0` is the sentinel for "not in large-paste mode." The modal hides the chunk subline in that case so sub-threshold pastes are visually identical to today.

#### 6. Chunk-aware branch in `executePasteText`

Inside `executePasteText`, after `buildPasteMacroBatches` returns `batchStats`:

```typescript
const chunkMode = text.length >= DEFAULT_LARGE_PASTE_POLICY.autoThresholdChars;

if (!chunkMode) {
  // existing non-chunk path, unchanged:
  // - submit all batches with existing watermark flow control
  // - await waitForPasteDrain("bestEffort", drainTimeoutMs, signal)
  return;
}

const policy = DEFAULT_LARGE_PASTE_POLICY;
const chunks = partitionBatchesByChunkChars(batchStats, policy.chunkChars);

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  emitProgress({
    completedBatches: chunk.batchStartIndex,
    totalBatches: batches.length,
    phase: "sending",
    chunkIndex: i + 1,
    chunkTotal: chunks.length,
  });

  // Submit this chunk's batches, same watermark flow control as the non-chunk path.
  for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
    // identical to existing per-batch submission, including the
    // bufferedAmount high/low watermark await. This is the ONLY
    // place where the existing submission loop is reused.
  }

  onTrace?.({
    kind: "chunk-sent",
    chunkIndex: i + 1,
    chunkTotal: chunks.length,
    sourceChars: chunk.sourceChars,
    batches: chunk.batchEndIndex - chunk.batchStartIndex,
  });

  emitProgress({
    completedBatches: chunk.batchEndIndex,
    totalBatches: batches.length,
    phase: "pausing",
    chunkIndex: i + 1,
    chunkTotal: chunks.length,
  });

  // Per-chunk drain timeout derived from this chunk's actual work.
  let chunkStepCount = 0;
  for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
    chunkStepCount += batchStats[b].stepCount;
  }
  const chunkNumBatches = chunk.batchEndIndex - chunk.batchStartIndex;
  const derivedDrainTimeoutMs = chunkStepCount * 20 + chunkNumBatches * 400 + 5000;
  const chunkDrainTimeoutMs = Math.max(policy.chunkDrainTimeoutFloorMs, derivedDrainTimeoutMs);

  const drainStart = performance.now();
  await waitForPasteDrain("required", chunkDrainTimeoutMs, signal);
  onTrace?.({
    kind: "chunk-drained",
    chunkIndex: i + 1,
    drainMs: Math.round(performance.now() - drainStart),
  });

  if (i < chunks.length - 1) {
    onTrace?.({
      kind: "chunk-pause",
      chunkIndex: i + 1,
      pauseMs: policy.chunkPauseMs,
    });
    await abortableSleep(policy.chunkPauseMs, signal);
  }
}

emitProgress({
  completedBatches: batches.length,
  totalBatches: batches.length,
  phase: "draining",
  chunkIndex: chunks.length,
  chunkTotal: chunks.length,
});

const finalDrainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
await waitForPasteDrain("bestEffort", finalDrainTimeoutMs, signal);
```

The final `bestEffort` drain wait is preserved — the last chunk's `required` drain establishes "all batches acked at the HID layer," and the final `bestEffort` settle gives a short grace window for any late cleanup without failing the whole paste on a minor timing hiccup.

The non-chunk path is **literally unchanged** — the `if (!chunkMode)` early-return returns control to the existing submission loop, which is preserved verbatim. Phase 2 does not refactor the existing submission code.

#### 7. Trace event shapes

Three new additive trace kinds (existing batch traces unchanged):
```typescript
type PasteExecutionTrace =
  | { kind: "batch"; batchIndex: number; totalBatches: number; stepCount: number; estimatedBytes: number; bufferedAmount: number }
  | { kind: "chunk-sent"; chunkIndex: number; chunkTotal: number; sourceChars: number; batches: number }
  | { kind: "chunk-drained"; chunkIndex: number; drainMs: number }
  | { kind: "chunk-pause"; chunkIndex: number; pauseMs: number };
```

The existing trace type is currently an object; Phase 2 migrates it to a discriminated union. `PasteModal.tsx`'s trace formatter gets a `switch` on `kind` to render each case.

### Frontend: `ui/src/components/popovers/PasteModal.tsx`

#### 8. Phase label and chunk subline

Existing phase rendering gets a new entry:
```typescript
const phaseLabel = {
  sending: "Sending…",
  draining: "Finishing…",
  pausing: "Pausing to let target catch up…",
}[pasteProgress.phase];
```

A subline renders only when `chunkTotal > 0`:
```typescript
{pasteProgress.chunkTotal > 0 && (
  <span className="text-xs text-slate-500">
    Chunk {pasteProgress.chunkIndex}/{pasteProgress.chunkTotal}
  </span>
)}
```

Below-threshold pastes see `chunkTotal === 0` and render identically to today.

#### 9. Trace formatter update

Existing trace append:
```typescript
onTrace: trace => {
  setTraceLines(prev => [...prev, `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} buffered=${trace.bufferedAmount}`]);
}
```

Replaced with a `switch` on `trace.kind` that emits:
- `batch ${i}/${N}: steps=... bytes=... buffered=...` (existing shape preserved)
- `chunk ${i}/${N} sent: chars=${sourceChars} batches=${batches}`
- `chunk ${i} drained in ${drainMs}ms`
- `chunk ${i} pause ${pauseMs}ms`

### Backend: `jsonrpc.go`

#### 10. Rename 200 ms literal to named constant

```go
// pasteInterMacroDrainMs is the inter-macro pause inside drainMacroQueue that
// gives the host USB input queue time to consume pending reports between
// consecutive macros. PR #41 load-bearing fix; do not retune without a
// dedicated profiling PR. Phase 2 adds chunk-boundary pauses on top of this
// delay, not instead of it.
const pasteInterMacroDrainMs = 200 * time.Millisecond
```

Single call site updated:
```go
time.Sleep(pasteInterMacroDrainMs)
```

No other change to `drainMacroQueue`. No behavior change whatsoever.

## Correctness invariants

The following invariants must hold after Phase 2 lands:

1. **IsPaste is preserved end-to-end** — already landed in Phase 1; Phase 2 must not introduce any code path that drops or overrides the flag.
2. **Non-paste macros do not toggle `isPasteInProgress`** — already landed in Phase 1; Phase 2's chunk loop only runs inside a paste and must not emit state on behalf of non-paste work.
3. **Chunk boundaries use `required` drain mode that rejects on timeout** — Phase 2's only new consumer of `required`. A required-drain rejection must propagate out of `executePasteText` so the modal displays an error, not silently succeed.
4. **Chunk boundaries align to real batch edges** — `partitionBatchesByChunkChars` commits batches whole and never splits a batch mid-way. There is no second Unicode-splitting path in Phase 2.
5. **The 200 ms inter-macro delay in `drainMacroQueue` is preserved verbatim** — rename only, value unchanged, no retuning in this PR.
6. **Cancel works during chunk send, chunk pause, and required drain** — all three await points subscribe to the same `signal`. The existing cleanup path in `executePasteText`'s catch/finally covers all three cases uniformly.
7. **Trace output shows chunk boundaries, drain waits, and pause timing** — three new trace kinds, additive to existing batch traces.
8. **Sub-threshold pastes (text.length < autoThresholdChars) take the non-chunk path exactly as today** — chunk-mode branch is guarded by an early test; the non-chunk path is unchanged byte-for-byte.
9. **Flow control watermark values and low-watermark drain-resume behavior are preserved** — batch submission inside the chunk loop reuses the same per-batch submission code as the non-chunk path, and the numeric watermark values are unchanged. Phase 2 additively wires the existing `waitForChannelDrain` helper to respect `signal.abort()`, so cancel during a high-watermark pause rejects immediately instead of waiting for the channel to drain naturally. This is additive — the non-abort resume path still fires on `bufferedamountlow` exactly as before.

## Race walkthroughs

### Race A: Cancel fires during chunk-send phase (including during a `bufferedamountlow` pause)
- User clicks cancel while chunk `i` is still submitting batches inside the inner `for` loop.
- **Sub-case A1 — cancel between batch submissions:** the loop's top-of-iteration `if (signal?.aborted) throw` fires on the next iteration.
- **Sub-case A2 — cancel while the loop is paused on `waitForChannelDrain()`** (the `bufferedamountlow` wait triggered when `channel.bufferedAmount >= PASTE_HIGH_WATERMARK`): **this is the load-bearing case.** In pre-Phase-2 `main`, `waitForChannelDrain` is a plain `new Promise(r => { drainResolve = r; })` with no abort wiring, so `signal.abort()` does **not** immediately unblock the wait. The wait resumes only when the channel buffer actually drains (via the persistent `onLow` listener), which may be seconds later — during that window, cancel is effectively delayed.
- **Phase 2 fix:** `executePasteText` gains a paired `drainReject` slot and an `onBufferedDrainAbort` listener wired to `signal`. When `signal.abort()` fires while `drainResolve`/`drainReject` are pending, the listener rejects the pending promise with `Error("Paste execution aborted")` and clears both slots. The persistent `onLow` listener and the abort listener are both removed in the `finally` block alongside the threshold restore. This makes cancel during a high-watermark wait behave identically to cancel during any other phase — immediate rejection.
- `executePasteText`'s catch block runs, removes listeners, the frontend's existing `cancelOngoingKeyboardMacroHidRpc` fires against the backend.
- Backend `cancelAndDrainMacroQueue` sweeps queued macros, decrements `pasteDepth`, emits `State:false` on 1→0 transition.
- Frontend sees `isPasteInProgress → false`; modal resets.
- **No chunk-boundary state is leaked** because Phase 2's chunk state lives entirely in local variables inside `executePasteText`, not in any store.

### Race B: Cancel fires during `waitForPasteDrain("required", ...)`
- Drain wait is subscribed to `signal` via its internal `onAbort` listener (Phase 1, line 168).
- `signal.abort()` → `onAbort()` → `rejectErr(new Error("Paste execution aborted"))`.
- `executePasteText`'s catch block handles it identically to Race A.

### Race C: Cancel fires during `abortableSleep`
- `abortableSleep` is subscribed to `signal` in its own Promise constructor.
- `signal.abort()` → `onAbort()` → `clearTimeout` + `reject(new Error("aborted"))`.
- `executePasteText`'s catch block handles it identically to Race A.

### Race D: `waitForPasteDrain("required", ...)` times out mid-paste
- The required-drain timeout fires. The timeout is derived per chunk (see "Per-chunk drain-timeout derivation" above): for a typical reliable-profile 5 000-char chunk this is ~135 s; for a small chunk, the floor (`chunkDrainTimeoutFloorMs = 60000`) applies.
- `waitForPasteDrain` rejects with `Error(\`waitForPasteDrain: required drain timed out after ${chunkDrainTimeoutMs}ms\`)`.
- `executePasteText`'s catch block runs the normal cleanup.
- Backend continues processing queued batches (no backend cancel fires because the frontend didn't explicitly abort — the timeout is a frontend-local decision that "this paste is unsafe to continue").
- **Known gap:** trailing batches that were already in `macroQueue` will still execute on the target after the error surfaces. Issue #38 documents this as the "post-cancel trailing batches" protocol gap, explicitly out of Phase 2 scope. Phase 2 does not introduce this gap; it pre-exists in the cancel path today.
- Modal displays the error; user decides whether to retry.
- **Why the derivation is needed:** an earlier draft of this spec used a flat 15 000 ms timeout. Against the actual reliable-profile pacing on current `main` (5 ms press + 3 ms reset = 8 ms per MacroStep; 200 ms inter-macro sleep; ~66 steps per byte-limited batch), a 5 000-char chunk takes ~55 s of backend work, so a 15 s timeout would fire on every chunk boundary of every large paste. The derived timeout gives each chunk ~2× its measured worst case.

### Race E: `isPasteInProgress` transitions happen faster than the subscriber can see them
- Phase 1 already handled this with `seenTrue` latching (lines 146–160 in `waitForPasteDrain`). A 0 → 1 → 0 sequence that completes before the subscription arms will still resolve the drain wait because `required` mode waits for the arm window + transition cycle.
- Phase 2 relies on Phase 1's latching behavior; no new race surface.

### Race F: Backend drains the entire chunk before `waitForPasteDrain("required")` arms
- The backend emits `State:false` on 1→0 transition of `pasteDepth`, which only drops to 0 when the queue is empty and all in-flight macros have completed.
- `waitForPasteDrain("required", ...)` in Phase 1 does not arm a grace window (that's `bestEffort`-only). If the helper subscribes after `pasteDepth` has already returned to 0, the `seenTrue` latch cannot fire and the helper waits the full derived `chunkDrainTimeoutMs` before rejecting.
- The risk exists in principle whenever the backend can drain a chunk faster than the frontend can create the next await.
- **Practical analysis:** a chunk is `chunkChars = 5000` source chars, which at ≤ 64 steps per batch and ≈60 chars worth of keypress/release steps per batch is roughly 80 batches. Each macro execution in `drainMacroQueue` runs at minimum `pasteInterMacroDrainMs = 200ms` of inter-macro sleep plus the HID write loop for its steps (~5 ms press + 3 ms release per step — on the order of hundreds of ms for a single macro). Lower bound for the backend to drain 80 batches is **tens of seconds**. The frontend, in contrast, spends microseconds of synchronous JS between the last `dataChannel.send()` of the chunk and the `await waitForPasteDrain("required", ...)` line — the two are separated only by a synchronous `emitProgress` call and a `performance.now()`.
- **Conclusion:** the backend cannot drain a full chunk in the microseconds the frontend takes to arm the drain wait. The race is theoretically present but cannot fire under realistic pacing. If future profile retuning (Phase 3a) ever shrinks per-macro latency dramatically, this invariant must be re-verified; until then, Phase 2 relies on the ≫ ratio between backend drain time and frontend arming time.
- **Defensive fallback:** if this race ever does fire, the symptom is a 15-second pause at a chunk boundary followed by a required-drain-timeout error. The user can cancel at any point during the pause; the rest of the paste is unaffected because the aborted paste rolls back via the existing cancel path. No data corruption is possible from this race — only a spurious error surfaced to the user.

## Test plan

Phase 2 is nearly pure frontend; backend is cosmetic rename only.

### Static verification

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
cd .. && go build ./... && go vet ./...
```

- `tsc --noEmit` must pass on `useKeyboard.ts`, `pasteMacro.ts`, `PasteModal.tsx`
- `eslint` must pass on all touched `.ts` / `.tsx` files (note: pre-existing prettier/CRLF drift on main is known per CLAUDE.md; Phase 2 must not *expand* the drift footprint)
- `go build ./...` must pass (the rename is a 2-line change)
- `go vet ./...` must pass

### Compile-only Go gate (buildkit cross-compile workaround)

```bash
go test -c -o /dev/null ./
```

Run for the root `kvm` package (where `jsonrpc.go` lives). The change is scoped to one file and one function; no other packages affected.

### Manual on-device verification

Deploy to the dev device (192.168.1.36) via persistent install mode so the build survives SSH drops:
```bash
./dev_deploy.sh -r 192.168.1.36 -i --skip-native-build
```

Run these manual tests on the device against a target machine:

1. **Sub-threshold paste (1 000 chars)** — UI unchanged, no chunk subline, no `"pausing"` label. Existing behavior preserved.
2. **32k-char paste** — visible `Chunk X/Y` subline counting up, `"pausing"` label visible between chunks. No character corruption on the target.
3. **100k-char paste** — same as above, many chunks. No character corruption under normal target-machine load.
4. **100k-char paste under target-machine load** — open several applications on the target to induce CPU/USB contention. Correctness maintained; some chunks may take longer but required drain should not time out against the derived per-chunk timeout (≈2× the measured worst-case drain time for each chunk).
5. **Cancel during chunk send** — click cancel while submission is mid-chunk. Modal resets, paste stops.
6. **Cancel during chunk pause** — click cancel while `"pausing…"` is visible. Modal resets, paste stops.
7. **Cancel during required drain** — click cancel while waiting for a chunk drain (harder to time; may need a large paste with a slow target). Modal resets, paste stops.
8. **Trace log inspection** — open the debug trace panel, verify all three new trace kinds appear in the expected order.
9. **Non-paste macro regression check** — use a button binding (e.g., Ctrl+Alt+Del) while no paste is in progress. Confirm `isPasteInProgress` does not toggle (Phase 1 invariant preserved).

### Acceptance gates

From issue #38's "Suggested acceptance criteria":

- [ ] 32k and 100k file-backed pastes complete without corruption in a simple editor and the problematic target app
- [ ] Cancel works correctly during sending, during chunk pause, and during final drain
- [ ] Non-paste macros (button bindings, custom macros) no longer toggle `isPasteInProgress` (Phase 1 regression check)
- [ ] Chunk-boundary timeout surfaces as a real failure (not silent success)
- [ ] Trace output clearly shows chunk boundaries, drain waits, and pause timing
- [ ] `IsPaste` flag is preserved end-to-end (Phase 1 regression check)

## Rollout and rollback

### Rollout

Single PR against `main`, closes #38. Merge after in-house review + oracle cross-review + codex cross-review all pass.

### Rollback

Each task in the plan commits atomically; rollback is per-commit via `git revert <sha>`. The chunk loop is gated behind `text.length >= autoThresholdChars`, so a partial rollback can be achieved by setting `autoThresholdChars = Number.MAX_SAFE_INTEGER` as a hotfix to force all pastes onto the non-chunk path without touching the chunk loop code. This is a one-line change if needed.

### Downstream impact

- **Phase 3a (#40, paste profile retuning):** unblocked by Phase 2. Profile retuning is independent of chunk accounting.
- **Phase 3b (#43, timer reuse in `drainMacroQueue`):** unblocked by Phase 2. The `pasteInterMacroDrainMs` named constant makes the target site obvious.
- **Phase 4 (#44, timed-sequence HID writer):** unblocked by Phase 2. Independent subsystem.
- **Phase 5 (#45, vitest harness):** unblocked by Phase 2. The new `partitionBatchesByChunkChars` pure helper will be an obvious first test target when the harness lands.
