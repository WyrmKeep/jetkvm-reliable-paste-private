# Phase 3a — Derived-Constant Paste Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded magic-number byte caps in `PASTE_PROFILES` with a derivation path (`deriveProfile` helper) that computes `maxBytesPerBatch` from `estimateBatchBytes(maxStepsPerBatch) + HEADROOM_BYTES`, and enforce the invariant at module load via `assertProfilesReachable`, so `fast` packs more steps per batch than `reliable` as intended.

**Architecture:** Single-file rewrite of `ui/src/utils/pasteBatches.ts`. Import `estimateBatchBytes` from `./pasteMacro` (already exported). Add `HEADROOM_BYTES` constant, `deriveProfile()` helper, `assertProfilesReachable()` load-time check. Profile values: `reliable=deriveProfile(128, 3)`, `fast=deriveProfile(256, 2)`. The `PasteProfile` interface and `PasteProfileName` type export remain identical in shape so consumers in `PasteModal.tsx`, `useKeyboard.ts`, and `pasteMacro.ts` need zero changes.

**Tech Stack:** TypeScript 5, React 18, Vite. No new dependencies. Frontend only — Go side untouched.

**Spec:** `docs/superpowers/specs/2026-04-11-paste-profile-derived-constants-design.md`

**Scope lock (from spec §1 touch list):**
- **Touch:** `ui/src/utils/pasteBatches.ts` (single file)
- **Forbidden:** `ui/src/utils/pasteMacro.ts`, `ui/src/hooks/useKeyboard.ts`, `ui/src/components/popovers/PasteModal.tsx`, `package.json`, all Go sources

---

## Task 1: Rewrite `pasteBatches.ts` with derived constants and load-time assertion

**Files:**
- Modify: `ui/src/utils/pasteBatches.ts` (entire file, 12 lines → ~50 lines)
- Import-only (no modification): `ui/src/utils/pasteMacro.ts` (for `estimateBatchBytes` at line 36)

### Current state (for reference — do not write this)

```typescript
interface PasteProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
}

export const PASTE_PROFILES = {
  reliable: { maxStepsPerBatch: 128, maxBytesPerBatch: 1200, keyDelayMs: 3 },
  fast: { maxStepsPerBatch: 320, maxBytesPerBatch: 1100, keyDelayMs: 2 },
} satisfies Record<string, PasteProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;
```

### Steps

- [ ] **Step 1: Replace the entire file contents**

Write this exact content to `ui/src/utils/pasteBatches.ts`:

```typescript
import { estimateBatchBytes } from "./pasteMacro";

interface PasteProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
}

const HEADROOM_BYTES = 8;

function deriveProfile(
  maxStepsPerBatch: number,
  keyDelayMs: number,
): PasteProfile {
  return {
    maxStepsPerBatch,
    maxBytesPerBatch: estimateBatchBytes(maxStepsPerBatch) + HEADROOM_BYTES,
    keyDelayMs,
  };
}

function assertProfilesReachable(
  profiles: Record<string, PasteProfile>,
): void {
  for (const [name, p] of Object.entries(profiles)) {
    if (!Number.isFinite(p.maxStepsPerBatch) || p.maxStepsPerBatch <= 0) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: maxStepsPerBatch must be a positive finite number ` +
          `(got ${p.maxStepsPerBatch})`,
      );
    }
    if (!Number.isFinite(p.maxBytesPerBatch) || p.maxBytesPerBatch <= 0) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: maxBytesPerBatch must be a positive finite number ` +
          `(got ${p.maxBytesPerBatch})`,
      );
    }
    if (!Number.isFinite(p.keyDelayMs)) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: keyDelayMs must be a finite number ` +
          `(got ${p.keyDelayMs})`,
      );
    }
    const bytesAtCap = estimateBatchBytes(p.maxStepsPerBatch);
    if (bytesAtCap > p.maxBytesPerBatch) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: step cap unreachable ` +
          `(${p.maxStepsPerBatch} steps = ${bytesAtCap} bytes, ` +
          `byte cap = ${p.maxBytesPerBatch} bytes)`,
      );
    }
  }
}

export const PASTE_PROFILES = {
  reliable: deriveProfile(128, 3),
  fast: deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;
```

