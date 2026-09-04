# PASTE-014 - 40 cps observation and conservative follow-up

Date: 2026-09-04. Superseded diagnostic guidance: see `../paste-reliability.md`.

PR #104 changed Reliable from a 6 ms to a 20 ms release gap, leaving batching,
chunking and backend execution unchanged. Robert subsequently reported that
40 cps worked without visible issues. A five-second initial focus delay had not
helped; an earlier restart/cancel sequence had improved the receiving host state.

These are user observations, not a repeated byte-exact comparison. They do not
prove that Windows alone caused the corruption. Correct report contents do not
establish correct timing or application receipt. The retained F13 trace also
supports investigating device-side catch-up compression.

The follow-up keeps Reliable at 40 cps nominal maximum, adds explicit Slow at
20 cps, bounds modal chunks, prevents paste catch-up, preserves ordered macro
admission, and adds focused input/transport safeguards and tests. It does not
claim that these additions have received live hardware certification.

Current values, code-path distinctions, evidence limits and the required live
validation matrix are maintained in `../paste-reliability.md`. Preserve historical
campaigns; do not delete inconvenient results or represent old tests as new runs.

Historical naming note: PASTE-008 used "PASTE-014" for a proposed scale-aware
verification effort. This file records PR #104's host-capacity probe, not completion
of that separate proposal.
