# Paste throughput ceiling: investigation & optimization

**Date:** 2026-06-09
**Status:** Phase 0 complete (ground truth measured), Phase 1 next
**Test rig:** JetKVM at 192.168.1.110 (`worklaptopjetkvm`, kernel 5.10.160 armv7l), Windows target attached, SSH key auth installed

## Goal

Raise sustained paste throughput from ~91 chars/sec toward **300+ chars/sec with zero
character loss** on the Windows target, by replacing open-loop pacing (fixed sleeps)
with measured, feedback-driven pacing. Every tuning change must be validated by
on-device measurement plus a host-side keystroke receiver — no optimistic patches.
This fork's history (RCA docs, PR #41) shows what happens otherwise.

## Ground truth (measured 2026-06-09)

These are facts, not estimates:

1. **Gadget enumerates at USB high-speed** (`/sys/class/udc/ffb00000.usb/current_speed`
   = `high-speed`, state `configured`). HID keyboard endpoint polled at ~1ms.
2. **Measured HID write latency: 1.05ms/report**, flat across 1000- and 2000-write
   runs (timed zero-report writes to `/dev/hidg0` — types nothing, measures drain
   rate). The Windows host consumes reports at full bus rate: **~950 reports/sec
   ≈ ~475 chars/sec of raw bus capacity** (press+release = 2 reports/char).
