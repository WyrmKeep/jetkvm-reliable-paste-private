# Large-Paste Safe Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 2 of the JetKVM paste reliability rollout (#38): large-paste safe mode with chunk-aware submission, true drain boundaries between chunks, and abortable inter-chunk pauses. Phase 1's `waitForPasteDrain("required", ...)` helper gets its first consumer.

**Architecture:** A chunk-aware loop inside `executePasteText` partitions batches by a source-character budget and waits for the backend to fully drain (`waitForPasteDrain("required", ...)`) before a short abortable pause between chunks. Chunk accounting lives in `pasteMacro.ts` next to the batcher; `batchStats` gains a `sourceChars` field so the frontend can partition without a second Unicode-splitting path. The existing non-chunk path is preserved as a single-chunk edge case of the same loop. One cosmetic backend rename makes the 200ms inter-macro drain delay in `drainMacroQueue` a named constant.

**Tech Stack:** TypeScript 5 / React 18, Zustand store, WebRTC data channel for HID RPC, Go 1.24 on the backend.

**Spec:** `docs/superpowers/specs/2026-04-11-large-paste-safe-mode-design.md` — required reading before starting any task.

**Branch:** `feat/large-paste-safe-mode` (already cut from `main`; spec already committed).

---

## Scope and verification constraints

**Touch list (the ONLY files this plan modifies):**
- `ui/src/utils/pasteMacro.ts`
- `ui/src/hooks/useKeyboard.ts`
- `ui/src/components/popovers/PasteModal.tsx`
- `jsonrpc.go`

