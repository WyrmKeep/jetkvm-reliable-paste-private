# PASTE-004 — LED-echo preflight for long pastes

**Status:** Done (2026-06-10)

## What shipped

Before any paste ≥10,000 chars, the modal taps NumLock and watches for the
host's lock-LED OUT report (the only host→device feedback channel USB HID
provides), then taps again to restore lock state. The result is traced
(`led-preflight: ok|no-echo`). No echo ⇒ a non-blocking amber notice:
"the target may be locked, asleep, in BIOS/UEFI, or not processing input —
check that the first lines arrive." The paste always continues: some hosts
legitimately never send LED reports, so this can never hard-block.

Plumbing reused end-to-end: `f_hid` OUT report → gadget LED reader →
`reportHidRPCKeyboardLedState` → frontend `keyboardLedState` store; the
preflight just subscribes for a state change around two NumLock taps via
the existing (non-paste) macro path.

## Why it matters

A 100k paste is a ~19-minute commitment. The 2026-06-09 measurements showed
LED echo answers in ~1ms when a host is processing input, and the 2026-06-10
lock-screen incident showed what typing at a non-responsive/locked host
costs. This is the cheapest possible "is anyone listening?" check before
that commitment. (Note: a LOCKED Windows host still toggles LEDs — the
preflight detects dead/suspended input stacks, not lock state. The wake-tap
plus checking the first chunk covers the rest.)

## Validation (machine 2, 21,200-key paste, Reliable)

- Trace: `profile=… | led-preflight: ok | batch 1/166 …` — echo observed,
  positive path confirmed through the real pipeline.
- Lock state restored (double-toggle) — corpus content unaffected:
  21,172/21,200 delivered (run-of-day churn loss, consistent with PASTE-002).
- Found & fixed during validation: the preflight originally ran before the
  per-run trace reset, so its line was wiped (ordering bug).
