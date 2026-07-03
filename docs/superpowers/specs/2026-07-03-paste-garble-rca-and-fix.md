# Paste garble RCA and fix specification

**Date:** 2026-07-03
**Status:** M1 spec complete, M2 fixes pending
**Primary campaign:** `tools/paste-harness/campaigns/f8-replication-campaign-20260703/`
**Validation assertion:** A-E3

## Scope

This spec turns the F8 replication campaign into the M2 and M3 acceptance contract for paste garbling. It covers the user-visible garble class, layout mismatch, product-path completion, and the full soak matrix. It does not implement firmware or UI fixes.

Binding rules for this spec:

- Use only the clean F8 rows named in `campaign-summary.md` for thresholds. The stale-Notepad product angle row `20260703190840598-q9q5me` and contaminated trigger row `20260703191710394-735kpg` are explicitly excluded by append-only ledger annotations.
- Garble-class events must be zero everywhere: layout-swap signatures, stuck-modifier runs, insertion/autorepeat storms, and any corruption after a `<>` region.
- Reliable thresholds are no looser than 2x the measured F8 band for the comparable size and sink.
- Fast thresholds use their own measured profile band: 0.05% to 0.12% loss is expected, and >0.24% is a failure.
- Repair-assisted byte-perfect claims are only valid at sizes ≤6k with calibration engaged. Manual fallback rows are excluded and rerun.
- Cells >6k use fast-chunked/count-verify mode, not full auto-repair.
- Symbol-heavy cells are verified by SSH byte-exact readback only. OCR can be a progress aid, never the pass/fail oracle.

## Problem statement

Users report that pasting text containing `<>` through JetKVM can garble following text in Notepad. F8 showed that `<>` itself is not a special mapping trigger, since `<` and `>` map the same on US and UK layouts. The likely user-visible failures are:

