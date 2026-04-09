# Consolidate Paste Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate two divergent paste batching implementations into one, fixing the byte estimation formula in `pasteMacro.ts` so the consolidated path produces correct wire-byte estimates.

**Architecture:** Replace the inline batch-building loop in `useKeyboard.ts:executePasteText` with a call to `buildPasteMacroBatches()` from `pasteMacro.ts`. Fix `estimateBatchBytes` from `6 + stepCount * 9` to `6 + stepCount * 18` (accounting for press+release doubling in `executeMacroRemote`). Delete dead execution code from `pasteBatches.ts`.

**Tech Stack:** TypeScript, React hooks, Vite, ESLint

**Spec:** `docs/superpowers/specs/2026-04-09-consolidate-paste-batching-design.md`

---

### Task 1: Fix and export `estimateBatchBytes` in `pasteMacro.ts`

**Files:**
- Modify: `ui/src/utils/pasteMacro.ts:30-34`

- [ ] **Step 1: Fix the formula and export**

In `ui/src/utils/pasteMacro.ts`, replace lines 30-34:

```typescript
function estimateBatchBytes(stepCount: number): number {
  // Matches HID macro report layout in hidRpc.ts:
  // 6-byte header + 9 bytes per step.
  return 6 + stepCount * 9;
}
```

With:

```typescript
export function estimateBatchBytes(stepCount: number): number {
  // Wire-byte estimate for HID macro report:
  // 6-byte header + 18 bytes per MacroStep.
  // Each MacroStep expands to 2 KeyboardMacroSteps (press + reset)
  // in executeMacroRemote, and each KeyboardMacroStep is 9 bytes.
  return 6 + stepCount * 18;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `ui/`:
```bash
npx tsc --noEmit
```
Expected: No errors. The formula change doesn't break any callers — `estimateBatchBytes` is only called within `pasteMacro.ts` itself (in `buildPasteMacroBatches`), and the export is additive.

- [ ] **Step 3: Commit**

```bash
git add ui/src/utils/pasteMacro.ts
git commit -m "fix(paste): correct byte estimation formula in pasteMacro.ts (#41)

estimateBatchBytes was using 6 + stepCount * 9, but executeMacroRemote
expands each MacroStep into 2 KeyboardMacroSteps (press + reset),
so the actual wire bytes are 6 + stepCount * 18. Also export the
function for use by executePasteText."
```

---

### Task 2: Replace inline batching in `executePasteText` with `buildPasteMacroBatches`

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:20` (import line)
- Modify: `ui/src/hooks/useKeyboard.ts:413-451` (inline batching code)
- Modify: `ui/src/hooks/useKeyboard.ts:484` (trace reporting)

- [ ] **Step 1: Update the import**

In `ui/src/hooks/useKeyboard.ts`, find line 20:

```typescript
import { buildStepsForChar, type KeyboardLayoutLike } from "@/utils/pasteMacro";
```

Replace with:

```typescript
import {
  buildPasteMacroBatches,
  estimateBatchBytes,
  type KeyboardLayoutLike,
} from "@/utils/pasteMacro";
```

This removes `buildStepsForChar` (will become unused after the next step) and adds the two new imports.

- [ ] **Step 2: Replace the inline batching loop**

In `ui/src/hooks/useKeyboard.ts`, find the block inside `executePasteText` starting at approximately line 413 (inside the `useCallback`):

```typescript
      const batches: MacroSteps[] = [];
      let currentBatch: MacroSteps = [];

      const estimateBytes = (logicalSteps: number) => 6 + logicalSteps * 18;

      const flushBatch = () => {
        if (currentBatch.length === 0) return;
        batches.push(currentBatch);
        currentBatch = [];
      };

      const invalidChars = new Set<string>();

      for (const char of text) {
        const normalizedChar = char.normalize("NFC");
        const charSteps = buildStepsForChar(normalizedChar, keyboard, delayMs);
        if (!charSteps) {
          invalidChars.add(normalizedChar);
          continue;
        }

        const projectedSteps = currentBatch.length + charSteps.length;
        const projectedBytes = estimateBytes(projectedSteps);

        if (
          currentBatch.length > 0 &&
          (projectedSteps > maxStepsPerBatch || projectedBytes > maxBytesPerBatch)
        ) {
          flushBatch();
        }

        currentBatch.push(...charSteps);
      }

      flushBatch();

      if (invalidChars.size > 0) {
        throw new Error(`Unsupported characters: ${Array.from(invalidChars).join(", ")}`);
      }
```

Replace that entire block with:

```typescript
      const { batches, invalidChars } = buildPasteMacroBatches(
        text,
        keyboard,
        delayMs,
        maxStepsPerBatch,
        maxBytesPerBatch,
      );

      if (invalidChars.length > 0) {
        throw new Error(`Unsupported characters: ${invalidChars.join(", ")}`);
      }
```

- [ ] **Step 3: Fix trace reporting**

In the same file, find the `onTrace` call inside the batch send loop (approximately line 484):

```typescript
          estimatedBytes: estimateBytes(batch.length),
```