**Forbidden files (do NOT touch in any task):**
- `ui/src/utils/pasteBatches.ts` — profile retuning is Phase 3a scope (#40)
- Any backend queue depth or `queuedMacro` struct change — Phase 1 scope, already landed
- `estimateBatchBytes` formula in `pasteMacro.ts` — already correct per CLAUDE.md
- `pasteDepth` atomic logic, `emitPasteState`, or edge-triggered transition code in `jsonrpc.go` — Phase 1 scope
- `hidrpc.go`, `internal/hidrpc/*`, `internal/usbgadget/*` — unrelated
- The 200ms inter-macro sleep **value** — rename only, value preserved verbatim (Task 6)
- `PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK` numeric values, and the low-watermark resume behavior (`bufferedamountlow` → `onLow` resolves pending drain promise) in `useKeyboard.ts` — #46's work, values preserved exactly. **Phase 2 additively** adds a `drainReject` slot and an `onBufferedDrainAbort` listener so cancel during a high-watermark pause rejects immediately instead of waiting for the channel to drain naturally. This is a correctness fix required by Oracle's Phase 2 review; it does not change any numeric watermark value or the low-watermark resume path.
- `CLAUDE.md`, `DEVELOPMENT.md`, `README.md`, `.github/workflows/`, `go.mod`, `package.json`, `package-lock.json`

**Verification model (no unit test framework in this repo):**
- Frontend: `cd ui && npx tsc --noEmit` and `cd ui && npx eslint './src/**/*.{ts,tsx}'`
- Backend: `go build ./...` and `go vet ./...`
- Compile-only Go gate for the root package: `go test -c -o /dev/null ./` (buildkit cross-compile workaround)
- **Known gotcha**: `ui-lint` CI has been failing on main since 2026-03-15 with pre-existing prettier/CRLF drift in `Button.tsx`, `PasteModal.tsx`, `pasteMacro.ts`, `stores.ts`. Phase 2 must not **expand** the drift footprint. If an edit introduces new prettier warnings on lines Phase 2 didn't touch, that's a false positive from the local `core.autocrlf=true` artifact — confirm via `git cat-file -p HEAD:<file> | tr -d -c '\r' | wc -c` → 0.
- Runtime on-device testing is POST-merge per CLAUDE.md; do not try to run the debug binary from the plan.

**Commit convention:** `type(scope): description (#38)` where `type ∈ {fix, feat, refactor, perf, docs, test}` and `scope ∈ {paste, ui, hid}`. Every commit ends with:

```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

**Never use `--no-verify`, `--amend`, or force-push.** If a hook fails, fix the underlying issue and create a new commit. Commits are one per plan task, not one per sub-step.

---

## Verified facts (grepped against current `main`)

These were confirmed by reading the files directly and are used throughout the plan:

- `buildPasteMacroBatches` at `ui/src/utils/pasteMacro.ts:105-162` — iterates `for (const char of text)` with `char.normalize("NFC")`, batches via `flushBatch()` closure. Each source char maps to 1–3 `MacroStep`s depending on accent/deadkey.
- `batchStats` shape at `ui/src/utils/pasteMacro.ts:24-28` is currently `Array<{ stepCount: number; estimatedBytes: number }>` — anonymous object type in the return type.
- `estimateBatchBytes(stepCount)` at `ui/src/utils/pasteMacro.ts:30-36` returns `6 + stepCount * 18`. **Do not touch this formula.**
- `PasteExecutionProgress` at `ui/src/hooks/useKeyboard.ts:40-43`: `{ completedBatches: number; totalBatches: number }` — no phase field.
- `PasteExecutionTrace` at `ui/src/hooks/useKeyboard.ts:45-51`: single object shape `{ batchIndex, totalBatches, stepCount, estimatedBytes, bufferedAmount }` — NOT yet a discriminated union.
- `waitForPasteDrain` helper at `ui/src/hooks/useKeyboard.ts:93-197` — Phase 1 landed both `"required"` and `"bestEffort"` modes. The `"required"` branch rejects on timeout at line 172 with `Error(\`waitForPasteDrain: required drain timed out after ${timeoutMs}ms\`)`. It does **not** arm a grace window in `"required"` mode (arm window is `"bestEffort"`-only at lines 184–195).
- `executePasteText` at `ui/src/hooks/useKeyboard.ts:539-624` — single linear batch loop followed by final `waitForPasteDrain("bestEffort", drainTimeoutMs, signal)` call at line 617. Flow control watermarks at lines 565–566 (`PASTE_LOW_WATERMARK = 64 * 1024`, `PASTE_HIGH_WATERMARK = 256 * 1024`). `useCallback` deps array at line 623 is `[executePasteMacro, rpcHidChannel]`. **Preserve this deps array — Phase 2 adds no new hook deps because `abortableSleep`, `DEFAULT_LARGE_PASTE_POLICY`, `partitionBatchesByChunkChars`, and `waitForPasteDrain` are all module-level.**
- `executePasteText` cleanup at lines 618–621 removes the `bufferedamountlow` listener and restores `bufferedAmountLowThreshold`. The `try/finally` is the ONLY place this cleanup happens — Phase 2's chunk loop runs inside the same try block.
- `executePasteText` already imports `buildPasteMacroBatches` and `estimateBatchBytes` from `pasteMacro.ts` at lines 20–24.
- `PasteModal.tsx` state at line 42: `useState<{ completed: number; total: number; phase: "sending" | "draining" } | null>(null)`. Progress mapping at lines 111–116 derives `phase` from `completedBatches === totalBatches ? "draining" : "sending"`.
- `PasteModal.tsx` trace formatter at lines 118–123 appends `\`batch ${trace.batchIndex}/${trace.totalBatches}: steps=... bytes=... buffered=...\``.
- `PasteModal.tsx` progress rendering at lines 306–312 conditionally shows `pasteProgress` as two possible strings based on `phase`.
- `drainMacroQueue` at `jsonrpc.go:1097-1140` has the 200ms literal at line 1138 (`time.Sleep(200 * time.Millisecond)`). The comment block at lines 1134–1137 already explains the load-bearing nature; Phase 2 just extracts the value to a named constant.
- `macroQueueDepth` at `jsonrpc.go:1015` is the Phase 1 precedent for a named paste-related constant. Place `pasteInterMacroDrainMs` in the same `const` / `var` block area.

---

## File structure after this plan

- `ui/src/utils/pasteMacro.ts` — adds `PasteBatchStat` named interface, `sourceChars` accumulation, `LargePastePolicy` + `DEFAULT_LARGE_PASTE_POLICY`, `PasteChunkPlan`, `partitionBatchesByChunkChars`
- `ui/src/hooks/useKeyboard.ts` — adds `abortableSleep` helper; migrates `PasteExecutionTrace` to discriminated union; extends `PasteExecutionProgress` with `phase`/`chunkIndex`/`chunkTotal`; rewrites `executePasteText` body to use a chunk-aware outer loop
- `ui/src/components/popovers/PasteModal.tsx` — updates `pasteProgress` state shape; switches trace formatter to discriminated union; adds phase label map + chunk subline
- `jsonrpc.go` — adds `pasteInterMacroDrainMs` named constant, replaces single literal usage

All four files already exist. Phase 2 creates zero new files.

---

## Task dependency order

- **Task 1** is independent (pasteMacro.ts addition).
- **Task 2** depends on Task 1 (uses `PasteBatchStat`).
- **Task 3** is independent (useKeyboard.ts addition, no new deps).
- **Task 4** is independent (type migration + modal trace formatter).
- **Task 5** depends on Tasks 1–4 (uses `LargePastePolicy`, `partitionBatchesByChunkChars`, `abortableSleep`, discriminated trace type).
- **Task 6** is independent (backend rename only).

Recommended execution order: **1 → 2 → 3 → 4 → 5 → 6**. Task 6 may be executed in parallel with any earlier task if desired; it touches only `jsonrpc.go`.

---

## Task 1: Add `sourceChars` accumulation to `batchStats`

**Files:**
- Modify: `ui/src/utils/pasteMacro.ts:24-28` (interface type)
- Modify: `ui/src/utils/pasteMacro.ts:105-162` (batcher function)

**Rationale:** Phase 2's chunk loop partitions batches by a source-character budget. The batcher is the only place that knows how many source characters contributed to each batch. Exposing it as a named field on `batchStats` avoids re-iterating the source string in the frontend hook.

- [ ] **Step 1.1:** Add the `PasteBatchStat` named interface and update `PasteMacroBatchResult` to reference it.

Replace lines 24–28 in `ui/src/utils/pasteMacro.ts`:

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

- [ ] **Step 1.2:** Accumulate `sourceChars` inside `buildPasteMacroBatches` and commit it in `flushBatch`.

Replace the body of `buildPasteMacroBatches` (lines 111–162) with:

```typescript
): PasteMacroBatchResult {
  if (maxStepsPerBatch <= 0) {
    throw new Error("maxStepsPerBatch must be greater than zero");
  }
  if (maxBytesPerBatch <= 0) {
    throw new Error("maxBytesPerBatch must be greater than zero");
  }

  const batches: MacroStep[][] = [];
  const batchStats: PasteBatchStat[] = [];
  const invalidChars = new Set<string>();
  let currentBatch: MacroStep[] = [];
  let currentBatchSourceChars = 0;

  const flushBatch = () => {
    if (currentBatch.length === 0) return;
    batches.push(currentBatch);
    batchStats.push({
      stepCount: currentBatch.length,
      estimatedBytes: estimateBatchBytes(currentBatch.length),
      sourceChars: currentBatchSourceChars,
    });
    currentBatch = [];
    currentBatchSourceChars = 0;
  };

  for (const char of text) {
    const normalizedChar = char.normalize("NFC");
    const charSteps = buildStepsForChar(normalizedChar, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(normalizedChar);
      continue;
    }

    const projectedStepCount = currentBatch.length + charSteps.length;
    const projectedBytes = estimateBatchBytes(projectedStepCount);

    if (
      currentBatch.length > 0 &&
      (projectedStepCount > maxStepsPerBatch || projectedBytes > maxBytesPerBatch)
    ) {
      flushBatch();
    }

    currentBatch.push(...charSteps);
    currentBatchSourceChars += 1;
  }

  flushBatch();

  return {
    batches,
    invalidChars: Array.from(invalidChars),
    batchStats,
  };
}
```

**Invariant:** `sourceChars` is incremented exactly once per `for (const char of text)` iteration that successfully contributed steps to the current batch. Characters that fail `buildStepsForChar` (tracked in `invalidChars`) do **not** contribute to `sourceChars`, keeping the chunk accounting aligned with the actual paste-able characters.

**Edge case:** a flush happens between the char's `flushBatch()` call and the `currentBatch.push(...charSteps)` line. The current char's steps land in the next batch and contribute to the next batch's `sourceChars`. The increment at `currentBatchSourceChars += 1` runs after the push, so it always attributes the char to whichever batch received its steps. Correct by construction.

- [ ] **Step 1.3:** Verify TypeScript compile.

Run:
```bash
cd ui && npx tsc --noEmit
```
Expected: PASS with zero errors. If a call site elsewhere in the codebase uses the old inline `Array<{ stepCount; estimatedBytes }>` shape by structural typing, TypeScript will either accept it (extra field is fine) or flag the mismatch. **Expected to accept** — the old shape was anonymous and only consumed positionally inside `executePasteText`.

- [ ] **Step 1.4:** Verify ESLint.

Run:
```bash
cd ui && npx eslint './src/utils/pasteMacro.ts'
```
Expected: PASS. Pre-existing prettier/CRLF drift on this file is a known false positive; only new warnings on lines Phase 2 touched count. If a new warning appears on your diff, investigate and fix.

- [ ] **Step 1.5:** Commit.

```bash
git add ui/src/utils/pasteMacro.ts
git commit -m "$(cat <<'EOF'
feat(paste): add sourceChars to batchStats in buildPasteMacroBatches (#38)

Track the source-character count per batch alongside the existing
stepCount and estimatedBytes. Phase 2's chunk-aware loop in
executePasteText partitions batches by a source-char budget and needs
this field to do so without a second Unicode-splitting path.

Extracts the batchStats element type to a named PasteBatchStat interface
for clarity. No behavior change — the existing linear-send path reads
stepCount and estimatedBytes unchanged.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** if any later task discovers `sourceChars` is off-by-one vs. the actual source iteration (e.g., decomposed accents landing in the wrong batch), revert this task and replace the per-iteration increment with a per-character pre-computation before the loop.

---

## Task 2: Add `LargePastePolicy` and `partitionBatchesByChunkChars` to `pasteMacro.ts`

**Files:**
- Modify: `ui/src/utils/pasteMacro.ts` (append after `buildPasteMacroBatches`)

**Rationale:** The chunk policy lives next to the batcher because this is the "paste helper module" per CLAUDE.md, and chunk accounting consumes `PasteBatchStat` which is defined in this file. `partitionBatchesByChunkChars` is a pure function — unit-testable in isolation when Phase 5's vitest harness lands.

- [ ] **Step 2.1:** Append the new types and helper to the end of `ui/src/utils/pasteMacro.ts`.

Append these lines at the end of the file (after the closing `}` of `buildPasteMacroBatches`):

```typescript

export interface LargePastePolicy {
  autoThresholdChars: number;
  chunkChars: number;
  chunkPauseMs: number;
  // Floor for the per-chunk derived drain timeout. The actual timeout
  // used by waitForPasteDrain("required", ...) is computed inside
  // executePasteText from the chunk's step count and batch count, then
  // max'd against this floor. A flat timeout would be wrong — a
  // reliable-profile 5000-char chunk takes ~55s end-to-end on current
  // pacing (5ms press + 3ms reset × 5000 MacroSteps + ~76 batches × 200ms
  // inter-macro), so the derivation gives each chunk ~2× its measured
  // worst case.
  chunkDrainTimeoutFloorMs: number;
}

export const DEFAULT_LARGE_PASTE_POLICY: LargePastePolicy = {
  autoThresholdChars: 5000,
  chunkChars: 5000,
  chunkPauseMs: 2000,
  chunkDrainTimeoutFloorMs: 60000,
};

export interface PasteChunkPlan {
  chunkIndex: number; // 0-based
  batchStartIndex: number; // inclusive
  batchEndIndex: number; // exclusive
  sourceChars: number;
}

export function partitionBatchesByChunkChars(
  batchStats: PasteBatchStat[],
  chunkChars: number,
): PasteChunkPlan[] {
  if (chunkChars <= 0) {
    throw new Error("chunkChars must be greater than zero");
  }
  if (batchStats.length === 0) {
    return [];
  }

  const chunks: PasteChunkPlan[] = [];
  let chunkIndex = 0;
  let chunkStart = 0;
  let chunkSourceChars = 0;

  for (let i = 0; i < batchStats.length; i++) {
    const batchChars = batchStats[i].sourceChars;
    // Commit the current chunk before starting a new one. This keeps
    // batches whole and aligns chunk boundaries to real batch edges —
    // we never split a batch in the middle. A single batch whose
    // sourceChars exceeds chunkChars becomes its own oversized chunk,
    // which is acceptable fallback behavior; the required drain still
    // runs at the chunk boundary.
    if (chunkSourceChars > 0 && chunkSourceChars + batchChars > chunkChars) {
      chunks.push({
        chunkIndex,
        batchStartIndex: chunkStart,
        batchEndIndex: i,
        sourceChars: chunkSourceChars,
      });
      chunkIndex += 1;
      chunkStart = i;
      chunkSourceChars = 0;
    }
    chunkSourceChars += batchChars;
  }

  // Flush the final chunk.
  chunks.push({
    chunkIndex,
    batchStartIndex: chunkStart,
    batchEndIndex: batchStats.length,
    sourceChars: chunkSourceChars,
  });

  return chunks;
}
```

**Invariants guaranteed by this function:**
1. `chunks.length >= 1` whenever `batchStats.length > 0`.
2. `chunks[0].batchStartIndex === 0` and `chunks[last].batchEndIndex === batchStats.length`.
3. `chunks[i].batchEndIndex === chunks[i+1].batchStartIndex` for all `i` — chunks are contiguous.
4. `sum(chunks[i].batchEndIndex - chunks[i].batchStartIndex) === batchStats.length` — every batch appears in exactly one chunk.
5. For every chunk `c`, `c.sourceChars === sum(batchStats[b].sourceChars for b in [c.batchStartIndex, c.batchEndIndex))`.

- [ ] **Step 2.2:** Verify TypeScript compile.

Run:
```bash
cd ui && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 2.3:** Verify ESLint.

Run:
```bash
cd ui && npx eslint './src/utils/pasteMacro.ts'
```
Expected: PASS.

- [ ] **Step 2.4:** Commit.

```bash
git add ui/src/utils/pasteMacro.ts
git commit -m "$(cat <<'EOF'
feat(paste): add LargePastePolicy and partitionBatchesByChunkChars (#38)

Introduce the Phase 2 chunk-policy type (autoThresholdChars, chunkChars,
chunkPauseMs, chunkDrainTimeoutFloorMs) with defaults derived from issue
#38's only documented-working setting for the first three — 5000 char
threshold, 5000 char chunks, 2000ms pauses — and a 60s drain-timeout
floor. The actual per-chunk drain timeout is computed at runtime in
executePasteText from the chunk's step count and batch count (see
Task 5); this policy field is only the lower bound.

A flat drain timeout does not work for large pastes on current pacing:
a 5000-char chunk at reliable profile (5ms press + 3ms reset per
MacroStep, ~76 byte-limited batches, 200ms inter-macro sleep) takes
~55s end-to-end, so any value below ~80s would fire prematurely.

partitionBatchesByChunkChars is a pure helper that walks batchStats and
emits contiguous PasteChunkPlan entries, committing each chunk at a real
batch boundary (never splitting a batch mid-way). A single oversized
batch becomes its own chunk as fallback. Used in Task 5 by the chunk-
aware branch of executePasteText.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** if `partitionBatchesByChunkChars` is shown (via Task 5's runtime testing) to mis-allocate batches at chunk boundaries, revert and reconsider the "commit current chunk before adding" vs "commit after adding" choice.

---

## Task 3: Add `abortableSleep` helper to `useKeyboard.ts`

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts` (append after `waitForPasteDrain` declaration, before `useKeyboard` default export)

**Rationale:** The chunk loop (Task 5) inserts a pause between chunks. That pause must respect the same `AbortSignal` that cancels the paste so cancel works during the pause phase. `abortableSleep` is a small module-level helper that `Promise.race`s a timeout against the signal's abort event. Kept module-level (not a hook dep) so `executePasteText`'s `useCallback` deps array does not need to change.

- [ ] **Step 3.1:** Insert the helper immediately after the closing `}` of `waitForPasteDrain` (currently line 197) and before `export default function useKeyboard()` (currently line 199).

Insert:

```typescript

/**
 * Sleep for `ms` milliseconds, rejecting early if `signal` aborts.
 *
 * Used by Phase 2's chunk-aware paste loop to pause between chunks
 * without blocking cancel. The rejection error message is the same
 * as waitForPasteDrain's abort path so executePasteText's catch
 * block treats them uniformly.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Paste execution aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(new Error("Paste execution aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      timer = undefined;
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

**Note:** uses `let timer` with an explicit `undefined` guard to avoid any `no-use-before-define` ESLint complaints about referencing `timer` inside `onAbort` before its declaration.

- [ ] **Step 3.2:** Verify TypeScript compile.

Run:
```bash
cd ui && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3.3:** Verify ESLint.

Run:
```bash
cd ui && npx eslint './src/hooks/useKeyboard.ts'
```
Expected: PASS. If `@typescript-eslint/no-unused-vars` flags `abortableSleep` as unused (because Task 5 is not yet done), that's fine — we will consume it in Task 5. If ESLint is configured to fail on unused, temporarily prefix with `_abortableSleep` or add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the declaration. **Confirm whether the lint rule actually fires before adding a disable comment.**

- [ ] **Step 3.4:** Commit.

```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "$(cat <<'EOF'
feat(paste): add abortableSleep helper for chunk-pause (#38)

Module-level Promise-based sleep that rejects if the caller's AbortSignal
fires. Error message matches waitForPasteDrain's abort rejection shape so
executePasteText's catch block treats chunk-pause cancel uniformly with
drain-wait cancel.

Unused in this commit; consumed by Task 5's chunk-aware loop.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** if TypeScript flags a subtle `timer` scoping issue (which should not happen with the `let` + `undefined` guard pattern), switch to the `Promise.race([setTimeout, signal.addEventListener])` promise-chain form.

---

## Task 4: Migrate `PasteExecutionTrace` to a discriminated union

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:45-51` (type definition)
- Modify: `ui/src/hooks/useKeyboard.ts:591-597` (existing `onTrace?.({ ... })` call inside `executePasteText`)
- Modify: `ui/src/components/popovers/PasteModal.tsx:118-123` (trace formatter)

**Rationale:** Phase 2's chunk loop emits three new trace kinds (`chunk-sent`, `chunk-drained`, `chunk-pause`) in addition to the existing per-batch trace. A discriminated union with `kind` lets each consumer pattern-match on the kind. This is an atomic change — the type definition, the producer, and the consumer all switch shapes in the same commit.

- [ ] **Step 4.1:** Replace `PasteExecutionTrace` type definition at lines 45–51.

In `ui/src/hooks/useKeyboard.ts`, replace:

```typescript
export interface PasteExecutionTrace {
  batchIndex: number;
  totalBatches: number;
  stepCount: number;
  estimatedBytes: number;
  bufferedAmount: number;
}
```

with:

```typescript
export type PasteExecutionTrace =
  | {
      kind: "batch";
      batchIndex: number;
      totalBatches: number;
      stepCount: number;
      estimatedBytes: number;
      bufferedAmount: number;
    }
  | {
      kind: "chunk-sent";
      chunkIndex: number;
      chunkTotal: number;
      sourceChars: number;
      batches: number;
    }
  | {
      kind: "chunk-drained";
      chunkIndex: number;
      drainMs: number;
    }
  | {
      kind: "chunk-pause";
      chunkIndex: number;
      pauseMs: number;
    };
```

- [ ] **Step 4.2:** Update the existing `onTrace?.({ ... })` call in `executePasteText` at lines 591–597 to include `kind: "batch"`.

Replace:

```typescript
          onTrace?.({
            batchIndex: index + 1,
            totalBatches: batches.length,
            stepCount: batch.length,
            estimatedBytes: estimateBatchBytes(batch.length),
            bufferedAmount: channel.bufferedAmount,
          });
```

with:

```typescript
          onTrace?.({
            kind: "batch",
            batchIndex: index + 1,
            totalBatches: batches.length,
            stepCount: batch.length,
            estimatedBytes: estimateBatchBytes(batch.length),
            bufferedAmount: channel.bufferedAmount,
          });
```

- [ ] **Step 4.3:** Update the modal's trace formatter at `ui/src/components/popovers/PasteModal.tsx:118-123` to `switch` on `kind`.

Replace:

```typescript
        onTrace: trace => {
          setTraceLinesPersisted(current => [
            ...current,
            `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} buffered=${trace.bufferedAmount}`,
          ]);
        },
```

