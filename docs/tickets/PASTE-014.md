# PASTE-014 - Receiving-host capacity probe at 40 cps

**Date:** 2026-09-04
**Status:** Diagnostic - live validation required

## Observation

The same JetKVM paste became significantly cleaner after a Windows restart was initiated and cancelled near the end. The JetKVM, source browser, target application, paste content, and transport were otherwise unchanged.

That suggests the machine receiving the synthetic keyboard input may have a variable application/input-processing ceiling affected by background activity or user-session state.

## Hypothesis

The current Reliable profile runs plain characters at approximately 91 characters per second:

```text
5 ms press + 6 ms reset gap = 11 ms per character ~= 91 cps
```

Under target-host churn, Notepad or the Windows text/input stack may not consume every HID transition at that rate even though the USB gadget and kernel path remain healthy.

## Diagnostic change

Temporarily retune only Reliable pacing to approximately 40 characters per second:

```text
5 ms press + 20 ms reset gap = 25 ms per character = 40 cps
```

The following remain unchanged:

- 128 logical steps per Reliable batch
- calculated byte cap
- WebRTC/HID-RPC transport
- backend macro queue
- chunk threshold and chunk size
- cancellation and completion semantics
- Fast profile at approximately 143 cps

This isolation is important: a clean 40 cps run would implicate target-host consumption capacity, while continued corruption would push the investigation back toward report interference, ordering, layout/modifier state, or the receiving application itself.

## Manual validation matrix

Use the same numbered or checksum-bearing corpus in every run. Disable Notepad spellcheck and autocorrect for the test.

1. Reproduce the problem on the current installed main build using Reliable.
2. Deploy this branch and run Reliable without changing host state.
3. Repeat Reliable after closing and reopening Notepad.
4. Repeat Reliable after the restart/cancel sequence that previously improved delivery.
5. Run each meaningful condition at least three times.

Record:

- expected and received character counts
- first mismatch position
- whether errors are missing characters, wrong case/symbols, repeats, or true reordering
- target CPU, available memory, and disk active time before the run
- top CPU and disk processes
- time since boot

## Interpretation

- **40 cps clean in both host states:** the previous 91 cps rate exceeded this target's dependable input-processing ceiling.
- **40 cps clean only after host quiescence:** target resource or session churn changes the safe ceiling; a permanent solution needs a larger margin or host-aware calibration.
- **40 cps still corrupts:** raw receiving speed is not sufficient to explain the bug; investigate HID report interference and end-to-end ordering next.
- **Fresh Notepad fixes it without broader host changes:** prioritize application/text-service state over whole-system resources.

## Release decision

Do not merge this as a permanent retune solely because one run improves. Keep the PR in draft until the repeated live matrix distinguishes a rate effect from normal run-to-run variance.