Replace with:

```typescript
          estimatedBytes: estimateBatchBytes(batch.length),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run from `ui/`:
```bash
npx tsc --noEmit
```
Expected: No errors. If `noUnusedLocals` flags `MacroSteps` type as unused, check whether it's still used elsewhere in the file (it likely is, for `executeMacro` and `executePasteMacro` parameter types). If `buildStepsForChar` was only used in the removed code block, removing it from the import (done in Step 1) prevents an unused-import error.

- [ ] **Step 5: Run lint**

Run from `ui/`:
```bash
npx eslint src/hooks/useKeyboard.ts src/utils/pasteMacro.ts
```
Expected: No errors or warnings.

- [ ] **Step 6: Commit**

```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "refactor(paste): replace inline batching with buildPasteMacroBatches (#41)

executePasteText now delegates batch construction to the shared
buildPasteMacroBatches() function in pasteMacro.ts instead of
reimplementing the same loop inline. Trace reporting uses the
exported estimateBatchBytes(). Flow control and drain detection
are untouched."
```

---

### Task 3: Clean up `pasteBatches.ts` — delete dead code, slim profile type

**Files:**
- Modify: `ui/src/utils/pasteBatches.ts` (rewrite to ~12 lines)

- [ ] **Step 1: Rewrite `pasteBatches.ts`**

Replace the entire contents of `ui/src/utils/pasteBatches.ts` with:

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

This removes:
- `runPasteBatches()` function (lines 45-142) — dead code, never imported
- `BatchProgress` interface — only used by `runPasteBatches`
- `PasteTraceEntry` interface — only used by `runPasteBatches`
- `PasteBatchProfile` exported interface — replaced with unexported local `PasteProfile`
- `batchPauseMs` field — unused on the live path
- `import type { MacroStep }` — no longer needed

- [ ] **Step 2: Verify TypeScript compiles**

Run from `ui/`:
```bash
npx tsc --noEmit
```
Expected: No errors. `PasteModal.tsx` imports `PASTE_PROFILES` and `PasteProfileName` — both are retained. No other file imports the deleted types (verified by grep during research).

- [ ] **Step 3: Run lint on all changed files**

Run from `ui/`:
```bash
npx eslint src/utils/pasteBatches.ts src/components/popovers/PasteModal.tsx
```
Expected: No errors. `PasteModal.tsx` is unchanged but we lint it to confirm the retained exports are compatible.

- [ ] **Step 4: Commit**

```bash
git add ui/src/utils/pasteBatches.ts
git commit -m "refactor(paste): delete dead runPasteBatches code, slim profile type (#41)

Remove runPasteBatches(), BatchProgress, PasteTraceEntry, and the
exported PasteBatchProfile interface. Replace with unexported local
PasteProfile type containing only the 3 fields used by the live
paste path (maxStepsPerBatch, maxBytesPerBatch, keyDelayMs).
Drops unused batchPauseMs field."
```

---

### Task 4: Full verification pass

**Files:** None (read-only verification)

- [ ] **Step 1: Full TypeScript check**

Run from `ui/`:
```bash
npx tsc --noEmit
```
Expected: Clean — zero errors.

- [ ] **Step 2: Full lint check**

Run from `ui/`:
```bash
npx eslint './src/**/*.{ts,tsx}'
```
Expected: Clean — zero errors, zero warnings on changed files.

- [ ] **Step 3: Verify no remaining references to deleted code**

Run from repo root:
```bash
grep -r "runPasteBatches\|BatchProgress\|PasteTraceEntry\|PasteBatchProfile" ui/src/ --include="*.ts" --include="*.tsx"
```
Expected: Zero matches.

- [ ] **Step 4: Verify `buildStepsForChar` is not imported anywhere it shouldn't be**

Run from repo root:
```bash
grep -r "buildStepsForChar" ui/src/ --include="*.ts" --include="*.tsx"
```
Expected: Only appears in `ui/src/utils/pasteMacro.ts` (definition + internal usage). Should NOT appear in `useKeyboard.ts` anymore.

- [ ] **Step 5: Verify byte formula consistency**

Run from repo root:
```bash
grep -rn "stepCount \* 9\|stepCount \* 18\|logicalSteps \* 18\|estimateBytes\|estimateBatchBytes" ui/src/ --include="*.ts" --include="*.tsx"
```
Expected: Only `estimateBatchBytes` in `pasteMacro.ts` (definition, `6 + stepCount * 18`) and `useKeyboard.ts` (import + usage in trace). No inline `estimateBytes` lambda. No `* 9` formula anywhere.

- [ ] **Step 6: Verify batch boundary preservation**

Manually confirm that `buildPasteMacroBatches` uses the same flush logic as the removed inline code:
- Both iterate chars with `.normalize("NFC")`
- Both call `buildStepsForChar()`
- Both flush when `projectedSteps > maxStepsPerBatch || projectedBytes > maxBytesPerBatch`
- Both use the same byte formula (now corrected to `6 + stepCount * 18`)

Read `ui/src/utils/pasteMacro.ts:117-153` and confirm this matches.