with:

```typescript
        onTrace: trace => {
          let line: string;
          switch (trace.kind) {
            case "batch":
              line = `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} buffered=${trace.bufferedAmount}`;
              break;
            case "chunk-sent":
              line = `chunk ${trace.chunkIndex}/${trace.chunkTotal} sent: chars=${trace.sourceChars} batches=${trace.batches}`;
              break;
            case "chunk-drained":
              line = `chunk ${trace.chunkIndex} drained in ${trace.drainMs}ms`;
              break;
            case "chunk-pause":
              line = `chunk ${trace.chunkIndex} pause ${trace.pauseMs}ms`;
              break;
          }
          setTraceLinesPersisted(current => [...current, line]);
        },
```

TypeScript's exhaustiveness check on the discriminated union guarantees `line` is assigned in every branch. If ESLint's `@typescript-eslint/switch-exhaustiveness-check` rule is enabled, the switch must be exhaustive; the four cases cover the full union.

- [ ] **Step 4.4:** Verify TypeScript compile.

Run:
```bash
cd ui && npx tsc --noEmit
```
Expected: PASS. All three changes (type, producer, consumer) must land together for the compile to succeed.

- [ ] **Step 4.5:** Verify ESLint.

Run:
```bash
cd ui && npx eslint './src/hooks/useKeyboard.ts' './src/components/popovers/PasteModal.tsx'
```
Expected: PASS.

