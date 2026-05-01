# First-Paste Chunk Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #58 so the first large paste in a fresh modern browser session uses Phase 2 chunk-aware drain boundaries without regressing legacy firmware.

**Architecture:** `executePasteText` will optimistically use chunk mode for large RPC HID pastes unless a session-local negative latch says paste-state support is absent. The first chunk runs a short paste-start probe before the existing required drain. If the probe times out, the paste falls back in-place to the existing non-chunk remainder path and future large pastes in the same JS session skip probing.

**Tech Stack:** TypeScript 5 / React 18, Zustand store, WebRTC data channel for HID RPC.

**Spec:** `docs/superpowers/specs/2026-04-24-first-paste-chunk-probe-design.md`

---

## Scope

**Modify:**
- `ui/src/hooks/useKeyboard.ts`
- `docs/superpowers/specs/2026-04-24-first-paste-chunk-probe-design.md`
- `docs/superpowers/plans/2026-04-24-first-paste-chunk-probe.md`

**Avoid unless a direct conflict appears:**
- `ui/src/utils/pasteMacro.ts`

**Forbidden:**
- Go files
- `package.json`
- `package-lock.json`
- `ui/src/components/popovers/PasteModal.tsx`

## Task 1: Add Session Capability State and Probe Helper

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts`

- [ ] Add a probe timeout constant near the existing paste drain constants:

```typescript
const PASTE_STATE_SUPPORT_PROBE_TIMEOUT_MS = 2000;
```

- [ ] Extend the module-level latch block:

```typescript
let executePasteTextInFlight = false;
let pasteStateSupportObserved = false;
let pasteStateSupportNegativeLatched = false;
```

- [ ] In the `KeyboardMacroStateMessage` handler, set
  `pasteStateSupportNegativeLatched = false` whenever a real paste-state event
  sets `pasteStateSupportObserved = true`.

- [ ] Add `waitForPasteStartProbe(timeoutMs, signal?)` near `waitForPasteDrain`. It must subscribe before sampling, resolve `true` on any `isPasteInProgress=true`, resolve `false` on timeout, and reject with `Error("Paste execution aborted")` on abort.

## Task 2: Loosen Chunk Eligibility

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts`

- [ ] Replace the old `pasteStateSupportObserved` chunk gate with:

```typescript
let chunkMode =
  rpcHidReady &&
  !pasteStateSupportNegativeLatched &&
  text.length >= policy.autoThresholdChars;
```

- [ ] Make `chunks` and `chunkTotalForProgress` mutable so fallback can switch progress to non-chunk:

```typescript
let chunks: PasteChunkPlan[] = chunkMode
  ? partitionBatchesByChunkChars(batchStats, policy.chunkChars)
  : [{ chunkIndex: 0, batchStartIndex: 0, batchEndIndex: batches.length, sourceChars: text.length }];
let chunkTotalForProgress = chunkMode ? chunks.length : 0;
```

## Task 3: Probe After the First Dispatched Batch

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts`

- [ ] Add local per-paste state after chunk planning:

```typescript
let pasteStateSupportProvenForPaste = pasteStateSupportObserved;
let pasteStartProbeOutcome: Promise<
  { supported: boolean } | { error: Error }
> | null = null;
```

- [ ] In the first chunk's batch loop, arm the probe immediately before dispatching the first paste batch when chunk mode is active and support is not already proven:

```typescript
if (chunkMode && !pasteStateSupportProvenForPaste && pasteStartProbeOutcome === null) {
  pasteStartProbeOutcome = waitForPasteStartProbe(
    PASTE_STATE_SUPPORT_PROBE_TIMEOUT_MS,
    signal,
  ).then(
    supported => ({ supported }),
    error => ({
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );
}
```

- [ ] After that batch has been sent and progress has been emitted, await the handled probe outcome:

```typescript
if (pasteStartProbeOutcome !== null && !pasteStateSupportProvenForPaste) {
  const probeResult = await pasteStartProbeOutcome;
  pasteStartProbeOutcome = null;
  if ("error" in probeResult) {
    throw probeResult.error;
  }
  if (probeResult.supported) {
    pasteStateSupportProvenForPaste = true;
  } else {
    if (!pasteStateSupportObserved) {
      pasteStateSupportNegativeLatched = true;
    }
    chunkMode = false;
    chunkTotalForProgress = 0;
    const remainingBatchStartIndex = b + 1;
    if (remainingBatchStartIndex < batches.length) {
      let remainingSourceChars = 0;
      for (let rb = remainingBatchStartIndex; rb < batches.length; rb++) {
        remainingSourceChars += batchStats[rb].sourceChars;
      }
      chunks = [
        {
          chunkIndex: 0,
          batchStartIndex: remainingBatchStartIndex,
          batchEndIndex: batches.length,
          sourceChars: remainingSourceChars,
        },
      ];
    } else {
      chunks = [];
    }
    ci = -1;
    break;
  }
}
```

- [ ] Gate chunk-boundary required drains on both `chunkMode` and `pasteStateSupportProvenForPaste` so legacy firmware never reaches a long required timeout.

- [ ] Ensure fallback starts from `b + 1`, not batch zero, so text is not duplicated and the remainder is not skipped.

- [ ] Reset the loop index to `-1` before breaking so the `for` loop increment moves to the remaining non-chunk segment at index zero.

## Task 4: Preserve Existing Drain and Abort Behavior

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts`

- [ ] Leave `PASTE_LOW_WATERMARK` and `PASTE_HIGH_WATERMARK` values unchanged.
- [ ] Leave the high-watermark abort listener unchanged.
- [ ] Leave chunk required drain timeout derivation unchanged.
- [ ] Leave final `waitForPasteDrain("bestEffort", ...)` in place for both chunk and fallback paths.
- [ ] Do not touch non-paste macro execution.

## Task 5: Verify

**Files:**
- Read only unless verification reveals a direct issue.

- [ ] Run:

```powershell
cd ui
npx tsc --noEmit
```

- [ ] Run:

```powershell
cd ui
npx eslint './src/**/*.{ts,tsx}'
```

- [ ] If local ESLint reports CRLF prettier drift in pre-existing files, confirm it is the AGENTS.md-known Windows artifact and report it without broad formatting churn.

## Manual Device Checks

These require a JetKVM device and are not expected to run locally in this phase:

- Fresh browser tab, modern firmware, paste >5000 chars: `Chunk 1/N` appears on the first paste and required drains complete.
- Same tab, second paste >5000 chars: chunk mode remains immediate.
- Legacy/no-paste-state firmware simulation: first large paste probes for about 2 seconds, silently falls back, and later large pastes skip the probe.
- Cancel during the first probe aborts immediately and does not set the negative latch.
