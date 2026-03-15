# JetKVM Paste Investigation Handoff

Date: 2026-03-15
Repo: `WyrmKeep/jetkvm-reliable-paste-private`
Base upstream: `https://github.com/jetkvm/kvm`
Private working repo on this box: `/home/ethereal/projects/jetkvm-analysis/official-kvm`
Target device used for testing: `192.168.1.36`

---

## Objective

Improve JetKVM's built-in **Paste Text** workflow so very large code/text payloads can be delivered to a restricted host more reliably and faster than the stock implementation.

The real-world use case is bulk text/code ingress into a network-restricted machine via JetKVM, where normal file-transfer paths are unavailable or constrained.

---

## Current status at handoff

### What now works better than stock
- The stock upstream monolithic paste path has been replaced by a chunked/batched scheduler.
- Paste progress is visible in the modal.
- There is a `Reliable` vs `Fast` mode.
- File-backed input exists so the paste modal can use a local file as the source instead of only a textarea.
- Frontend trace data is persisted in browser localStorage.
- Backend logs include keyboard macro execution IDs, counts, and start/finish messages.
- HID write timeout handling was hardened in the private build.

### What still fails
- Very large pastes can still go bad late in the run.
- The newest finding from live testing: when the user clicked back into the target notepad window, text immediately started typing correctly again.

### Strongest current hypothesis
The remaining major issue is likely **focus / target sink / host-side input consumption**, not only batch sizing.

The latest observation strongly suggests:
- when the target window/editor is not reliably focused or the UI event routing changes,
- the synthetic input stream degrades,
- but re-focusing the target restores correctness immediately.

This is the strongest live behavioral clue gathered so far.

---

## Latest critical finding

### Re-focusing the target window restored correctness
User report:
- paste went bad again
- clicking back into the target notepad window caused it to instantly start writing correctly again

### Why this matters
This suggests at least one of the following:
1. The target application/window is losing focus intermittently during long pastes.
2. The host-side text sink falls behind unless it remains actively focused.
3. JetKVM/browser/device interaction is not the only bottleneck; the receiving app/window state matters heavily.
4. Some of the late corruption may be caused by the target window/editor state rather than pure HID transport failure.

### Practical implication
Future debugging should include:
- explicit focus-state validation on the target app before and during paste
- testing on different sinks (plain terminal, notepad, richer editor)
- possibly a keep-focus strategy in the operator workflow

This is the biggest late-stage clue uncovered tonight.

---

## Setup / environment

### Local repos
- Official analysis workspace:
  - `/home/ethereal/projects/jetkvm-analysis/official-kvm`
- OptiGap analysis clone:
  - `/home/ethereal/projects/jetkvm-analysis/optigap`

### Private GitHub repo
- `https://github.com/WyrmKeep/jetkvm-reliable-paste-private`

### Device access
- JetKVM device at `192.168.1.36`
- SSH access was enabled using Hermes public key
- Deployments were done with:
  ```bash
  ./dev_deploy.sh -r 192.168.1.36 --skip-native-build
  ```
  or backend-only style variants like:
  ```bash
  ./dev_deploy.sh -r 192.168.1.36 --skip-ui-build --skip-native-build
  ```

### Important deployment caveat
`dev_deploy.sh` runs `jetkvm_app_debug` attached to the remote shell/debug session, so it often appears to "hang" from the operator side even when deploy actually succeeded. In practice, deployment success was verified by:
- checking `/userdata/jetkvm/bin/jetkvm_app_debug` timestamp
- checking process list for `jetkvm_app_debug`
- confirming UI behavior after hard refresh

### Frequent deployment issue
Repeated redeploys often hit:
- `Text file busy`

Workaround used:
1. SSH into device
2. stop/kill current app process if possible
3. rerun deploy
4. re-check timestamp/process state

---

## Key files changed in the private build

### Frontend/UI
- `ui/src/components/popovers/PasteModal.tsx`
- `ui/src/utils/pasteBatches.ts`
- `ui/src/utils/pasteMacro.ts`
- `ui/src/hooks/useKeyboard.ts`
- `ui/src/hooks/useHidRpc.ts`

### Backend/device-side
- `internal/usbgadget/consts.go`
- `internal/usbgadget/utils.go`
- `jsonrpc.go`

---

## Major phases / attempts made

## Phase 1 — Improve stock paste UI with chunking
### Goal
Avoid one giant macro and add chunked batching.

### Result
Initial UI improvements landed, but the first batching implementation was wrong because it treated "sent" as "completed" on the HID-RPC path.

### RCA
Remote `executeMacro()` returned after sending, not after device completion.
That caused new batches to arrive before previous ones actually finished.

---

## Phase 2 — Completion-aware scheduling
### Goal
Wait for actual device-side macro completion before sending the next batch.

### Result
This fixed the original overlap/cancel problem and got the paste path into a much healthier state.

### Resulting improvements
- ordering improved
- cancel worked much better
- progress UI became more meaningful

---

## Phase 3 — Throughput tuning
### Goal
Increase speed while preserving correctness.

### Attempts
Multiple rounds of tuning were tested:
- larger batches
- lower delays
- lower pauses
- then safer rollbacks when tail corruption reappeared

### Result
Found that very aggressive speed settings could work for a long time but still fail late in the run.

---

## Phase 4 — Byte-budgeted batching and trace mode
### Goal
Batch using more realistic transport limits and instrument the run.

### What was added
- estimated payload byte budgets
- per-batch trace output
- batch durations
- stress/tail flags

