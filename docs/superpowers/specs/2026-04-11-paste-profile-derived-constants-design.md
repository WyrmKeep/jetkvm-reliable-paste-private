# Phase 3a Design — Derived-Constant Paste Profiles

**Date:** 2026-04-11
**Phase:** 3a of the paste-reliability rollout
**Primary issue:** #40 — "bug: Fast-mode batch byte limit is ineffective (1100 vs 2886 actual)"
**Branch:** `fix/paste-profile-derived-constants`
**Scope:** frontend-only, `ui/` subdirectory
**Touch list (STRICT):** `ui/src/utils/pasteBatches.ts` only
**Forbidden files:** `ui/src/utils/pasteMacro.ts` (frozen `estimateBatchBytes` — import only), `ui/src/hooks/useKeyboard.ts` (execution logic), `ui/src/components/popovers/PasteModal.tsx` (no user-facing change), `package.json`, all Go sources

## 1. Problem

After PR #47 fixed the wire-byte formula to `6 + stepCount * 18` (press+reset expansion in `executeMacroRemote` at `useKeyboard.ts:321-322`), the current profile values in `pasteBatches.ts` are:

```typescript
reliable: { maxStepsPerBatch: 128, maxBytesPerBatch: 1200, keyDelayMs: 3 }
fast:     { maxStepsPerBatch: 320, maxBytesPerBatch: 1100, keyDelayMs: 2 }
```

Against the corrected formula:

- **reliable** byte cap `(1200 − 6) / 18 = 66.33` → **66 steps** before the byte limit wins. The declared `128` step cap is **unreachable**.
- **fast** byte cap `(1100 − 6) / 18 = 60.78` → **60 steps** before the byte limit wins. The declared `320` step cap is **unreachable**.

Result: `fast` packs *fewer* steps per batch (60) than `reliable` (66). Combined with the 200 ms inter-macro drain delay in `drainMacroQueue` (`jsonrpc.go:1078`, untouched in this phase), more batches → more drains → more total paste latency. **`fast` mode is measurably slower than `reliable` mode**, which is the opposite of the intended UX. This was verified against the current tree in the Step 2 research report — all numbers reproduce exactly.