- [ ] **Step 4.6:** Commit.

```bash
git add ui/src/hooks/useKeyboard.ts ui/src/components/popovers/PasteModal.tsx
git commit -m "$(cat <<'EOF'
refactor(paste): migrate PasteExecutionTrace to discriminated union (#38)

Extends the trace event type with three new kinds for Phase 2's
chunk-aware loop: chunk-sent, chunk-drained, chunk-pause. Existing
per-batch trace emission becomes kind: "batch". PasteModal's trace
formatter is switched to a discriminated switch with exhaustiveness
guaranteed by the union type.

No behavior change in the producer — the existing linear-send path still
emits exactly one "batch" trace per batch, same as before. Consumer
formatting for chunk kinds is ready for Task 5 to start emitting them.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** if a third consumer of `PasteExecutionTrace` is discovered elsewhere in the codebase (e.g., a persisted trace format in localStorage that reads the old shape by index), revert and keep the old object shape, emitting chunk events as a separate callback.

---

## Task 5: Chunk-aware branch in `executePasteText` + progress type extension + modal phase label + chunk subline

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:20-24` (import added for new `pasteMacro.ts` exports)
- Modify: `ui/src/hooks/useKeyboard.ts:40-43` (`PasteExecutionProgress` interface)
- Modify: `ui/src/hooks/useKeyboard.ts:539-624` (`executePasteText` implementation)
- Modify: `ui/src/components/popovers/PasteModal.tsx:42` (progress state type)
- Modify: `ui/src/components/popovers/PasteModal.tsx:111-116` (`onProgress` handler)
- Modify: `ui/src/components/popovers/PasteModal.tsx:306-312` (progress rendering)