### Result
Much better observability. This proved that failures were not simple immediate transport collapse; they appeared late after many successful batches.

---

## Phase 5 — File-backed mode
### Goal
Bypass textarea-heavy workflow by allowing a local file as the source.

### Initial result
First file-backed attempt failed due to integration issues.

### Follow-up
File mode was redesigned so it simply loads file text into the same proven text pipeline rather than inventing a second send path.

### Extra fix
File text normalization was added:
- strip BOM
- normalize CRLF/CR to `\n`

This removed false invalid-character warnings from uploaded text files.

---

## Phase 6 — Backend HID hardening
### Goal
Attack the strongest backend RCA candidate.

### Changes
- increased HID write timeout from `10ms` to `100ms`
- stopped swallowing HID write deadline-exceeded errors as success
- improved logging visibility for timeouts

### Result
This significantly improved long-run correctness and strongly validated the backend write-path RCA.

---

## Phase 7 — Tail taper and long-run taper
### Goal
Reduce corruption late in long runs.

### Attempts
- tail-only slowdown
- long-run slowdown starting earlier
- adaptive pause based on run length / stress

### Result
Helpful, but not a complete fix. New evidence suggested the problem was not only tail batching but also target-side sink behavior.

---

## Phase 8 — Persisted traces and backend correlation
### Goal
Make it possible to inspect failed runs afterward.

### Added
- frontend trace persisted in localStorage under:
  - `jetkvm_reliable_paste_trace`
- backend macro execution IDs logged in `/tmp/jetkvm_app_debug.log`

### Result
Enabled real frontend/backend correlation.

---

## GitHub issues / docs created

### Private repo issues
- `#26` — main paste batching / completion issue and ongoing tuning history
- `#27` — `dev_deploy` debug runtime / reboot / revert behavior
- `#28` — dedicated file-backed large-paste mode
- `#29` — HID write timeout RCA and backend mitigation

### Key docs
- `docs/rca/2026-03-15-paste-batching-rca.md`
- `docs/rca/2026-03-15-ultra-rca-late-batch-failure.md`
- `docs/plans/2026-03-15-reliable-paste-plan.md`
- `docs/plans/2026-03-15-reliable-paste-v2-plan.md`
- this handoff doc

---

## What the traces/backend logs showed

### Frontend trace
A representative trace showed:
- ~534 batches total
- many early and mid batches consistently around `60 steps / 1086 bytes`
- durations ~`520–600ms`
- corruption beginning around batch ~437 in one run
- tail mode originally only kicking in around batch ~519, which was too late

### Backend logs
Backend macro logs showed:
- macro execution continued well beyond the visible corruption point
- backend did not simply stop at the failing batch number
- the backend believed it was still executing/completing batches successfully

### Combined interpretation
This suggested the problem was not merely “the batch engine stopped” but rather:
- cumulative long-run degradation
- target-side sink/focus issues
- or device-side write/consume mismatch

---

## Current strongest hypotheses (ranked)

### 1. Target window/editor focus or sink behavior is now a major factor
**Confidence: High**

Reason:
- user observed clicking back into the notepad window immediately restored correct typing
- that strongly implies focus/sink state matters significantly

### 2. Device-side HID reliability remains relevant
**Confidence: High**

Reason:
- backend write timeout swallowing was a real bug
- hardening it improved results significantly
- there may still be deeper gadget/host consume limits

### 3. Cumulative long-run sink degradation
**Confidence: Medium-high**

Reason:
- failures happen after long clean runs
- backend still continues sending
- visible corruption appears after sustained input flood

### 4. Batch sizing/placement issues still contribute, but are no longer the whole story
**Confidence: Medium**

Reason:
- moving batching into the execution layer was the correct structural move
- but focus/sink behavior now appears to be a bigger remaining factor

---

## What to test next

### Highest-priority tests
1. Paste into **plain notepad** while ensuring it stays focused the whole time.
2. Repeat with a **different sink**:
   - simple terminal file write (`cat > file`) if possible
   - another minimal editor
3. Watch whether manual re-focusing restores correctness again.
4. Compare runs where the target window definitely remains foregrounded vs not.

### Good debugging workflow
After a failed run:
1. Capture frontend trace from browser localStorage:
   ```js
   localStorage.getItem("jetkvm_reliable_paste_trace")
   ```
2. Pull backend logs:
   ```bash
   ssh root@192.168.1.36 "grep -E 'starting keyboard macro execution|keyboard macro execution completed|write timed out|failed to write to hidg0|macro_id=' /tmp/jetkvm_app_debug.log | tail -n 300"
   ```
3. Compare batch numbers/timings with macro IDs.

---

## Recommendation for the next person

### For tonight
If a reliable transfer is urgently needed and this still fails:
- keep the target sink focused manually
- split the file if necessary
- prefer the file-backed source input in the modal if it is behaving better

### For continued engineering
The next likely most valuable work is:
1. explicit focus-state/operator guidance or tooling
2. testing against alternative sinks
3. possibly adding a “focus-required large transfer mode” with stronger pauses after a certain runtime
4. if needed, even more backend-level instrumentation around HID write timing and gadget/device readiness

---

## Important operational note
This project is now in a much better state than it started in. The major low-level overlap bug was fixed, backend HID hardening improved things materially, and the system can now often run successfully for very large portions of a paste. The remaining issue appears to be a harder late-stage interaction between JetKVM’s input pipeline and the actual target sink/application state.

That means the investigation has moved from “obvious implementation bugs” into “edge-case reliability engineering.”