Phase 2 (PR #52, closing #38) added a chunk-aware large-paste layer but intentionally left `PASTE_PROFILES` untouched so Phase 3a would have a clean slate.

## 2. Goal

Replace the hardcoded magic-number byte caps with a single derivation path: declare the intended step count per profile, derive the byte ceiling from `estimateBatchBytes(steps) + HEADROOM_BYTES`, and fail fast at module load if any profile ships with an unreachable step cap.

Restore `fast > reliable` steps-per-batch as a user-visible speed gap, and lock in the invariant that the step cap is always the binding constraint.

## 3. Non-goals (explicit out-of-scope)

- Changing `estimateBatchBytes` — it is the single source of truth (CLAUDE.md). This phase imports it, does not modify it.
- Changing `useKeyboard.ts` or any execution logic — Phase 3a is config-only.
- Changing `PasteModal.tsx` — no user-facing surface change.
- Changing the 200 ms inter-macro sleep in `drainMacroQueue` — Go side, not this phase.
- Adding vitest — `package.json` is forbidden in Phase 3a per the rollout plan; adding it is Phase 5's scope.
- Creating a new `ui/scripts/` directory for an out-of-process verification script — superseded by the runtime assertion.
- Retuning `PASTE_LOW_WATERMARK` / `PASTE_HIGH_WATERMARK` — Phase 2's territory.
- Any change to Go sources.

## 4. Design

### 4.1 Approach — Option B (retune larger on consolidated batching)

The issue proposed `reliable=96` / `fast=160` conservatively and noted "start conservative and tune after #38 lands. Chunk-aware sender in #38 will make larger batches safer." #38 has landed (PR #52). Tune upward now while still staying well inside the WebRTC SCTP safe zone.

### 4.2 Values

| Profile  | `maxStepsPerBatch` | `keyDelayMs` | Derived wire bytes (`6 + steps*18`) | Share of 16 KiB safe zone |
|----------|--------------------|--------------|-------------------------------------|---------------------------|
| reliable | 128                | 3            | 2310                                | 14 %                      |
| fast     | 256                | 2            | 4614                                | 28 %                      |

Both comfortably under the 16 KiB cross-browser WebRTC data-channel fragmentation threshold documented in the researcher's Section 5 (sources: lgrahl.de, Mozilla WebRTC blog, RFC 8831, Pion docs). Chrome, Firefox, Safari, and Pion all handle messages well past 16 KiB, but 16 KiB is the practical cross-browser floor.

`keyDelayMs` values are preserved — reliable stays at 3 ms for host catch-up headroom, fast stays at 2 ms for throughput. No rationale to move them in this phase.

### 4.3 Derivation helper

```typescript
import { estimateBatchBytes } from "./pasteMacro";

interface PasteProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
}

// Headroom above the exact byte count for the declared step cap.
// Keeps the step cap as the binding constraint at batch-flush time
// even if future rounding or alignment adds a few bytes.
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
```

`estimateBatchBytes` is already exported from `pasteMacro.ts:36` — no changes needed on the `pasteMacro` side.

### 4.4 Runtime assertion

```typescript
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
  fast:     deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;
```

The assertion runs once at module-load time in the browser. If a future commit ships a profile whose byte cap is smaller than `estimateBatchBytes(maxStepsPerBatch)` — for example, a manual regression that bypasses `deriveProfile` — the UI fails fast with a clear diagnostic. The assertion is cheap (two multiplications per profile) and runs before any paste can execute, so there is no risk of a partial paste under a misconfigured profile.

The assertion also serves as the acceptance-criterion "unit test or CI script catches unreachable step caps" without requiring `package.json` changes (forbidden this phase) or a new `ui/scripts/` directory.

### 4.5 Why `PasteProfile` shape is preserved

Consumers read `maxStepsPerBatch` and `maxBytesPerBatch` as independent numeric fields. The derivation happens at construction time, and the resulting object is structurally identical to the current shape. No consumer changes are required.

Verified consumers (from researcher Section 3):

- `PasteModal.tsx:50` — `useState<PasteProfileName>("reliable")`, reads via `PASTE_PROFILES[pasteProfile]` at line 118, destructures both fields at lines 129–130
- `useKeyboard.ts:111-112` (interface shape), `:645-658` (forwards both fields to `buildPasteMacroBatches`)
- `pasteMacro.ts:114-117` (consumes both fields in the flush condition at line 156)

## 5. Correctness invariants

This section is the load-bearing part of the spec for the Oracle cross-review.

### Invariant I-1 — step cap is the binding constraint

For every profile `p` in `PASTE_PROFILES`, `estimateBatchBytes(p.maxStepsPerBatch) <= p.maxBytesPerBatch`. Enforced structurally by `deriveProfile` (byte cap is computed from the step cap plus positive headroom) and verified at module load by `assertProfilesReachable`. If both are present and the assertion passes, `buildPasteMacroBatches` will always flush on the step cap, not the byte cap, when a batch reaches the declared size.

### Invariant I-2 — `estimateBatchBytes` remains the single source of wire-byte truth

The formula `6 + stepCount * 18` is owned by `pasteMacro.ts:36-42` and is NOT modified in this phase. `pasteBatches.ts` consumes it through a normal TypeScript import. Any future change to the wire format must update `estimateBatchBytes` once; the profiles self-correct.

### Invariant I-3 — `PasteProfile` interface shape is preserved

Fields: `maxStepsPerBatch`, `maxBytesPerBatch`, `keyDelayMs`. Types: `number`. All three consumers (Section 4.5) continue to read the same field names with the same types. Zero changes at consumer sites.

### Invariant I-4 — both profiles remain well inside the WebRTC SCTP cross-browser safe zone

The derived wire-byte counts (2310 for reliable, 4614 for fast) are under 30% of the 16 KiB cross-browser message-size floor. No host-side fragmentation or reassembly concerns. No risk of Chromium closing the data channel for oversized messages (hard limit is 256 KiB per the Pion docs).

### Invariant I-5 — load-time assertion fires before any paste can execute

`assertProfilesReachable(PASTE_PROFILES)` is called at the top level of `pasteBatches.ts` after the `PASTE_PROFILES` export, before the `PasteProfileName` type export. ES module evaluation is synchronous at top level; any consumer that imports from `pasteBatches.ts` will trigger the assertion before its own code runs. If the assertion throws, the import itself fails, which surfaces in the dev-server boot and in production as a fatal module-load error. No paste can run with a misconfigured profile.

### Invariant I-6 — `keyDelayMs` values and semantic meaning preserved

`reliable.keyDelayMs = 3`, `fast.keyDelayMs = 2`. These values already ship on main and are passed through `buildPasteMacroBatches` into the per-step macro construction. This phase does not touch them.

### Invariant I-7 — no change to batch-flush logic in `buildPasteMacroBatches`

`pasteMacro.ts:156` still flushes on `projectedStepCount > maxStepsPerBatch || projectedBytes > maxBytesPerBatch`. With the derived byte cap, the byte clause is no longer independently binding at or below `maxStepsPerBatch`; it may still fire in the same iteration as the step clause when a projected batch would overflow the declared step cap (because `estimateBatchBytes(maxStepsPerBatch + 1) > maxBytesPerBatch` when `HEADROOM_BYTES < 18`). The OR clause is retained as defense-in-depth and as a safety net if `estimateBatchBytes` ever grows a variable per-step contribution.

### Invariant I-8 — Phase 1 paste-depth and Phase 2 chunk-aware invariants remain intact

No changes to `pasteDepth` atomic counter logic, `queuedMacro.session` wiring, `waitForPasteDrain` helper, or `partitionBatchesByChunkChars`. This phase changes only the profile-construction path in one file.

## 6. Race walkthrough

Phase 3a is pure static config. There is one narrow ordering consideration and no new concurrency:

### Race A — module-load ordering

**Trigger:** a consumer file (e.g., `PasteModal.tsx`) imports from `pasteBatches.ts`, which in turn imports `estimateBatchBytes` from `./pasteMacro`.

**Analysis:** ES module graphs are resolved and top-level bodies are executed in dependency order. `pasteMacro.ts` has no import from `pasteBatches.ts`, so there is no cycle. `estimateBatchBytes` is defined at `pasteMacro.ts:36-42` and is exported as a named function declaration, which is fully initialized before any importer's top-level code runs. `deriveProfile` can safely call `estimateBatchBytes` at the top level of `pasteBatches.ts`. `assertProfilesReachable` runs after `PASTE_PROFILES` is constructed, also at the top level, and throws synchronously if the invariant is violated.

**Outcome:** no race. Module loading is deterministic and synchronous at the top level.

### Race B — HMR and development reloads

**Trigger:** Vite HMR reloads `pasteBatches.ts` after an edit.

**Analysis:** HMR re-executes the module body, which re-runs `deriveProfile` and `assertProfilesReachable`. If a developer ships a bad profile mid-session, HMR surfaces the error in the browser console immediately rather than letting the old module linger.

**Outcome:** no hazard. HMR is our friend here — it amplifies the guard.

## 7. Acceptance criteria

Maps directly to the issue body:

- [ ] **`fast` produces measurably more steps per batch than `reliable` in a 10k-char test** — satisfied by `fast.maxStepsPerBatch=256` vs `reliable.maxStepsPerBatch=128`. Verified numerically: with a 10k-char paste, reliable produces ~79 batches (10000 / 128 rounded up) and fast produces ~40 batches (10000 / 256 rounded up).
- [ ] **Profile definitions use derived byte limits (not hardcoded magic numbers)** — satisfied by `deriveProfile(steps, keyDelayMs)` helper which computes `maxBytesPerBatch` from `estimateBatchBytes(steps) + HEADROOM_BYTES`.
- [ ] **Unit test or CI script catches unreachable step caps** — **partially satisfied.** `assertProfilesReachable` provides runtime fail-fast protection at module load (dev server boot, production bundle evaluation, HMR reload) and rejects non-finite, non-positive, or unreachable profile configs. However, it does **not** satisfy issue #40's literal "unit test or CI script" requirement because Phase 3a's verification path (`tsc --noEmit` + `eslint`) does not execute module code, so the assertion is not invoked during CI. Automated CI regression coverage is deferred to Phase 5 (vitest harness, issue #45), which will add a unit test that imports `PASTE_PROFILES` and exercises the assertion. Phase 3a therefore fixes the profile math and adds fail-fast runtime coverage; the "automated CI gate" portion of AC3 is explicitly deferred.
- [ ] **No wire-format size exceeds known WebRTC SCTP safe limits in either profile** — satisfied by the 14 % / 28 % share of the 16 KiB cross-browser floor documented in Section 4.2.

## 8. Verification commands

Per CLAUDE.md's verification rules:

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
```

Expected:
- `tsc --noEmit` passes with zero errors (both files compile against the existing `PasteProfile` interface)
- `eslint` may emit pre-existing CRLF noise on Windows (600+ prettier errors from `core.autocrlf=true`, per CLAUDE.md); committed blobs are LF and `golangci-lint` on the Go side is the real merge gate, but this phase is frontend-only so the CI gate is `ui-lint` — known failing on main since 2026-03-15 on unrelated files; any new failures in `pasteBatches.ts` from this PR are blocking

Go side is untouched, but a sanity pass is allowed:

```bash
go build ./... && go vet ./...
```

Expected: unchanged from pre-patch (this phase touches zero Go files).

Runtime verification (reproducibility note: the `PasteModal` delay path reads `debugMode ? delay : profile.keyDelayMs`, so meaningful timing comparisons require debug mode OFF; the batch-count math below also assumes a one-wire-step-per-character corpus, which is true for plain ASCII but NOT for decomposed Unicode or dead keys that may expand into multiple MacroSteps):

1. Boot the dev server (`cd ui && npm run dev`) and confirm `pasteBatches.ts` imports without `assertProfilesReachable` firing
2. With **debug mode OFF**, paste a corpus of 10,000 ASCII `a` characters. Confirm fast completes sooner than reliable on the same corpus.
3. In browser devtools, confirm the batch counts emitted by `buildPasteMacroBatches`: reliable should produce ~79 batches (10000 / 128 rounded up) and fast should produce ~40 batches (10000 / 256 rounded up). The fast batch count must be strictly smaller than the reliable batch count.

## 9. Rollback

Single commit, single file changed. Revert with `git revert <sha>` — profiles return to the existing 128/1200 and 320/1100 values. The inversion bug returns with them, but correctness of the rest of the paste pipeline is unaffected because no consumer or execution path changes.

## 10. Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Larger fast batches trigger cross-browser fragmentation | Low | Both profiles are ≤ 28 % of the 16 KiB floor; verified against Mozilla, RFC 8831, Pion, lgrahl.de sources in Section 5 of research report |
| Derived byte cap accidentally becomes smaller than `estimateBatchBytes(steps)` | Blocked | `deriveProfile` structurally prevents this; `assertProfilesReachable` is a defense-in-depth belt-and-braces check |
| Host USB HID input queue saturates at 256 steps per batch | Low | `keyDelayMs=2` (unchanged) and the 200 ms inter-macro drain in `drainMacroQueue` (unchanged) both absorb host backlog; Phase 2's chunk-aware sender also absorbs backlog at chunk boundaries |
| Runtime assertion fires in production on a bad refactor | Intended | That is the feature — fail fast at module load rather than silently shipping an inverted profile |
| `estimateBatchBytes` formula changes in a future phase | Low | Both profiles self-correct because the byte cap is derived from it at module load |
| Phase 4 or 5 touches `pasteBatches.ts` unknowingly | Low | Forbidden list in this spec + phase touch-list enforcement in the orchestrator workflow |

## 11. Dependencies

- Phase 1 (#49) merged — provides the paste-depth semantics and shallow queue this phase runs on top of
- Phase 2 (#52, closing #38) merged — provides the chunk-aware sender and large-paste safe mode this phase retunes against
- `estimateBatchBytes` exported from `pasteMacro.ts:36` (already exported on main)

No new dependencies.

## 12. Open questions

None. This is a single-file config change with a well-defined math fix and a runtime guard. The brainstorm settled all design questions; the research report confirmed all consumer wiring.