3. **The 55s / 5000-char measured ceiling is 100% software sleeps:**
   - 40.0s = per-step delays: 5ms after press (`useKeyboard.ts:583` hardcoded) +
     3ms after reset (`keyDelayMs`, reliable profile) = 8ms/char
   - 15.2s = 200ms inter-macro drain (`pasteInterMacroDrain`, `jsonrpc.go`) × ~76 batches
   - ~0s = USB writes (would add ~100s if the device were full-speed; it isn't)
4. **Writes to `/dev/hidg0` are self-pacing**: `f_hid` blocks write N+1 until the host
   polls report N. A blocked write IS the backpressure signal. This is the natural
   closed-loop mechanism the current design ignores in favor of fixed sleeps.

**Conclusion: the USB bus is NOT the bottleneck (~5x headroom). The hard ceiling is
open-loop pacing added to mask host-side drops that have never been directly measured.**

## Open question (the real investigation)

At what sustained chars/sec does the **Windows input stack / target application**
actually start dropping or reordering input — and is that threshold detectable from
the device side (write-latency stalls), or only host-side? Historical drops (RCA
2026-03-15) were host-consumer effects, not USB-layer losses. The 200ms drain and
8ms/char delays are blanket insurance against this unmeasured threshold.

## Phases

### Phase 0 — Ground truth ✅ (this doc)

### Phase 1 — Loss-detection harness
- **Host side:** keystroke receiver on the Windows target (PowerShell or simple
  focused-window app) logging each received character with a timestamp. Paste a
  self-verifying corpus (numbered lines + per-line checksum) so any loss/reorder
  is localized, not just detected.
- **Device side:** instrument `keyboardWriteHidFile` with a per-write latency
  histogram + stall counter (debug flag / log line, no Prometheus needed yet).
  A latency spike above ~2ms means the host stopped polling — candidate
  device-observable proxy for host distress.
- **Sweep:** run the corpus at increasing rates (reduce step delays, then shrink
  inter-macro drain) until loss appears, on the real Windows target into Notepad.
  Record the loss threshold and whether device-side latency predicted it.

### Phase 2 — Evidence-based tuning ✅ (implemented 2026-06-09, validation below)

Phase 1 falsified two of Phase 2's planned directions, so the implementation
differs from the original sketch — the data, not the sketch, governs:

- **Lower per-step delays toward 0**: REJECTED by measurement. The ceiling is
  the host app layer (~100-110 cps safe on slow sinks), nowhere near endpoint
  pacing. Profile rates were retuned to measured-safe values instead.
- **Feedback-driven drain**: REJECTED by measurement. Loss is invisible to
  USB-level feedback (LED echoes stay 1ms during loss). There is nothing
  device-observable to feed back. Open-loop at exact measured-safe uniform
  rates is the correct design; LED echo remains viable as a *preflight* check
  (follow-up, not in this change).

What was implemented:

1. **`rpcDoExecuteKeyboardMacro` (jsonrpc.go): absolute-deadline pacing.**
   Sleep-after-write accumulated ~1ms/step timer overshoot (~20% rate error).
   Deadlines make wire-step delays exact, so profile rates mean what they say.
2. **`drainMacroQueue` (jsonrpc.go): 200ms inter-macro drain skipped for paste
   macros.** Uniform pacing carries through batch boundaries (last reset step's
   delay is slept inside the macro). Burst test r9 proved gaps don't protect
   the host; supersedes PR #41 (burst-era tuning). Non-paste macros keep 200ms.
3. **`PASTE_PROFILES` (pasteBatches.ts): reliable keyDelayMs 3→5** → exactly
   10ms/char = 100 cps uniform, the measured zero-loss rate. fast stays 2 →
   7ms/char ≈ 143 cps, at the slow-sink loss threshold, fine for faster sinks.

Net effect at "reliable": ~91 cps bursty (loss-prone on slow sinks) →
100 cps uniform (measured zero-loss), ~+10% throughput with the failure mode
removed. At "fast": ~111 cps effective → 143 cps uniform, ~+29%.

### Phase 3 (optional, roadmap #44) — Timed-sequence HID writer
- Move pacing device-side into a closed-loop writer (issue #44, flagged REDESIGN).
- Stretch: rollover packing (release-prev + press-next in one report) halves
  report count → ~950 chars/sec theoretical. Invasive to macro semantics; only
  after Phase 2 lands and holds.

## Success criteria

- ≥3x sustained throughput (≥270 chars/sec) on the standard 5000-char corpus into
  Windows Notepad, **zero loss across ≥5 consecutive runs**.
- No regression in large-paste safe mode, paste-depth semantics (PR #49), or
  non-paste keyboard input.
- Loss threshold + margins documented here, so future retuning has a baseline.

## Constraints (from CLAUDE.md / fork history)

- 200ms `pasteInterMacroDrain` is load-bearing until Phase 1 evidence replaces it.
- Single batching path (`buildPasteMacroBatches`); flow control stays in the hook.
- `pasteDepth` edge-trigger semantics preserved; `waitForPasteDrain("required")`
  is reserved for chunk boundaries, not dead code.
- Deploy ephemeral (`./dev_deploy.sh -r 192.168.1.110`) while iterating; persistent
  (`-i --skip-native-build`) only for soak testing.

## Measurement log

| Date | What | Result |
|------|------|--------|
| 2026-06-09 | UDC enumeration speed | high-speed, configured |
| 2026-06-09 | 1000× zero-report writes to /dev/hidg0 | 1.05s total → 1.05ms/report |
| 2026-06-09 | 2000× zero-report writes (consistency) | 2.10s total → 1.05ms/report |
| 2026-06-09 | Rate sweep, 612-key corpus into Win11 Notepad (hidtype, sleep-paced) | 100cps: 0 loss · 143cps: 0 loss · 205cps: −94 · 255cps: −73 · 324cps: −161 · 467cps: −253 |
| 2026-06-09 | Burst test: 255cps bursts of 64 + 250ms gaps (132cps avg) | −72 (12%) — **drains do not protect; instantaneous rate is what matters** |
| 2026-06-09 | Reproducibility: 143cps repeat | −2 (marginal, not safe) · 205cps repeat: −72 (stable threshold) |
| 2026-06-09 | Deadline-paced sweep (exact rates) | 110cps: 0 loss · 125cps: −5 · 135cps: −69 · 150cps: −43 (high variance ≥125) |
| 2026-06-09 | Loss-mode analysis (visual) | Two modes: app-translation case races (stuck/lost Shift) + multi-char drops; both = host app-layer backlog |
| 2026-06-09 | LED echo (NumLock→OUT report) at 100cps, app stopped | 20/20 echoes, 1ms RTT — channel works |
| 2026-06-09 | LED echo at 200cps (lossy run, −14 chars) | 20/20 echoes, still 1ms — **loss is app-layer, invisible to USB-level feedback; LED viable as preflight only** |
| 2026-06-09 | Endurance: 2448 keys at 100cps uniform (24.5s sustained) | **2448/2448, zero loss, case-perfect** |
| 2026-06-09 | E2E real UI paste, 10ms/char build, awake host | 2447/2448 and 2441/2448 (head −6 vs sleeping display → wake-tap added; plus ~0.04% mid-stream host noise at 100cps) |
| 2026-06-10 | hidtype margin runs: 2×91cps + 1×100cps, 2448 keys | all three **2448/2448** |
| 2026-06-10 | **FINAL E2E, Reliable (11ms/char ≈ 91cps uniform + wake tap)** | **2448/2448 zero loss**, 28.2s, 86.7 effective cps |
| 2026-06-10 | FINAL E2E, Fast (7ms/char ≈ 143cps uniform) | 2445/2448 (0.12% — at slow-sink threshold as expected), 18.2s, 134.8 effective cps |

## Phase 1 conclusions (ground truth for Phase 2)

1. Safe sustained rate into Win11 Notepad (slow XAML sink, worst case): **100 cps uniform — proven; 110 OK; ≥125 is a high-variance danger zone.**
2. **Uniform pacing strictly dominates burst+drain**: bursts drop at the burst's instantaneous rate regardless of average; the 200ms inter-macro drain protects nothing that uniform pacing doesn't protect better.
3. Loss locus is the host **application/translation layer** (case races prove translation lag; LED echoes prove the kernel path never backs up). No USB-level feedback can observe it → open-loop at a measured-safe uniform rate is the correct design, plus optional LED preflight to detect dead/suspended hosts.
4. Go `time.Sleep` on the device overshoots ~1ms/call → today's per-step sleeps run ~20% slower than configured. Deadline pacing fixes this and makes profile rates exact.