**Rationale:** This is the core of Phase 2 — the chunk loop itself. It's presented as a single atomic task because the type extension, the hook consumer, and the modal consumer must all agree. Splitting them produces broken intermediate compile states. The chunk loop is built as a unified outer loop that handles both chunk mode and non-chunk mode via a single-element `chunks` array in the non-chunk case.

- [ ] **Step 5.1:** Extend the `pasteMacro` import at the top of `useKeyboard.ts` (lines 20–24).

Replace:

```typescript
import {
  buildPasteMacroBatches,
  estimateBatchBytes,
  type KeyboardLayoutLike,
} from "@/utils/pasteMacro";
```

with:

```typescript
import {
  buildPasteMacroBatches,
  DEFAULT_LARGE_PASTE_POLICY,
  estimateBatchBytes,
  partitionBatchesByChunkChars,
  type KeyboardLayoutLike,
  type PasteChunkPlan,
} from "@/utils/pasteMacro";
```

The `PasteChunkPlan` type import is used to type the synthetic single-element `chunks` array in the non-chunk path.

- [ ] **Step 5.2:** Extend `PasteExecutionProgress` at lines 40–43.

Replace:

```typescript
export interface PasteExecutionProgress {
  completedBatches: number;
  totalBatches: number;
}
```

with:

```typescript
export interface PasteExecutionProgress {
  completedBatches: number;
  totalBatches: number;
  phase: "sending" | "draining" | "pausing";
  chunkIndex: number; // 1-based. 0 when chunk mode is off.
  chunkTotal: number; // 0 when chunk mode is off.
}
```

`chunkTotal === 0` is the sentinel for "not in large-paste mode" so the modal can hide chunk UI.

- [ ] **Step 5.3:** Rewrite the body of `executePasteText` at lines 539–624. The outer `useCallback` signature and deps array are unchanged.

Replace the entire `executePasteText` definition (from `const executePasteText = useCallback(` at line 539 through `, [executePasteMacro, rpcHidChannel]);` at line 624) with:

```typescript
  const executePasteText = useCallback(
    async (text: string, options: ExecutePasteTextOptions) => {
      const {
        keyboard,
        delayMs,
        maxStepsPerBatch,
        maxBytesPerBatch,
        finalSettleMs,
        signal,
        onProgress,
        onTrace,
      } = options;

      const { batches, invalidChars, batchStats } = buildPasteMacroBatches(
        text,
        keyboard,
        delayMs,
        maxStepsPerBatch,
        maxBytesPerBatch,
      );

      if (invalidChars.length > 0) {
        throw new Error(`Unsupported characters: ${invalidChars.join(", ")}`);
      }

      // Pipeline flow control constants. Values untouched in Phase 2 — these
      // remain the frontend's primary backpressure lever against the
      // WebRTC data channel and must not be retuned here.
      const PASTE_LOW_WATERMARK = 64 * 1024;
      const PASTE_HIGH_WATERMARK = 256 * 1024;

      const channel = rpcHidChannel;
      if (!channel || channel.readyState !== "open") {
        throw new Error("HID data channel not available");
      }

      // Save and set bufferedAmount threshold for paste flow control
      const prevThreshold = channel.bufferedAmountLowThreshold;
      channel.bufferedAmountLowThreshold = PASTE_LOW_WATERMARK;

      // Abort-aware high-watermark drain wait. Phase 2 upgrade over the
      // pre-existing drainResolve-only pattern: if signal.abort() fires
      // while the loop is parked on a full channel buffer, the pending
      // waitForChannelDrain() rejects immediately rather than waiting
      // for the next bufferedamountlow event. drainReject is the paired
      // slot; onBufferedDrainAbort is installed alongside the existing
      // onLow listener. The low-watermark resume path is unchanged —
      // onLow still fires on bufferedamountlow and resolves the pending
      // promise exactly as before.
      let drainResolve: (() => void) | null = null;
      let drainReject: ((err: Error) => void) | null = null;
      const waitForChannelDrain = () =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Paste execution aborted"));
            return;
          }
          drainResolve = resolve;
          drainReject = reject;
        });
      const onLow = () => {
        const resolver = drainResolve;
        drainResolve = null;
        drainReject = null;
        resolver?.();
      };
      const onBufferedDrainAbort = () => {
        const rejecter = drainReject;
        drainResolve = null;
        drainReject = null;
        rejecter?.(new Error("Paste execution aborted"));
      };
      channel.addEventListener("bufferedamountlow", onLow);
      signal?.addEventListener("abort", onBufferedDrainAbort);

      // Phase 2 chunk policy. Chunk mode is automatic above the threshold:
      // partition batches by source-char budget and drain the backend
      // between chunks via waitForPasteDrain("required", ...). Below the
      // threshold, the chunks array is a single synthetic plan covering
      // all batches, so the outer loop runs once and behavior is identical
      // to the pre-Phase-2 linear path.
      const policy = DEFAULT_LARGE_PASTE_POLICY;
      const chunkMode = text.length >= policy.autoThresholdChars;
      const chunks: PasteChunkPlan[] = chunkMode
        ? partitionBatchesByChunkChars(batchStats, policy.chunkChars)
        : [
            {
              chunkIndex: 0,
              batchStartIndex: 0,
              batchEndIndex: batches.length,
              sourceChars: text.length,
            },
          ];
      const chunkTotalForProgress = chunkMode ? chunks.length : 0;

      try {
        for (let ci = 0; ci < chunks.length; ci++) {
          const chunk = chunks[ci];
          for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
            if (signal?.aborted) {
              throw new Error("Paste execution aborted");
            }

            const batch = batches[b];
            await executePasteMacro(batch);

            onTrace?.({
              kind: "batch",
              batchIndex: b + 1,
              totalBatches: batches.length,
              stepCount: batch.length,
              estimatedBytes: estimateBatchBytes(batch.length),
              bufferedAmount: channel.bufferedAmount,
            });

            onProgress?.({
              completedBatches: b + 1,
              totalBatches: batches.length,
              phase: "sending",
              chunkIndex: chunkMode ? chunk.chunkIndex + 1 : 0,
              chunkTotal: chunkTotalForProgress,
            });

            // Pause if channel buffer exceeds high watermark. The wait is
            // abort-aware: signal.abort() during the pause rejects the
            // pending promise immediately via onBufferedDrainAbort.
            if (channel.bufferedAmount >= PASTE_HIGH_WATERMARK) {
              await waitForChannelDrain();
            }
          }

          // Chunk-boundary work: only in chunk mode. Announce the chunk,
          // wait for the backend to fully drain (required mode — rejects on
          // timeout so a chunk-level failure surfaces as an error), then
          // pause if there are more chunks to come.
          if (chunkMode) {
            onTrace?.({
              kind: "chunk-sent",
              chunkIndex: chunk.chunkIndex + 1,
              chunkTotal: chunks.length,
              sourceChars: chunk.sourceChars,
              batches: chunk.batchEndIndex - chunk.batchStartIndex,
            });

            onProgress?.({
              completedBatches: chunk.batchEndIndex,
              totalBatches: batches.length,
              phase: "pausing",
              chunkIndex: chunk.chunkIndex + 1,
              chunkTotal: chunks.length,
            });

            // Per-chunk derived drain timeout. A flat constant does not
            // work here: at reliable-profile pacing on current main
            // (keyDelayMs=3, 5ms press + 3ms reset per MacroStep, ~66
            // steps/batch byte-limited, 200ms inter-macro), a 5000-char
            // chunk takes ~55s end-to-end. The derivation below gives each
            // chunk ~2x its measured worst case, with a policy floor for
            // small chunks.
            //
            // Derivation assumptions (tuned to current Phase 1 pacing):
            //   - 20ms per MacroStep upper bound (press 5ms + reset up to 5ms,
            //     × 2 safety margin)
            //   - 400ms per batch upper bound (200ms inter-macro × 2 safety)
            //   - 5s flat slack
            // If Phase 3a retunes any of these, re-verify this formula.
            let chunkStepCount = 0;
            for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
              chunkStepCount += batchStats[b].stepCount;
            }
            const chunkNumBatches = chunk.batchEndIndex - chunk.batchStartIndex;
            const derivedDrainTimeoutMs =
              chunkStepCount * 20 + chunkNumBatches * 400 + 5000;
            const chunkDrainTimeoutMs = Math.max(
              policy.chunkDrainTimeoutFloorMs,
              derivedDrainTimeoutMs,
            );

            const drainStart = performance.now();
            await waitForPasteDrain("required", chunkDrainTimeoutMs, signal);
            onTrace?.({
              kind: "chunk-drained",
              chunkIndex: chunk.chunkIndex + 1,
              drainMs: Math.round(performance.now() - drainStart),
            });

            if (ci < chunks.length - 1) {
              onTrace?.({
                kind: "chunk-pause",
                chunkIndex: chunk.chunkIndex + 1,
                pauseMs: policy.chunkPauseMs,
              });
              await abortableSleep(policy.chunkPauseMs, signal);
            }
          }
        }

        // Final bestEffort drain — preserves existing settle UX. In chunk
        // mode the last chunk's required drain already confirmed HID-layer
        // drain; this is a short grace window for any residual settle. In
        // non-chunk mode this is the existing path verbatim.
        onProgress?.({
          completedBatches: batches.length,
          totalBatches: batches.length,
          phase: "draining",
          chunkIndex: chunkMode ? chunks.length : 0,
          chunkTotal: chunkTotalForProgress,
        });

        const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
        await waitForPasteDrain("bestEffort", drainTimeoutMs, signal);
      } finally {
        channel.removeEventListener("bufferedamountlow", onLow);
        signal?.removeEventListener("abort", onBufferedDrainAbort);
        channel.bufferedAmountLowThreshold = prevThreshold;
      }
    },
    [executePasteMacro, rpcHidChannel],
  );
```