Key points the implementer must preserve verbatim:
- Import path `./pasteMacro` (relative, no extension) — matches existing module pattern in `ui/src/utils/`
- `HEADROOM_BYTES = 8` — do not change this number without updating the spec
- `deriveProfile(128, 3)` for reliable, `deriveProfile(256, 2)` for fast — exact values from spec §4.2
- `assertProfilesReachable(PASTE_PROFILES)` is a top-level call, placed AFTER the `PASTE_PROFILES` export and BEFORE the `PasteProfileName` type export — this order is load-bearing: the assertion must run at module evaluation time, and the type export must come last so it can still reference `PASTE_PROFILES`
- Error message format is exact — preserved so future debuggers can grep for it
- No other files are touched — if the implementer touches `pasteMacro.ts`, `useKeyboard.ts`, or `PasteModal.tsx`, reject the change

- [ ] **Step 2: Run `tsc --noEmit` to verify the rewrite type-checks**

Run: `cd ui && npx tsc --noEmit`

Expected: exit code 0, no output. The `PasteProfile` interface is unchanged in shape, so all three consumer sites (`PasteModal.tsx:118,129-130`, `useKeyboard.ts:111-112,645-658`, `pasteMacro.ts:114-117`) continue to type-check without modification.

If `tsc` reports an error in `pasteBatches.ts`: re-check the import path and the field names in `deriveProfile`'s return value.

If `tsc` reports an error in any OTHER file: STOP. The scope was violated — a consumer shape assumption has been broken. Revert and report the consumer path, field name, and error.

- [ ] **Step 3: Run ESLint on the frontend tree**

Run: `cd ui && npx eslint './src/**/*.{ts,tsx}'`

Expected: any new errors originating from `pasteBatches.ts` are blocking.

**Known pre-existing noise (non-blocking, per CLAUDE.md):**
- 600+ `prettier/prettier` CRLF errors on Windows from `core.autocrlf=true` (working-copy artifact; committed blobs are LF)
- Pre-existing drift in `Button.tsx`, `PasteModal.tsx`, `pasteMacro.ts`, `stores.ts` on main since 2026-03-15 — not caused by this phase

If eslint reports any error whose file path contains `pasteBatches.ts` that is NOT a prettier CRLF error, FIX IT before proceeding. Real lint errors in our file are blocking.

To confirm a `pasteBatches.ts` prettier error is a CRLF artifact (not a real issue):
```bash
git cat-file -p HEAD:ui/src/utils/pasteBatches.ts | tr -d -c '\r' | wc -c
```
Expected output: `0`. If `0`, the committed blob is LF — the local error is a working-copy artifact and can be ignored.

- [ ] **Step 4: Go side sanity check**

Run: `go vet ./...`

Expected: exit code 0, same result as pre-patch. This phase touches zero Go files; any new `go vet` finding is unrelated and not blocking.

Skip `go build ./...` unless `make build_native` has already run locally; buildkit-based CI is the authoritative Go gate per CLAUDE.md. Phase 3a is frontend-only so this is a sanity smoke test, not a merge gate.

- [ ] **Step 5: Commit the implementation**