1. Deterministic US-vs-UK layout crossover for nearby symbols such as `@`, `"`, `#`, `~`, `\`, `|`, and `£`.
2. Stuck-modifier or autorepeat storms after a lost clear/release report, which can make later text look random.
3. Product-path completion races where multi-batch pastes finish delivering bytes but never emit the app's `done:` trace, leaving the harness and UI in a failed or stale state.
4. Sparse loss/race errors that are not garble, but must remain bounded so they do not mask garble fixes.

The fix plan therefore separates garble-class bugs from bounded loss and race-class noise. Loss can be repaired or count-verified. Garble cannot be accepted or repaired away.

## Evidence inputs

Primary files:

- F8 summary: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/campaign-summary.md`
- F8 reclassified summary: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/campaign-summary-reclassified.md`
- F8 ledger: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/ledger.jsonl`
- F8 dashboard: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/dashboard.html`
- F8 triangulation: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/artifacts/20260703191153730-w1ujt4/triangulation.md`
- Classifier validation: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/classifier-self-validation.json`
- Classifier 1.0.1 validation: `tools/paste-harness/campaigns/f8-replication-campaign-20260703/classifier-self-validation-1.0.1.json`

Code suspects and invariants:

- `jsonrpc.go:1360-1364`: mid-macro `rpcKeyboardReport` error returns without an all-clear report.
- `jsonrpc.go:1052-1056`: wake-tap Shift release failure is warn-only.
- `jsonrpc.go` paste-depth semantics: state emits only on 0->1 and 1->0 edges.
- `ui/src/hooks/useKeyboard.ts`: product paste trace, `waitForPasteDrain`, chunk boundaries, and `done:` trace emission.
- `ui/src/hooks/useHidRpc.ts:215-222`: unreliable-channel requested path silently drops when the unreliable channel is not ready.
- Upstream candidates: jetkvm/kvm#1369, #1438, #1387, #1364. Do not port #1339 and do not rebase wholesale.

## F8 measured data

F9b re-ran the fixed classifier (`paste-harness-classifier/1.0.1`) over the clean F8 recv snapshots named in `campaign-summary.md`. No per-class vectors used by this spec changed, so the numeric threshold tables below remain unchanged. The reclassified artifact records the checked row set and the append-only manual exclusions.

### Baseline re-anchor and rate sensitivity

The accepted M1 baseline is raw hidtype at rate75, not the older 91cps assumption. All accepted rows used fresh Notepad RSS <250MB, calm host telemetry, UK layout pinned, focus guard pass, and `garble_events_pre_repair=0`.

| Run | Path | Corpus | Rate | Size | Classifier vector | Edit-distance spot check | Garble | Excluded |
|---|---|---|---:|---:|---|---:|---:|---|
| `20260703182636516-amrcq7` | raw | `baseline-control-6000.txt` | 75cps | 6k | drop=1, case=2 | 3/6000 = 0.05% | 0 | false |
| `20260703182855170-8zt5pb` | raw | `baseline-control-6000.txt` | 75cps | 6k | drop=1, case=2 | 3/6000 = 0.05% | 0 | false |
| `20260703183027462-wfq3ey` | raw | `baseline-control-6000.txt` | 75cps | 6k | drop=1, case=2 | 3/6000 = 0.05% | 0 | false |

91cps was marginal on this rig after hygiene and is retained only as rate-sensitivity evidence:

| Run | Rate | Classifier vector | Edit-distance spot check | Accuracy |
|---|---:|---|---:|---:|
| `20260703181638871-3glzpk` | 91cps | drop=58, insertion=56, case=2 | 6/6000 = 0.10% | 99.90% |
| `20260703181836896-btli1s` | 91cps | drop=117, insertion=115, case=2 | 7/6000 = 0.1167% | 99.8833% |
| `20260703181955225-donmy9` | 91cps | drop=48, insertion=46, case=2 | 6/6000 = 0.10% | 99.90% |

**Pinned rate rule:** F13 and F14 baseline and Reliable raw controls use rate75. HIDRPC Reliable targeted controls use the F8 11ms delay. Product-path Reliable uses the UI Reliable profile, but thresholds are anchored to the rate75/11ms measured band until product multi-batch completion is fixed and re-measured.

### Clean replication rows

| Group | Runs | Completed | Chars | Classifier counts | Edit-distance spot checks | Garble | Threshold use |
|---|---:|---:|---:|---|---|---:|---|
| raw angle-dense 2k, rate75 | `20260703183755273-tehtbt`, `20260703183834136-y0voci`, `20260703183912982-eb7siz` | 3/3 | 6000 | drop=493, insertion=492, same-length=9 | 8/2000, 8/2000, 9/2000 | 0 | Targeted raw angle cells, with classifier caveat |
| raw shifted-symbol 2k, rate75 | `20260703183951810-ld41xr`, `20260703184030601-3huqvv`, `20260703184109500-8d2utr` | 3/3 | 6000 | all classes 0 | 0/2000 each | 0 | Targeted raw shifted cells |
| hidrpc angle-dense 2k, 11ms | `20260703184212026-tdzjzm`, `20260703184300548-80v3gl`, `20260703184348826-2fnhjn` | 3/3 | 6000 | same-length=3, case=6 | 3/2000 each | 0 | Targeted HIDRPC angle cells |
| hidrpc shifted-symbol 2k, 11ms | `20260703184437197-h4r8bq`, `20260703184530845-9ua5ye`, `20260703184624446-jqxm52`, `20260703192607422-q2y58a` | 4/4 | 8000 | drop=1 | 0/2000, 1/2000, 0/2000, 0/2000 | 0 | Targeted HIDRPC shifted cells |
| product angle-dense single-batch | `20260703190900575-hqhyby`, `20260703190920099-8rigjx`, `20260703192248428-6kk6nh` | 3/3 | 165 | all classes 0 | 0/55 each | 0 | Product single-batch sanity |
| product shifted-symbol single-batch | `20260703190939291-bkinyy`, `20260703190958780-rm25xj`, `20260703191018709-hyjqf5`, `20260703192701004-d29m0p` | 4/4 | 204 | all classes 0 | 0/51 each | 0 | Product single-batch sanity |

### Excluded and diagnostic rows

- `20260703190840598-q9q5me` is excluded from thresholds. It is a product angle single-batch row with 2870 inserted chars over a 55-char expected corpus. F8 traced this to stale unsaved Notepad content after prior product no-`done:` failures. The clean replacement rows are the three product angle rows listed above.
- `20260703191710394-735kpg` is excluded from thresholds. It is an A-E8 trigger row whose recv snapshot retained stale product-240 no-`done:` residue from `20260703191320547-z3gesv`, inflating insertion=219.
- Product 500-char multi-batch rows in `campaign-summary.md` are no-`done:` diagnostics, not accuracy threshold rows. They are excluded from pass/fail bands until A-F11/F12b is fixed.

### Layout mismatch and triangulation

The empirical layout probe `20260703180008814-nn6sd4` recorded host decode layout `en-UK` with no layout-swap errors. The deliberate mismatch row `20260703191153730-w1ujt4` used a US HID encoder against the UK host and produced:

- Vector: drop=6, insertion=1, same-length=15, layout-swap-signature=12.
- Garble: 12.
- Triangulation verdict: `host-mangled`.

The F8 triangulation artifact re-decodes the same tee bytes as the US-intended string and as the UK host string. This proves the mismatch class is deterministic host interpretation of otherwise consistent device reports, not random device byte emission.

### Product multi-batch completion bug

Two independent builds show the same product-path completion failure:

| Run | Build | Size | Result |
|---|---|---:|---|
| `20260703191320547-z3gesv` | `worklaptopjetkvm:0b66afc5aef2` | 240 chars, 2 batches | no `done:` within 180000ms, trace stuck after `batch 2/2` |
| `20260703192823519-3spctv` | `worklaptopjetkvm:c7dda26bedec` | 240 chars, 2 batches | no `done:` within 180000ms, tee_lines=482, trace stuck after `batch 2/2` |

The second row proves delivery activity existed on the current F8 build, but the product trace never emitted completion. This is now assertion A-F11 and feature F12b. It must be fixed before any product multi-batch soak row is used as an accuracy threshold row.

## Root-cause analysis

### RCA-1: Layout mismatch is a deterministic garble class

The F8 mismatch row and triangulation artifact prove that layout crossover can create visible symbol swaps that look like garbling. The device can send a coherent US-intended report sequence while the host decodes it with UK semantics.

M2 action:

- Keep device `.110` and `.36` at `en-UK` for this rig.
- Gate every run on empirical host decode layout, not display locale.
- Add detect/warn behavior if the device layout and host empirical layout mismatch.
- Keep a deliberate mismatch cell in validation to prove the classifier still catches the crossover.

### RCA-2: Mid-macro write errors can leave the host holding a key or modifier

`jsonrpc.go:1360-1364` currently returns immediately when `rpcKeyboardReport(step.Modifier, step.Keys)` fails. It does not send a best-effort all-clear. The cancel paths at `jsonrpc.go:1379-1405` already do send a clear report, which makes the missing clear on the error path stand out.

If the failed report or preceding state leaves Shift plus a symbol key logically down on the host, Windows can autorepeat or keep Shift applied to later characters. This matches the "post-`<>` random text" symptom class even though `<` and `>` themselves are not special.

M2 action:

- Add `JETKVM_PASTE_WRITE_FAIL=N` to exercise real error returns. `JETKVM_PASTE_DROP` is insufficient because it returns nil.
- On any mid-macro write error, attempt `rpcKeyboardReport(0, keyboardClearStateKeys)` before returning the error.
- Tee must show failed-write followed by all-clear attempt. Readback must show no stuck-shift run at that point.

### RCA-3: Wake-tap Shift release is warn-only

`jsonrpc.go:1052-1056` logs and continues if the wake-tap release fails. That means the first content macro can start while Shift is possibly still held. The failure mode is exactly a shifted run at paste start.

M2 action:

- Retry the wake-tap release up to a bounded K.
- If release still fails, abort the paste before any content macro and emit a failed paste state.
- Add `JETKVM_PASTE_WRITE_FAIL=wake-release` to verify single-fail retry and all-fail abort.

### RCA-4: Upstream races still matter

The following upstream fixes remain in scope because they can produce or amplify stuck state:

- #1369 keyboardMutex: hold one mutex across keypress read, compute, write, and state update.
- #1438 modifiers-out-of-auto-release: never schedule auto-release timers for modifier keycodes, and clear/cancel timers on session takeover.
- #1387 keepalive starvation: do not cancel and restart the 50ms keepalive on every browser key repeat.
- #1364 reliable-channel fallback: when the unreliable HIDRPC channel is not ready, send over the reliable channel instead of silently dropping.

M2 action:

- Port only these targeted changes. Do not port #1339, do not merge PR #37 wholesale, and preserve the fork paste invariants in `CLAUDE.md`.

### RCA-5: Product multi-batch `done:` trace bug is a separate completion failure

F8 row `20260703192823519-3spctv` shows a 2-batch product paste that did not emit `done:` even though the tee captured 482 report lines. The trace stopped at `batch 2/2`.

Likely suspects:

- Frontend `executePasteText` final best-effort drain and trace finalization.
- `waitForPasteDrain` arm-window behavior when batches are queued back to back.
- Device pasteDepth edge semantics around multiple queued paste macros, where `State:false` is only emitted on the final 1->0 edge.
- Session/channel filtering in the `KeyboardMacroStateMessage` handler.

M2 action:

- Implement F12b with unit tests where extractable and rig validation of ≥3 consecutive 2-batch product runs plus ≥1 3-batch run, all with `completion_signal=done-trace`.
- After any product no-`done:` failure during validation, force close/reopen Notepad before the next product row.

### RCA-6: Classifier vectors can over-count after early alignment shifts

F8 angle-dense raw rows show large classifier drop/insertion vectors, but byte/edit-distance checks were much smaller:

- `20260703183755273-tehtbt`: vector drop=164 and insertion=164, but edit distance was 8/2000 = 0.40%.
- `20260703183834136-y0voci`: edit distance was 8/2000 = 0.40%.
- `20260703183912982-eb7siz`: edit distance was 9/2000 = 0.45%.

Threshold decisions must cite both the classifier vector and byte/edit-distance spot checks. For sparse raw losses on angle-dense corpora, edit distance is the controlling loss metric while garble-class counts remain zero.

## M2 fix plan

1. **F10, firmware stuck-modifier fixes**
   - Add `JETKVM_PASTE_WRITE_FAIL=N` and `wake-release` injection.
   - Send all-clear on mid-macro write error.
   - Harden wake-tap release with retry and abort-on-persistent-failure.
   - Verify with tee-on shift-dense corpus and failed-state reporting.

2. **F11, targeted Go upstream ports**
   - Add writer seam for host-side race tests.
   - Port #1369 keyboard mutex around complete read/compute/write/update.
   - Port #1438 modifier auto-release exclusion and session-takeover clear.
   - Verify with `go test -race` for the new seam tests plus cross-GOOS build gates.

3. **F12, frontend upstream ports**
   - Extract keepalive scheduler and port #1387.
   - Add reliable-channel fallback for #1364.
   - Keep paste batching, watermarks, and flow-control location unchanged.

4. **F12b, multi-batch product `done:` completion**
   - Root-cause final drain and paste-state completion across multiple batches.
   - Preserve pasteDepth edge-trigger semantics.
   - Require 2-batch and 3-batch product rows with `done:` within the watchdog budget.

5. **F13, post-fix validation**
   - Re-anchor baseline at rate75 on the fixed build.
   - Re-run F8 replication matrix with the exact fixed SHA.
   - A-E4 gate: angle-dense and shifted-symbol repro corpora, Reliable, ≤6k, product path, 5/5 repair-assisted byte-perfect, garble pre-repair 0.
   - A-E8 gate: archived trigger corpus by hash, 10 product-path runs, tee on, garble 0 in tee and readback.

## Measurement definitions

### Calm host

A row is calm only when all are true:

- CPU sampled at least once per second for the full run.
- Zero CPU samples exceed 40%.
- Host is awake before first HID report.
- Fresh Notepad is newly launched, bound to `C:\Users\Robert\Documents\recv.txt`, empty, and RSS <250MB.
- Focus guard confirms `recv.txt - Notepad` before the first HID report and at every chunk boundary.

Rows violating calm host or fresh sink requirements must set `excluded_from_thresholds=true` and cannot anchor thresholds.

### Watchdog intervals

For physical typing paths (`raw`, `hidrpc`, and `product`):

- Default floor: `watchdogMs=180000`.
- Matrix formula: `watchdogMs = max(180000, ceil(expected_typing_ms * 2 + 60000))`.
- Reliable expected typing rate: 75cps for raw controls, 11ms HIDRPC delay for HIDRPC targeted cells, UI Reliable for product cells.
- Fast expected typing rate: 143cps for product Fast cells, using the UI Fast profile.
- Product multi-batch diagnostic cells must fail as `watchdog_abort` or product no-`done:` after the watchdog, never hang silently.

For synthetic or unit-only orchestrator tests:

- Default floor remains `watchdogMs=30000`.

### Focus-poll cadence

Active focus repair during raw HID typing can perturb the stream. F8/F3 observed deterministic drops with short active polling.

- Before typing: active focus guard required.
- During active physical typing: use passive/read-only focus checks where available, or long active poll interval `focusPollMs=600000`.
- Between chunks and between runs: active focus guard must run and refocus if needed.
- Product path: check focus before paste submit and at product chunk boundaries. Do not run short-interval active focus repair during a batch.
- Any unconfirmed focus state before a HID report aborts the row before typing. Any mid-run focus loss records `focus_lost` and excludes the row from thresholds.

## Threshold derivation

The F8 clean summary contains no Fast-profile rows and no clean 30k product rows. The Fast 0.05% to 0.12% band below is the mission-pinned prior measured band from the paste throughput work, included because the F9 feature explicitly fixes Fast as its own acceptance band. F14 must still re-anchor Fast cells on the fixed build and should tighten the per-cell band if the new measured data is better.

### Threshold codes

| Code | Derived from | Numeric threshold |
|---|---|---|
| `REL-6K` | F8 rate75 baseline, 3/6000 edit distance and vector drop=1, case=2 per run | garble=0; total pre-repair loss+race ≤6 chars (0.10%); drop ≤2; race/case/substitution ≤4; for product ≤6k, final repair-assisted delta=0 |
| `REL-30K` | `REL-6K` per-char band scaled to 30k because no clean 30k F8 product row exists | garble=0; total pre-repair loss+race ≤30 chars (0.10%); drop ≤10; race/case/substitution ≤20; count delta ≤30; no full auto-repair |
| `FAST-6K` | Fast profile band 0.05% to 0.12% expected loss | garble=0; expected loss 3-7 chars; fail if loss+race >14 chars (0.24%); for product ≤6k, final repair-assisted delta=0 |
| `FAST-30K` | Fast profile band 0.05% to 0.12% expected loss scaled to 30k | garble=0; expected loss 15-36 chars; fail if loss+race >72 chars (0.24%); count delta ≤72; no full auto-repair |
| `RAW-ANGLE-2K` | F8 raw angle edit-distance max 9/2000 after classifier over-count caveat | garble=0; edit distance ≤18 chars (0.90%); classifier garble classes must be 0; cite vector and edit spot check |
| `RAW-SHIFT-2K` | F8 raw shifted 0/2000 across 3 rows | garble=0; all classifier classes 0; edit distance 0 |
| `HIDRPC-ANGLE-2K` | F8 HIDRPC angle 3/2000 edit distance, vector same-length=1 and case=2 per run | garble=0; edit distance ≤6 chars (0.30%); same-length ≤2; case ≤4 |
| `HIDRPC-SHIFT-2K` | F8 HIDRPC shifted max 1/2000 edit distance, aggregate drop=1/8000 | garble=0; edit distance ≤2 chars (0.10%); drop ≤1 |
| `PRODUCT-SINGLE` | F8 clean product single-batch angle and shifted rows, 0 errors | `completion_signal=done-trace`; garble=0; byte-exact readback |
| `PRODUCT-MULTIBATCH-DONE` | F8 no-`done:` rows `20260703191320547-z3gesv` and `20260703192823519-3spctv` | `completion_signal=done-trace` within watchdog; delivery rows no longer get classified as 100% drop solely due missing completion |

### Product-path soak matrix

All rows below are product path. Each completed row must carry the exact `cell_id` in the ledger. Each cell needs at least one completed calm-host row in F14, with waivers written here if deliberately skipped.

| Cell ID | Corpus class | Profile | Size | Verification mode | Numeric threshold |
|---|---|---|---:|---|---|
| `M3-PROD-CODE-REL-6K` | code | Reliable | 6k | SSH byte-exact readback, repair-assisted allowed | `REL-6K`: garble=0; total≤6; drop≤2; race≤4; final delta=0 |
| `M3-PROD-CODE-REL-30K` | code | Reliable | 30k | SSH byte-exact readback, fast-chunked/count-verify | `REL-30K`: garble=0; total≤30; drop≤10; race≤20; count delta≤30 |
| `M3-PROD-CODE-FAST-6K` | code | Fast | 6k | SSH byte-exact readback, repair-assisted allowed | `FAST-6K`: garble=0; expected loss 3-7; fail >14; final delta=0 |
| `M3-PROD-CODE-FAST-30K` | code | Fast | 30k | SSH byte-exact readback, fast-chunked/count-verify | `FAST-30K`: garble=0; expected loss 15-36; fail >72; count delta≤72 |
| `M3-PROD-LONGTEXT-REL-6K` | detailed long text | Reliable | 6k | SSH readback primary, OCR counter optional progress | `REL-6K`: garble=0; total≤6; drop≤2; race≤4; final delta=0 |
| `M3-PROD-LONGTEXT-REL-30K` | detailed long text | Reliable | 30k | SSH readback primary, fast-chunked/count-verify | `REL-30K`: garble=0; total≤30; drop≤10; race≤20; count delta≤30 |
| `M3-PROD-LONGTEXT-FAST-6K` | detailed long text | Fast | 6k | SSH readback primary, OCR counter optional progress | `FAST-6K`: garble=0; expected loss 3-7; fail >14; final delta=0 |
| `M3-PROD-LONGTEXT-FAST-30K` | detailed long text | Fast | 30k | SSH readback primary, fast-chunked/count-verify | `FAST-30K`: garble=0; expected loss 15-36; fail >72; count delta≤72 |
| `M3-PROD-SCRIPTS-REL-6K` | scripts | Reliable | 6k | SSH byte-exact readback only, no OCR oracle | `REL-6K`: garble=0; total≤6; drop≤2; race≤4; final delta=0 |
| `M3-PROD-SCRIPTS-REL-30K` | scripts | Reliable | 30k | SSH byte-exact readback only, fast-chunked/count-verify | `REL-30K`: garble=0; total≤30; drop≤10; race≤20; count delta≤30 |
| `M3-PROD-SCRIPTS-FAST-6K` | scripts | Fast | 6k | SSH byte-exact readback only, no OCR oracle | `FAST-6K`: garble=0; expected loss 3-7; fail >14; final delta=0 |
| `M3-PROD-SCRIPTS-FAST-30K` | scripts | Fast | 30k | SSH byte-exact readback only, fast-chunked/count-verify | `FAST-30K`: garble=0; expected loss 15-36; fail >72; count delta≤72 |
| `M3-PROD-BINARY-REL-6K` | long binary number patterns | Reliable | 6k | SSH readback primary, OCR counter optional progress | `REL-6K`: garble=0; total≤6; drop≤2; race≤4; final delta=0 |
| `M3-PROD-BINARY-REL-30K` | long binary number patterns | Reliable | 30k | SSH readback primary, fast-chunked/count-verify | `REL-30K`: garble=0; total≤30; drop≤10; race≤20; count delta≤30 |
| `M3-PROD-BINARY-FAST-6K` | long binary number patterns | Fast | 6k | SSH readback primary, OCR counter optional progress | `FAST-6K`: garble=0; expected loss 3-7; fail >14; final delta=0 |
| `M3-PROD-BINARY-FAST-30K` | long binary number patterns | Fast | 30k | SSH readback primary, fast-chunked/count-verify | `FAST-30K`: garble=0; expected loss 15-36; fail >72; count delta≤72 |
| `M3-PROD-INDEX-REL-6K` | compressed tight indexes | Reliable | 6k | SSH byte-exact readback only, no OCR oracle | `REL-6K`: garble=0; total≤6; drop≤2; race≤4; final delta=0 |
| `M3-PROD-INDEX-REL-30K` | compressed tight indexes | Reliable | 30k | SSH byte-exact readback only, fast-chunked/count-verify | `REL-30K`: garble=0; total≤30; drop≤10; race≤20; count delta≤30 |
| `M3-PROD-INDEX-FAST-6K` | compressed tight indexes | Fast | 6k | SSH byte-exact readback only, no OCR oracle | `FAST-6K`: garble=0; expected loss 3-7; fail >14; final delta=0 |
| `M3-PROD-INDEX-FAST-30K` | compressed tight indexes | Fast | 30k | SSH byte-exact readback only, fast-chunked/count-verify | `FAST-30K`: garble=0; expected loss 15-36; fail >72; count delta≤72 |

### Targeted regression matrix

These cells are not a replacement for the product soak matrix. They keep the F8 repro and attribution surfaces alive while M2 is fixed.

| Cell ID | Path | Corpus | Profile or rate | Size | Numeric threshold | F8 source |
|---|---|---|---|---:|---|---|
| `TGT-RAW-ANGLE-REL-2K` | raw | angle-dense | rate75 | 2k | `RAW-ANGLE-2K`: garble=0; edit≤18; classifier garble classes 0 | `20260703183755273-tehtbt`, `20260703183834136-y0voci`, `20260703183912982-eb7siz` |
| `TGT-RAW-SHIFT-REL-2K` | raw | shifted-symbol-storm | rate75 | 2k | `RAW-SHIFT-2K`: garble=0; edit=0; all classes 0 | `20260703183951810-ld41xr`, `20260703184030601-3huqvv`, `20260703184109500-8d2utr` |
| `TGT-HIDRPC-ANGLE-REL-2K` | hidrpc | angle-dense | 11ms | 2k | `HIDRPC-ANGLE-2K`: garble=0; edit≤6; same-length≤2; case≤4 | `20260703184212026-tdzjzm`, `20260703184300548-80v3gl`, `20260703184348826-2fnhjn` |
| `TGT-HIDRPC-SHIFT-REL-2K` | hidrpc | shifted-symbol-storm | 11ms | 2k | `HIDRPC-SHIFT-2K`: garble=0; edit≤2; drop≤1 | `20260703184437197-h4r8bq`, `20260703184530845-9ua5ye`, `20260703184624446-jqxm52`, `20260703192607422-q2y58a` |
| `TGT-PROD-ANGLE-SINGLE-REL-55` | product | angle-dense single-batch | Reliable | 55 | `PRODUCT-SINGLE`: done-trace; garble=0; byte-exact | `20260703190900575-hqhyby`, `20260703190920099-8rigjx`, `20260703192248428-6kk6nh` |
| `TGT-PROD-SHIFT-SINGLE-REL-51` | product | shifted-symbol single-batch | Reliable | 51 | `PRODUCT-SINGLE`: done-trace; garble=0; byte-exact | `20260703190939291-bkinyy`, `20260703190958780-rm25xj`, `20260703191018709-hyjqf5`, `20260703192701004-d29m0p` |
| `TGT-PROD-2BATCH-DONE-REL-240` | product | product two-batch diagnostic | Reliable | 240 | `PRODUCT-MULTIBATCH-DONE`: done-trace within watchdog; garble=0; byte-exact after F12b | `20260703191320547-z3gesv`, `20260703192823519-3spctv` |
| `TGT-PROD-ANGLE-REL-6K` | product | angle-dense | Reliable | 6k | garble=0 pre-repair; 5/5 final delta=0; total pre-repair≤6 | F8 product single-batch rows plus `REL-6K` |
| `TGT-PROD-SHIFT-REL-6K` | product | shifted-symbol-storm | Reliable | 6k | garble=0 pre-repair; 5/5 final delta=0; total pre-repair≤6 | F8 product single-batch rows plus `REL-6K` |
| `TGT-LAYOUT-MISMATCH-RAW-167` | raw | layout probe | deliberate mismatch | 167 | classifier must report layout-swap on ≥2 pairs | `20260703191153730-w1ujt4` |
| `TGT-LAYOUT-MATCHED-RAW-167` | raw | layout probe | matched en-UK | 167 | garble=0; layout-swap=0 across 3/3 | `20260703191208103-gr0x8k`, `20260703191222706-zq3not`, `20260703191237177-46xxht` |
| `TGT-AE8-TRIGGER-PROD-REL-598` | product | `ae8-trigger-compact-layout.txt` | Reliable | 598 | 10/10 post-fix product runs; tee and readback garble=0 | corpus hash `sha256:ded59b78c6ff7e438b005ff0a315272000246a622890f52763488d7b548b3544` |

## Traceability rules

- Every F13 and F14 run must write the matrix `cell_id` shown above.
- Dashboard and ledger queries must be orphan-free in both directions: no matrix cell without a completed row unless a waiver is written in this spec, and no soak row without a matrix cell.
- Threshold queries must filter out `excluded_from_thresholds=true`.
- Every threshold comparison must include `garble_events_pre_repair`, the full classifier vector, and a byte/edit-distance or count-verify spot check.
- Product rows must record `completion_signal`. Missing `done-trace` is a failure, not a loss-rate datapoint.

## Oracle cross-review

Cross-review: SKIPPED: Oracle browser automation failed before submission on one honest `--engine browser --browser-manual-login` attempt. The CLI launched the browser session and attached this spec, then exited with `Thinking time: chip not found for pro (requested Extended); refusing to submit without confirmed Pro Extended.` No cross-review findings were produced.

Command attempted:

```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s --browser-auto-reattach-interval 3s --browser-auto-reattach-timeout 60s \
  --file docs/superpowers/specs/2026-07-03-paste-garble-rca-and-fix.md \
  -p "Cross-review F9-tech-spec. Paste garble RCA and M2/M3 test matrix from F8 replication campaign. Verify invariants, scope, race scenarios, and test-matrix completeness. Suggest concrete improvements."
```
