# Consolidate Duplicate Paste Batching Logic

**Issue:** #41 — refactor: Consolidate duplicate batching logic and fix byte estimation divergence
**Date:** 2026-04-09
**Approach:** A — Extract batching into `pasteMacro.ts`, slim down `executePasteText`

## Problem

Two implementations of paste batching exist with divergent byte estimation formulas:
- `pasteMacro.ts`: `6 + stepCount * 9` (correct, matches HID report layout)
- `useKeyboard.ts`: `6 + logicalSteps * 18` (wrong, 2x overestimate)

Post-pipeline merge (#46), `executePasteText` in `useKeyboard.ts` is the **only live path** — called from `PasteModal.tsx`. The `pasteMacro.ts`/`pasteBatches.ts` batch-building and execution code (`buildPasteMacroBatches`, `runPasteBatches`) is never imported.

The wrong byte formula causes batches to be undersized (batcher thinks each step needs 2x actual space), underutilizing available bandwidth.

## Design

### File changes

#### `pasteMacro.ts` — Export `estimateBatchBytes`

**Current:** `estimateBatchBytes` is a private function (line 30).
**Change:** Add `export` keyword. No logic changes.

This allows `executePasteText` to use the correct formula for trace reporting.

#### `useKeyboard.ts` — Replace inline batching with `buildPasteMacroBatches()`

**Remove (lines 413-451):**
- `const batches: MacroSteps[] = []`
- `let currentBatch: MacroSteps = []`
- `const estimateBytes = (logicalSteps: number) => 6 + logicalSteps * 18` (the bug)
- `const flushBatch = () => { ... }`
- `const invalidChars = new Set<string>()`
- The `for (const char of text)` batch-building loop
- The `if (invalidChars.size > 0)` check

**Replace with:**
```typescript
import { buildPasteMacroBatches, estimateBatchBytes } from "@/utils/pasteMacro";

const { batches, invalidChars } = buildPasteMacroBatches(
  text, keyboard, delayMs, maxStepsPerBatch, maxBytesPerBatch,
);

if (invalidChars.length > 0) {
  throw new Error(`Unsupported characters: ${invalidChars.join(", ")}`);
}
```

**Fix trace reporting (line 484):**
```typescript
// Before:
estimatedBytes: estimateBytes(batch.length),
// After:
estimatedBytes: estimateBatchBytes(batch.length),
```

**Keep untouched:** Lines 453-536 (flow control watermarks, drain detection, abort handling).

#### `pasteBatches.ts` — Delete dead code

**Delete:**
- `runPasteBatches()` function (lines 45-142)
- `BatchProgress` interface (lines 27-30)
- `PasteTraceEntry` interface (lines 32-43)
- `PasteBatchProfile` interface (lines 3-8)
- `import type { MacroStep }` (line 1, no longer needed)
- `satisfies Record<string, PasteBatchProfile>` (line 23, type deleted)

**Keep:**
- `PASTE_PROFILES` constant (lines 10-22, imported by PasteModal.tsx)
- `PasteProfileName` type (line 25, imported by PasteModal.tsx)

File reduces to ~17 lines: just profiles and the type.

#### `PasteModal.tsx` — No changes

Imports `PASTE_PROFILES` and `PasteProfileName` from `pasteBatches.ts` — both retained. Calls `executePasteText` via the hook — interface unchanged.

### Net impact

- ~95 lines of dead code removed (`runPasteBatches` + dead types)
- ~35 lines of duplicate inline batching removed from `useKeyboard.ts`
- ~5 lines added (import + function call)
- Byte estimation bug fixed (batches will now be correctly sized)
- Single source of truth for batch construction: `pasteMacro.ts`

### Interface alignment

`buildPasteMacroBatches` returns `PasteMacroBatchResult`:
```typescript
{
  batches: MacroStep[][],      // executePasteText expects MacroSteps[] (compatible)
  invalidChars: string[],      // replaces inline Set<string> → Array conversion
  batchStats: Array<{ stepCount: number; estimatedBytes: number }>,  // available for tracing
}
```

The `batchStats` array can replace the inline `estimateBatchBytes` call in trace reporting, providing pre-computed values.

### Dependencies

- **Unblocks #40** — byte limit fixes land on the consolidated, correct path
- **Unblocks #42** — race condition fix targets single completion-detection code
- **Unblocks #45** — memory churn fixes apply to consolidated batching
- **No backend changes** — frontend-only refactor

### Risks

- **Low risk:** Batch construction logic is identical between the two paths except for the byte formula. Switching to `buildPasteMacroBatches` is a direct substitution.
- **Type compatibility:** `MacroSteps` (useKeyboard) and `MacroStep[]` (pasteMacro) must be compatible. Verify during implementation.