```bash
git add ui/src/utils/pasteBatches.ts
git commit -m "$(cat <<'EOF'
fix(paste): derive profile byte caps from step counts (#40)

Replace hardcoded maxBytesPerBatch magic numbers with deriveProfile()
that computes the byte ceiling from estimateBatchBytes(steps) plus
HEADROOM_BYTES. Profile values retune to reliable=128 / fast=256
steps/batch now that Phase 2 (#38) has landed, restoring the intended
fast > reliable speed gap.

Add assertProfilesReachable() as a module-load guard that throws if
any profile ships with an unreachable step cap, catching future
regressions before any paste can execute.

No changes to estimateBatchBytes, no changes to consumers
(PasteModal.tsx, useKeyboard.ts, pasteMacro.ts) — the PasteProfile
interface shape is preserved.

Closes #40

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify the commit landed: `git log --oneline -1`. Expected first line matches `fix(paste): derive profile byte caps from step counts (#40)`.

### Rollback condition

If any of Steps 2–4 fail with an error in a forbidden file (anything other than `pasteBatches.ts`), revert uncommitted changes with `git restore ui/src/utils/pasteBatches.ts` and STOP. Report the exact error to the orchestrator — the scope has been violated and the implementation must be re-examined.

If Step 2 (`tsc --noEmit`) fails IN `pasteBatches.ts`, re-read the file, confirm the import path and field names against this plan's Step 1 code block verbatim, and retry.

---

## Verification summary (runs after Task 1 in Step 6 of the orchestrator workflow)

The orchestrator runs these commands independently from the implementation teammate, as a verification gate:

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
cd .. && go build ./... && go vet ./...
```

- **`tsc --noEmit`**: must pass with zero errors
- **`eslint`**: pre-existing CRLF noise and pre-existing drift (Button.tsx, PasteModal.tsx, pasteMacro.ts, stores.ts) are known and acceptable; any new error in `pasteBatches.ts` from this phase is blocking
- **`go build ./...`**: may require `make build_native` first locally; if it fails on missing C artifacts, defer to the CI `golangci-lint.yml` authoritative gate. This phase touches zero Go files.
- **`go vet ./...`**: must report nothing new from this phase

Runtime verification (manual, post-merge device check):
1. Boot the dev server and confirm `pasteBatches.ts` imports without the assertion firing
2. Paste a 10k-char test string in fast mode; confirm it completes noticeably faster than the same string in reliable mode
3. Confirm in browser devtools that fast mode produces roughly half the number of batches vs reliable for the same paste size

---

## Out-of-scope work (explicitly forbidden this phase)

Per spec §3:
- No changes to `estimateBatchBytes` in `pasteMacro.ts` (frozen single source of truth)
- No changes to `useKeyboard.ts` execution logic
- No changes to `PasteModal.tsx` (the UI reads the profile object indirectly and gets derived values for free)
- No `package.json` changes (vitest comes in Phase 5)
- No new `ui/scripts/` directory or external verification script (superseded by the runtime assertion)
- No changes to `PASTE_LOW_WATERMARK` / `PASTE_HIGH_WATERMARK` (Phase 2's territory)
- No changes to the 200ms inter-macro sleep in `jsonrpc.go:1078` (Go side, not this phase)
- No changes to any Go file

---

## Self-review notes

**Spec coverage:**
- Spec §4.2 values (128/256, keyDelay 3/2) — covered in Task 1 Step 1
- Spec §4.3 `deriveProfile` helper — covered in Task 1 Step 1
- Spec §4.4 `assertProfilesReachable` — covered in Task 1 Step 1
- Spec §5 invariants I-1 through I-8 — structurally enforced by the code in Task 1 Step 1 (I-1 via derivation + assertion, I-2 via zero changes to `pasteMacro.ts`, I-3 via unchanged interface shape, I-4 via the 128/256 values inside safe zone, I-5 via top-level assertion ordering, I-6 via unchanged keyDelayMs, I-7 via zero changes to `buildPasteMacroBatches`, I-8 via single-file scope)
- Spec §6 Race A (module-load ordering) — structurally safe because `pasteMacro.ts` has no import from `pasteBatches.ts`
- Spec §7 acceptance criteria — all four satisfied by the single rewrite in Task 1
- Spec §8 verification commands — reproduced in the verification summary above
- Spec §9 rollback — Task 1 rollback condition covers it

**Placeholder scan:** no TBD, no TODO, no "implement later", no "add appropriate error handling", no aspirational test code, no cross-task "similar to Task N" references. Every code block is verbatim final content.

**Type consistency:** `PasteProfile` interface fields `maxStepsPerBatch: number`, `maxBytesPerBatch: number`, `keyDelayMs: number` — consistent between the interface definition, the return type of `deriveProfile`, the parameter type of `assertProfilesReachable`, and the three existing consumer sites (verified by the researcher in Section 3 of the research report).

**Scope check:** single file, single task, well within a single implementation plan.
