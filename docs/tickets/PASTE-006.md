# PASTE-006 — Auto-verified paste: closed-loop integrity via on-video OCR

**Status:** In Progress (spike validated 2026-06-10)

## Motivation

PASTE-002/003 measured ~0.1% host-side keystroke loss over long pastes at
ANY practical rate (churn windows in the Windows input path — user-visible
as e.g. `13`→`3`, `Fox`→`ox`, single chars at random positions). Verified
mode catches this but needs a human glance per chunk. The video stream the
KVM already renders contains the target's own character counter — i.e., a
machine-readable feedback channel that USB HID lacks.

## Spike result (the risky part, proven first)

tesseract.js (digit whitelist) against 8 real status-bar crops from the KVM
video (2x scale), ground truth known from this session's runs:
**8/8 exact** — including comma-separated values (21,172 / 9,977 / 2,448 …).

## Design

1. **Region select (once per target layout):** with auto-verify enabled, the
   user drags a rectangle over the target's character counter on the video.
   The UI OCRs it immediately and shows what it read, confirming the region
   works before the paste starts. Rect persists in localStorage.
2. **Closed loop (chunk mode):** after each chunk's drain + ~800ms counter
   settle: capture the video frame (canvas.drawImage at native resolution),
   crop the rect, OCR, parse `N characters`.
   - N == expected → continue automatically (no human pause).
   - N < expected → **auto-repair**: Backspace × (N − previousCheckpoint) at
     a safe rate, re-OCR to confirm rollback to the checkpoint count, then
     re-type the chunk and re-verify. Bounded retries (2) per chunk, then
     fall back to the manual confirm pause.
   - OCR unreadable or unstable (two consecutive reads disagree) → fall back
     to the manual confirm pause for that boundary.
3. **Completion:** final OCR vs total — summary shows "byte-count verified
   on target ✓" when they match.

## Constraints honored

- No network sharing, no target-side software: feedback is purely the video
  the KVM already has; repair is purely keyboard (Backspace + re-type).
- tesseract.js lazy-loads only when the feature is enabled.
- Backspace==1 char per press matches the counter semantics measured on
  both machines (newline counts as 1).

## Phases

- **P1:** region selector + per-chunk OCR auto-confirm (pauses self-confirm
  on match; manual only on mismatch/unreadable). No destructive repair.
- **P2:** auto-repair (backspace + re-type) behind its own toggle, after P1
  proves OCR stability across chunk boundaries in live runs.
