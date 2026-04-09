# Consolidate Duplicate Paste Batching Logic

**Issue:** #41 — refactor: Consolidate duplicate batching logic and fix byte estimation divergence
**Date:** 2026-04-09
**Approach:** A — Extract batching into `pasteMacro.ts`, slim down `executePasteText`

## Problem

Two implementations of paste batching exist with divergent byte estimation formulas:
- `pasteMacro.ts`: `6 + stepCount * 9` — counts MacroStep objects, assumes 1:1 wire mapping
- `useKeyboard.ts`: `6 + logicalSteps * 18` — accounts for the press+release doubling in `executeMacroRemote`

### Which formula is correct?

**`6 + stepCount * 18` is the correct wire-byte estimate.** Here's why:

1. `buildStepsForChar('a', ...)` produces 1 `MacroStep` (logical: "press a")
2. `executeMacroRemote` expands each `MacroStep` into 2 `KeyboardMacroStep` objects:
   - Press: `{ keys: [keyValue], modifier: mask, delay: 5 }`
   - Reset: `{ keys: [], modifier: 0, delay: step.delay }`
3. `KeyboardMacroReportMessage.marshal()` allocates `6 + actualStepCount * 9` bytes
4. So: `6 + (stepCount * 2) * 9 = 6 + stepCount * 18`

**The inline formula in `useKeyboard.ts` is correct. `pasteMacro.ts`'s formula is wrong** — it underestimates wire bytes by half because it doesn't account for the press+release expansion in `executeMacroRemote`.

### Impact of the wrong formula in `pasteMacro.ts`

`buildPasteMacroBatches` currently uses `6 + stepCount * 9`, which would allow batches that are **2x larger than the byte budget**. If consolidated naively (swapping the inline code for `buildPasteMacroBatches`), batch sizes would double and could exceed WebRTC SCTP message limits.

Post-pipeline merge (#46), `executePasteText` in `useKeyboard.ts` is the **only live path** — called from `PasteModal.tsx`. The `pasteMacro.ts`/`pasteBatches.ts` batch-building and execution code (`buildPasteMacroBatches`, `runPasteBatches`) is never imported, so the wrong formula in `pasteMacro.ts` is currently harmless (dead code).

## Design

### Scope constraints (from GPT-5 Pro review)

1. **Stay in the batch-construction lane.** Do not touch the send loop or the post-send drain wait in `executePasteText`.
2. **Do not route through `runPasteBatches`.** That helper treats `await executeBatch()` as "batch completed", which would bake send-as-complete semantics back in and make #42 harder.
3. **Leave `isPasteInProgress` subscription alone.** Completion semantics are #42's scope.

### File changes

#### `pasteMacro.ts` — Fix `estimateBatchBytes` and export it

**Current (line 30-34):**
```typescript
function estimateBatchBytes(stepCount: number): number {
  // Matches HID macro report layout in hidRpc.ts:
  // 6-byte header + 9 bytes per step.
  return 6 + stepCount * 9;
}
```

**Change to:**
```typescript
export function estimateBatchBytes(stepCount: number): number {
  // Wire-byte estimate for HID macro report:
  // 6-byte header + 18 bytes per MacroStep.
  // Each MacroStep expands to 2 KeyboardMacroSteps (press + reset)
  // in executeMacroRemote, and each KeyboardMacroStep is 9 bytes.
  return 6 + stepCount * 18;
}
```

This fixes the formula AND exports it for use by `executePasteText` trace reporting.

#### `useKeyboard.ts` — Replace inline batching with `buildPasteMacroBatches()`

**Remove (lines 413-451):**
- `const batches: MacroSteps[] = []`
- `let currentBatch: MacroSteps = []`
- `const estimateBytes = (logicalSteps: number) => 6 + logicalSteps * 18`
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

**Keep untouched:** Lines 453-536 (flow control watermarks, drain detection, abort handling, `isPasteInProgress` subscription).

#### `pasteBatches.ts` — Delete dead code, keep profiles with local type

**Delete:**
- `runPasteBatches()` function (lines 45-142)
- `BatchProgress` interface (lines 27-30)
- `PasteTraceEntry` interface (lines 32-43)
- `import type { MacroStep }` (line 1, no longer needed)

**Keep with changes:**
- `PASTE_PROFILES` constant — keep, but slim the type constraint
- `PasteProfileName` type — keep (imported by PasteModal.tsx)

**Replace exported `PasteBatchProfile` with unexported local type** (per GPT-5 Pro recommendation — keeps the structural guarantee without exporting an unused interface):
```typescript
type PasteProfile = {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
};

export const PASTE_PROFILES = {
  reliable: { maxStepsPerBatch: 128, maxBytesPerBatch: 1200, keyDelayMs: 3 },
  fast: { maxStepsPerBatch: 320, maxBytesPerBatch: 1100, keyDelayMs: 2 },
} satisfies Record<string, PasteProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;
```

Drops `batchPauseMs` (unused on live path). File reduces to ~12 lines.

#### `PasteModal.tsx` — No changes

Imports `PASTE_PROFILES` and `PasteProfileName` from `pasteBatches.ts` — both retained. Calls `executePasteText` via the hook — interface unchanged.

### Batch boundary preservation

After consolidation, `buildPasteMacroBatches` with the corrected formula (`6 + stepCount * 18`) will produce **identical batch boundaries** to the current inline code in `executePasteText`. Both paths:
- Iterate characters with NFC normalization
- Call `buildStepsForChar()` for each character
- Flush when `projectedSteps > maxStepsPerBatch || projectedBytes > maxBytesPerBatch`
- Use the same byte formula (after fix)

A regression test should verify: for a fixture containing plain chars, shifted chars, dead keys, and accent keys, the consolidated builder produces the same batch count, step counts, and byte estimates as the current inline builder.

### Net impact

- ~95 lines of dead code removed (`runPasteBatches` + dead types)
- ~35 lines of duplicate inline batching removed from `useKeyboard.ts`
- ~5 lines added (import + function call)
- Byte estimation formula corrected in `pasteMacro.ts` (9 → 18 per step)
- Single source of truth for batch construction: `pasteMacro.ts`

### Interface alignment

`buildPasteMacroBatches` returns `PasteMacroBatchResult`:
```typescript
{
  batches: MacroStep[][],      // executePasteText expects MacroSteps[] (type alias, compatible)
  invalidChars: string[],      // replaces inline Set<string> → Array conversion
  batchStats: Array<{ stepCount: number; estimatedBytes: number }>,  // available for tracing
}
```

The `batchStats` array provides pre-computed byte estimates for trace reporting.

### Dependencies

- **Unblocks #40** — byte limit fixes land on the consolidated, correct path
- **Unblocks #42** — race condition fix targets single completion-detection code (untouched here)
- **Unblocks #45** — memory churn fixes apply to consolidated batching
- **No backend changes** — frontend-only refactor

### Risks

- **Low risk:** Batch construction logic is identical between the two paths. The only behavioral change is fixing `estimateBatchBytes` from `9` to `18`, which brings `pasteMacro.ts` in line with the already-correct inline formula.
- **Type compatibility:** `MacroSteps` = `MacroStep[]` (verified: type alias at `useKeyboard.ts:34`).
- **No batch size change:** Current live behavior uses `18` and is preserved. The formula fix in `pasteMacro.ts` brings dead-then-consolidated code to match.
