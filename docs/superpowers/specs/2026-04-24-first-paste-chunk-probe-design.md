# First-Paste Chunk Probe Design

**Issue:** #58, "bug: First paste of every session bypasses Phase 2 chunk-aware safety net (pasteStateSupportObserved gate)"
**Date:** 2026-04-24
**Branch:** `fix/phase-3c-first-paste-chunk-probe`
**Approach:** Oracle Option B, split-phase first-chunk capability probe.

## Problem

Phase 2's large-paste safe mode only enables chunk mode when
`pasteStateSupportObserved` is already true. That module-level latch flips when
the frontend observes a `KeyboardMacroStateMessage` with `isPaste=true`.

This protects legacy firmware, but it also means the first large paste in every
fresh browser session cannot use chunk mode. On modern firmware, that first
large paste should have the same required drain boundaries as later large
pastes.

The current gate is:

```typescript
const chunkMode =
  rpcHidReady &&
  pasteStateSupportObserved &&
  text.length >= policy.autoThresholdChars;
```

Root cause: the frontend treats "not observed yet" and "not supported" as the
same state. A fresh modern session starts in "not observed yet", so it takes the
legacy non-chunk path for the entire first large paste.

## Goals

- First large paste on modern firmware enters chunk mode immediately.
- The first chunk uses a short probe, about 2 seconds, to observe the first
  `isPasteInProgress=true` state.
- If paste state support is observed, normal chunk required drains continue.
- If the probe times out, chunk mode silently disables for the rest of that
  paste and a session-local negative latch prevents future probes.
- Legacy firmware gets no user-visible error and falls back to the existing
  non-chunk flow after paying the probe cost once per JS session.
- No localStorage, backend capability bit, or pre-flight character probe.

## Non-Goals

- Do not change Go code or Phase 1 paste-depth semantics.
- Do not alter `buildPasteMacroBatches()` or the `estimateBatchBytes()` formula.
- Do not retune paste profiles, watermarks, chunk sizes, queue depths, or the Go
  200 ms inter-macro drain.
- Do not add a frontend test harness; that remains Phase 5.

## Design

Keep the implementation in `ui/src/hooks/useKeyboard.ts`.

Add a module-level negative latch:

```typescript
let pasteStateSupportNegativeLatched = false;
```

The positive latch, `pasteStateSupportObserved`, remains the source of truth
once any real paste-state event arrives. The negative latch is only set after a
large-paste probe times out in this JS session.
If a paste-state event arrives later in the same session, positive evidence
clears the negative latch.

Chunk eligibility becomes:

```typescript
let chunkMode =
  rpcHidReady &&
  !pasteStateSupportNegativeLatched &&
  text.length >= policy.autoThresholdChars;
```

This lets modern firmware use chunk mode on the first large paste while still
skipping chunk mode on legacy firmware after one failed probe.

Add a small helper that waits only for paste start, not full drain:

```typescript
async function waitForPasteStartProbe(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
```

The helper subscribes before sampling `useHidStore.getState()`, resolves `true`
when `isPasteInProgress` is true, resolves `false` on timeout, and rejects
immediately on abort. The abort error message should match the rest of the
paste path: `"Paste execution aborted"`.

During the chunk loop, arm the probe immediately before dispatching the first
paste batch when `pasteStateSupportObserved` is still false. After that first
batch is sent, await the handled probe outcome. If it resolves true, continue
into the existing required drain logic. If it resolves false, set
`pasteStateSupportNegativeLatched = true` only if no paste-state evidence has
arrived, switch `chunkMode` to false for the current paste, switch progress
chunk fields to zero, and continue sending only the remaining batches from the
existing chunked plan.

Fallback must not resend already-sent batches. The loop should preserve the
current `completedBatches` position and rebuild the remaining work as one
non-chunk segment from the next unsent batch index through `batches.length`.

## User Experience

Modern firmware:

- First large paste shows `Chunk 1/N` immediately.
- First chunk probe should complete as soon as the backend emits paste start.
- Required drain boundaries remain active for the first and later chunks.

Legacy firmware:

- First large paste may show chunk progress briefly during the first chunk.
- After about 2 seconds with no paste-state start, the paste silently continues
  on the existing non-chunk path.
- Later large pastes in the same tab skip chunk mode immediately.

## Risks

The main correctness risk is fallback after some batches have already been sent.
If fallback restarts from batch zero, it duplicates text. If it waits for a
required drain after the probe already proved no paste-state events are
available, it reintroduces the legacy timeout failure. The implementation must
continue from the next unsent batch and use only the final best-effort drain on
the fallback path.

The secondary risk is abort responsiveness. The new probe must listen to the
existing `AbortSignal`; cancel during the probe must reject immediately and must
not set the negative latch.

## Acceptance Criteria

- Fresh-session first paste over `autoThresholdChars` enters chunk mode when
  `rpcHidReady` is true and no negative latch has been set.
- The first chunk probes for paste-state start with a short deadline around
  2 seconds.
- Probe success preserves normal required drain boundaries.
- Probe timeout disables chunk mode for only the current paste remainder and
  latches the no-support result for the JS session.
- Abort during channel drain, probe, chunk drain, chunk pause, or final drain
  remains immediate.
- `ui/src/utils/pasteMacro.ts` remains untouched unless a small pure helper is
  proven necessary.
- Verification runs:
  `cd ui && npx tsc --noEmit`
  `cd ui && npx eslint './src/**/*.{ts,tsx}'`