**Things to verify by inspection before saving:**
- The `useCallback` deps array is still `[executePasteMacro, rpcHidChannel]` — no additions.
- `abortableSleep` is referenced but not imported (it's module-local in useKeyboard.ts, defined in Task 3).
- `waitForPasteDrain` is referenced but not imported (it's module-local in useKeyboard.ts, defined in Phase 1).
- The `try/finally` still wraps the whole batch-submission flow so cleanup always runs.
- `channel.removeEventListener("bufferedamountlow", onLow)` AND `signal?.removeEventListener("abort", onBufferedDrainAbort)` both run in the `finally` block. Missing the second removal would leak an abort listener on the signal for the lifetime of the cancelled paste's abort controller.
- `drainResolve` and `drainReject` are always nulled together — any path that consumes one (`onLow`, `onBufferedDrainAbort`, or a fresh `waitForChannelDrain()` call) clears both. This prevents the opposite callback from firing a stale slot after the other has already resolved/rejected.
- The derived `chunkDrainTimeoutMs` computation reads `batchStats[b].stepCount` for `b` in `[chunk.batchStartIndex, chunk.batchEndIndex)`. Those indices must be within `batchStats.length` — guaranteed by `partitionBatchesByChunkChars`'s invariants from Task 2.
- The non-chunk path (`chunkMode === false`) runs the inner loop exactly once over all batches, never enters the `if (chunkMode)` block, and reaches the final `waitForPasteDrain("bestEffort", ...)`. Behavior is byte-for-byte identical to current main **except** for (a) the additional explicit `"draining"` progress emit immediately before the final drain wait, and (b) the `waitForChannelDrain` helper's new abort-awareness (which only observable difference from current main is on cancel, not on the happy path). The modal handles the progress delta cleanly (Step 5.5 below).

**Behavior delta in non-chunk path (intentional, documented):** previously the last batch's progress emit carried implicit "last batch" semantics (modal derived `phase: "draining"` from `completed === total`). Now the last batch emit carries `phase: "sending"`, and an explicit `phase: "draining"` emit fires immediately before the drain wait starts. User-visibly this is invisible — the two emits happen microseconds apart and React batches the renders.

- [ ] **Step 5.4:** Update the modal's `pasteProgress` state type at `PasteModal.tsx:42`.

Replace:

```typescript
  const [pasteProgress, setPasteProgress] = useState<{ completed: number; total: number; phase: "sending" | "draining" } | null>(null);
```

with:

```typescript
  const [pasteProgress, setPasteProgress] = useState<{
    completed: number;
    total: number;
    phase: "sending" | "draining" | "pausing";
    chunkIndex: number;
    chunkTotal: number;
  } | null>(null);
```

- [ ] **Step 5.5:** Update the `onProgress` handler at `PasteModal.tsx:111-116`.

Replace:

```typescript
        onProgress: progress => {
          setPasteProgress({
            completed: progress.completedBatches,
            total: progress.totalBatches,
            phase: progress.completedBatches === progress.totalBatches ? "draining" : "sending",
          });
        },
```

with:

```typescript
        onProgress: progress => {
          setPasteProgress({
            completed: progress.completedBatches,
            total: progress.totalBatches,
            phase: progress.phase,
            chunkIndex: progress.chunkIndex,
            chunkTotal: progress.chunkTotal,
          });
        },
```

The ternary derivation is removed — the hook is now the source of truth for phase.

- [ ] **Step 5.6:** Update the progress rendering at `PasteModal.tsx:306-312`.

Replace:

```typescript
                  {pasteProgress && (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {pasteProgress.phase === "draining"
                        ? `Draining final input… (${pasteProgress.completed} / ${pasteProgress.total} batches submitted)`
                        : `Sending paste batch ${pasteProgress.completed} / ${pasteProgress.total}`}
                    </p>
                  )}
```

with:

```typescript
                  {pasteProgress && (
                    <div className="space-y-1">
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {pasteProgress.phase === "draining"
                          ? `Draining final input… (${pasteProgress.completed} / ${pasteProgress.total} batches submitted)`
                          : pasteProgress.phase === "pausing"
                            ? `Pausing to let target catch up… (${pasteProgress.completed} / ${pasteProgress.total} batches submitted)`
                            : `Sending paste batch ${pasteProgress.completed} / ${pasteProgress.total}`}
                      </p>
                      {pasteProgress.chunkTotal > 0 && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-500">
                          Chunk {pasteProgress.chunkIndex} / {pasteProgress.chunkTotal}
                        </p>
                      )}
                    </div>
                  )}
```

- [ ] **Step 5.7:** Verify TypeScript compile.

Run:
```bash
cd ui && npx tsc --noEmit
```
Expected: PASS. Any residual Task-5 error usually means a missing import or a mismatch between the hook's progress emit shape and the modal's `onProgress` reader. Grep for `onProgress` in both files to confirm shapes align.

- [ ] **Step 5.8:** Verify ESLint.

Run:
```bash
cd ui && npx eslint './src/hooks/useKeyboard.ts' './src/components/popovers/PasteModal.tsx'
```
Expected: PASS on Phase 2 diff lines. Pre-existing prettier/CRLF drift warnings on untouched lines are the known false positive.

- [ ] **Step 5.9:** Commit.

```bash
git add ui/src/hooks/useKeyboard.ts ui/src/components/popovers/PasteModal.tsx
git commit -m "$(cat <<'EOF'
feat(paste): chunk-aware large-paste safe mode with required drain boundaries (#38)

Implements issue #38's chunk-pause layer on top of Phase 1's paste-depth
semantics and shallow queue:

- Chunk mode is automatic when text.length >= autoThresholdChars (5000).
- Batches are partitioned by source-char budget via
  partitionBatchesByChunkChars; batch boundaries are respected so no
  second Unicode-splitting path exists.
- Between chunks, executePasteText awaits
  waitForPasteDrain("required", chunkDrainTimeoutMs, signal). Required
  mode rejects on timeout so a failed drain surfaces as a real paste
  error instead of silent resolution — this is Phase 1's waitForPasteDrain
  helper's first consumer.
- chunkDrainTimeoutMs is derived per chunk from the chunk's step count
  and batch count against a policy floor (60s). A flat constant does
  not work: a 5000-char chunk at reliable pacing takes ~55s end-to-end
  on current main, so any flat value below ~80s would fire prematurely.
- After each drained chunk (except the last) the loop awaits
  abortableSleep(policy.chunkPauseMs, signal) — abortable so cancel
  works during the pause.
- The existing waitForChannelDrain helper (high-watermark pause) is
  upgraded to respect signal.abort(): a paired drainReject slot plus an
  onBufferedDrainAbort listener reject any pending wait on abort. Before
  Phase 2, a cancel during a full-buffer pause would delay until the
  next bufferedamountlow event fires. The low-watermark resume path is
  unchanged — onLow still resolves the pending promise exactly as
  before. Watermark values are unchanged.
- The non-chunk path is a single synthetic chunk covering all batches;
  behavior is byte-for-byte identical to current main except for an
  explicit phase: "draining" progress emit immediately before the final
  bestEffort drain wait (previously the modal derived draining from
  completed === total).

PasteExecutionProgress gains phase ("sending" | "draining" | "pausing"),
chunkIndex, and chunkTotal. The modal renders a "Pausing to let target
catch up…" label during the pausing phase and a "Chunk X/Y" subline
when chunkTotal > 0 — sub-threshold pastes render unchanged.

Flow control watermark values and the waitForPasteDrain helper itself
are preserved verbatim.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** if the required drain is observed to time out spuriously at chunk boundaries on the dev device (192.168.1.36) — meaning the backend drained faster than the frontend armed the wait (Race F in the spec) — fall back to `bestEffort` mode for chunk boundaries. This preserves the chunk pause structure but loses the "real drain error on timeout" guarantee. Not expected per the spec's practical-impossibility analysis, but documented as the escape hatch.

---

## Task 6: Backend rename — extract `pasteInterMacroDrainMs` constant

**Files:**
- Modify: `jsonrpc.go` (near the `macroQueueDepth` constant at line 1015)
- Modify: `jsonrpc.go:1138` (the single usage)

**Rationale:** Cosmetic-only rename. The 200ms inter-macro drain delay is load-bearing (PR #41) and must not be retuned in Phase 2. Extracting it to a named constant documents the invariant in the declaration and makes Phase 3b's timer-reuse landing site obvious.

- [ ] **Step 6.1:** Add the constant near `macroQueueDepth` in `jsonrpc.go`.

After line 1015 (`const macroQueueDepth = 64`) insert a blank line then:

```go

// pasteInterMacroDrainMs is the inter-macro pause inside drainMacroQueue
// that gives the host USB input queue time to consume pending reports
// between consecutive macros. PR #41 load-bearing fix — do not retune
// without a dedicated profiling PR. Phase 2 (#38) adds chunk-boundary
// pauses on top of this delay, not instead of it.
const pasteInterMacroDrainMs = 200 * time.Millisecond
```

Confirm `time` package is already imported at the top of `jsonrpc.go` (it is — existing `time.Sleep` usage proves this).

- [ ] **Step 6.2:** Replace the literal at line 1138.

In `drainMacroQueue`, replace:

```go
		time.Sleep(200 * time.Millisecond)
```

with:

```go
		time.Sleep(pasteInterMacroDrainMs)
```

The surrounding comment block at lines 1134–1137 explaining the load-bearing nature of the delay is unchanged.

- [ ] **Step 6.3:** Verify Go build.

Run:
```bash
go build ./...
```
Expected: PASS. A single `time.Duration` constant declaration and a single call-site replacement should be a no-op to the compiler.

- [ ] **Step 6.4:** Verify `go vet`.

Run:
```bash
go vet ./...
```
Expected: PASS.

- [ ] **Step 6.5:** Compile-only test gate for the root package (buildkit cross-compile workaround per CLAUDE.md).

Run:
```bash
go test -c -o /dev/null ./
```
Expected: PASS. This confirms the test binary compiles; it does not run the tests. Runtime tests happen post-merge via `dev_deploy.sh --run-go-tests`.

- [ ] **Step 6.6:** Commit.

```bash
git add jsonrpc.go
git commit -m "$(cat <<'EOF'
refactor(paste): extract pasteInterMacroDrainMs named constant (#38)

Phase 2 cosmetic only. The 200ms inter-macro drain delay in
drainMacroQueue is PR #41's load-bearing fix that gives the host USB
stack time to consume pending HID reports between consecutive macros.
Naming it makes Phase 3b's timer-reuse landing site obvious and
documents the load-bearing invariant in the declaration.

No behavior change — the value and call site are preserved verbatim.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Rollback condition:** trivial — revert the two-line change if any concern arises.

---

## Final verification (all tasks complete)

After all six tasks commit successfully, run the full verification loop from the repo root:

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
cd .. && go build ./... && go vet ./...
go test -c -o /dev/null ./
```

All commands must pass. ESLint will still flag pre-existing prettier/CRLF drift in untouched files — that's the known gotcha from CLAUDE.md and is the fault of `core.autocrlf=true`, not Phase 2 changes. Verify any warnings appear only on lines NOT in the Phase 2 diff.

```bash
git log --oneline main..HEAD
```

Expected output: 7 commits (1 spec commit from Step 4 of the orchestrator + 6 plan commits from Tasks 1–6), all with the `(#38)` issue suffix in the title line.

---

## Acceptance criteria checklist

From issue #38 "Suggested acceptance criteria":

- [ ] 32k and 100k file-backed pastes complete without corruption in a simple editor and the problematic target app (manual on-device test — post merge)
- [ ] Cancel works correctly during sending, during chunk pause, and during final drain (covered by Race A, B, C in the spec; verified via `signal` cascade in Tasks 3 and 5)
- [ ] Non-paste macros (button bindings, custom macros) no longer toggle `isPasteInProgress` (Phase 1 regression; Phase 2 does not touch the code that landed this — verify by re-reading `drainMacroQueue` after Task 6)
- [ ] Chunk-boundary timeout surfaces as a real failure, not silent success (Task 5 uses `waitForPasteDrain("required", ...)` which rejects on timeout; the catch path in `executePasteText` bubbles the error)
- [ ] Trace output clearly shows chunk boundaries, drain waits, and pause timing (Tasks 4 + 5 emit the three new trace kinds; PasteModal renders them in the debug trace panel)
- [ ] `IsPaste` flag is preserved end-to-end (Phase 1 regression; Phase 2 does not touch `hidrpc.go` or the wire format)

---

## Notes for the subagent executing this plan

1. **Do not skip verification steps.** Every `tsc --noEmit` and every `go build ./...` is a real gate. If one fails, STOP and investigate — do not continue to the next task.
2. **Do not merge multiple tasks into one commit.** The commit boundary is where rollback happens. Each task must be individually revertable.
3. **Do not touch any file outside the touch list.** If a file outside the touch list needs changing for verification to pass, STOP and report to the orchestrator — it may indicate spec/plan drift.
4. **Do not rename identifiers gratuitously.** The plan names (`abortableSleep`, `partitionBatchesByChunkChars`, `LargePastePolicy`, `PasteBatchStat`, `PasteChunkPlan`, `pasteInterMacroDrainMs`) are load-bearing in the commit messages and spec. Use them exactly.
5. **Do not use `--no-verify`, `--amend`, or force-push.** If a hook fails, fix the underlying issue and create a new commit.
6. **The ESLint CRLF false positives** are not your concern unless they appear on lines Phase 2 touched. Verify with `git diff --stat` that the warning location is outside the Phase 2 diff before ignoring.
7. **If Step 5.3 is daunting**, read Phase 1's executePasteText first (before the Task 5 edit) and diff mentally against the new version. The structural change is: single linear `for` loop → nested loop with an outer `chunks` iteration. Everything inside the inner loop is preserved except the progress emit shape.
