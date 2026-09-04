# Paste reliability: current operating contract

Updated 2026-09-04. This page supersedes historical tuning instructions, not
historical measurements. It is the starting point for future paste changes.

## Defaults

| Mode | Ordinary / modified press | Release gap | Nominal ordinary maximum | Logical steps / batch |
| --- | --- | --- | --- | --- |
| Reliable (default) | 5 / 10 ms | 20 ms | 40 cps | 128 |
| Slow (explicit) | 5 / 10 ms | 45 ms | 20 cps | 128 |
| Fast (explicit, validated targets) | 5 / 10 ms | 2 ms | about 143 cps | 256 |

Reliable/Slow byte cap is 2,318; Fast is 4,622. These are derived from
`6 + logicalSteps * 18 + 8` rather than independent hand-tuned limits.
Modified characters are slower; composed characters can require extra steps.
Configured rates are upper bounds. Device write time, scheduling, wake preflight,
chunk boundaries and verification add latency.

Modal pastes chunk automatically from 1,024 source characters, with a 1,024
character target and a 250 ms inter-chunk pause when backend paste-state support
is known. Whole batches/character mappings remain intact. Legacy firmware can
lack the required drain capability; do not claim chunking without observing it.
The existing 64-slot macro queue and 64/256 KiB browser watermarks are unchanged.
Chunking bounds submitted work and checkpoint size; it is not a host receipt.

The automation transport shares the Reliable rate but does not inherit modal
chunking or OCR. Its 300-second maximum deadline remains. Requests whose encoded
phase delays cannot fit are refused before transmission. Callers must explicitly
split larger requests; requests that fit nominally can still time out from overhead.

## What is fixed

Paste execution preserves the full configured delay after each successful write.
Late writes and timer wakeups cause slower typing, never a catch-up burst. This
intentionally favours minimum phase spacing over the earlier average-throughput
calibration. Ordinary non-paste macros keep their previous scheduler and 200 ms
inter-macro pause. Cancellation and write-error all-clear remain generation-bound.

Macro admission stays synchronous in the ordered keyboard queue rather than
leaving an enqueue worker behind after a one-second watchdog. Cancellation still
uses its separate HID queue. This does not remove all upstream buffering or make
cancellation over a saturated network instantaneous.

Browser blur/visibility resets are suppressed during modal submission or observed
backend paste activity. Explicit cancellation/reset safety paths are not suppressed.
This is not a complete cross-client keyboard-ownership protocol: receiving-app
focus loss, physical keyboard input and other controllers still require care.

Profile paste requires ready HID-RPC and does not silently fall back to differently
paced legacy JSON-RPC. Refused macro sends and channel loss while waiting for
browser backpressure surface as failures. A failure does not prove that no prefix
was typed: inspect the target before retrying.

Repair remains off by default. Opt-in repair uses at least the Slow release gap,
never a faster gap than the selected mode, and budgets its drain using that repair
rate. No blind automatic ramp-up is implemented.

## Evidence and limits

Robert reported that PR #104 at 40 cps worked without visible issues on the
receiving Windows machine. No new byte-exact hardware campaign has been attached
for these additional changes. This observation supports a conservative default;
it does not isolate host state from rate or certify arbitrary hosts and sizes.

The June throughput investigation measured about 1.05 ms per HID write. That
argues against a sustained USB-bandwidth shortage, not against every timing fault.
The F13 run `20260704035131642-0ikzya` has an exact tee decode but a missing `a`
in `L0002 after`. Its post-write trace contains compressed phases consistent with
the former catch-up scheduler. Post-write logs are not USB-bus or Windows-event
captures and cannot alone locate the final loss.

Historical references:
- `superpowers/specs/2026-06-09-paste-throughput-ceiling-investigation.md`
- `tickets/PASTE-002.md` and `tickets/PASTE-008.md`
- `../tools/paste-harness/campaigns/f13-fix-validation-20260704/`
- `../tools/paste-harness/campaigns/f14-soak-matrix-20260705/`

`done` / backend drain means device-side work completed, NOT verified target text.
Count equality cannot detect same-length substitutions, reordering, or balanced
insertions/deletions. OCR is not the correctness oracle for symbol-heavy code.
Use actual saved-text readback with only the pipeline's documented normalisation.
A resume checkpoint is a backend boundary, not proof that its prefix is correct.
Inspect/trim any uncertain tail before resuming. Never repair arbitrary terminal
commands or application actions by blind backspacing/retyping.

## Validation before a hardware reliability claim

Keep the initial main-versus-#104 rate comparison distinct from this configuration
and safety change. Record UI/backend build identity, effective delays (debug mode
can override the profile), handshake/capabilities, layout, focus and host state.

Run the same numbered/checksummed corpus in alternating order at 91 and 40 cps in
available normal-load and quiet states. Then test this branch at 40 and 20 cps.
Use fresh and already-large target documents. At least three repeats per meaningful
condition are a starting point, not a universal losslessness proof.

Cover plain/repeated letters, alternating case, shifted symbols and supported
composed characters; lengths 127/128/129, 1023/1024/1025, 4999/5000/5001 and 6k/30k.
Do a 100k soak before claiming that envelope. Compare raw, HID-RPC and modal paths
with matching press/gap delays. Separate first-pass from repair-assisted results.

Inject slow writes/late wakes (2/10/50/250 ms), macro-queue saturation, cancel,
channel closure, browser blur/visibility changes and receiving-app focus loss.
Verify ordering with retained batch identifiers or unambiguous corpus boundaries.
Use passive focus observations during typing. Compare tee-on and tee-off runs
because instrumentation can perturb timing. Capture write entry and completion
when attributing stalls, not just post-write timestamps.

Release requires passing automated regression/race checks plus honest reporting
of hardware tests still outstanding. Do not weaken a gate or cite an old passed
campaign as evidence that newly changed code has been physically validated.
