# PASTE-003 — Verified paste mode + completion integrity summary

**Status:** Done (2026-06-10)
**Why:** PASTE-002 measured 0.14% host-side loss over 19 minutes at a rate
that is clean in short runs. Loss at scale is a property of Windows
background churn, not pacing — so the user needs cheap *verification*, not
a slower profile.

## What shipped

1. **Completion summary (always on):** after every paste, the modal shows
   "The target should show **N characters** / cursor on line **M**" plus
   elapsed time and effective cps. Integrity check = one glance at the
   target's own counter (Notepad status bar etc.) instead of proofreading.
2. **Verify each chunk (opt-in checkbox, shown for pastes ≥5k chars):** the
   pipeline pauses at every committed chunk boundary and shows the expected
   cumulative character count. Continue, or Stop — stopping lands on the
   existing resume checkpoint (the boundary just verified), so the remedy
   for a bad chunk is trim-the-tail + Resume, never a full restart.
   Plumbing: `waitForChunkConfirm` option on `executePasteText`, awaited
   after each required drain; abort-aware; pending confirm survives popover
   dismissal via module-scope state (same pattern as the resume checkpoint).

## Validation (machine 2, 21,200-key corpus, Reliable)

- 4 pauses fired at exact committed boundaries: 4,992 / 9,984 / 14,976 / 19,968.
- Completion summary computed exactly: "21,200 characters / cursor on line 401".
- Run delivered 21,170 (0.14% loss, churn-window day) — which is precisely
  the scenario the feature serves: a user watching pauses catches the short
  chunk immediately and repairs from a verified boundary.
- Edge case found & fixed: dismissing the popover during a pause previously
  orphaned the confirm promise (unrecoverable hang); pending confirm is now
  module-scope and re-hydrates on remount.

## Honest limits

- Verification is human-in-the-loop (the only feedback channel that exists
  without target-side software or network sharing). Counter comparison works
  in Notepad/editors with character counts; for other sinks, line count or
  visual tail-check applies.
- Mid-run losses inside an *accepted* chunk are still possible between
  pauses; chunk size (5k) bounds the damage and the re-type cost.
