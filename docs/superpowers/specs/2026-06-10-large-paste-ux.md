# Large-paste UX: ETA, resume, pause retune

**Date:** 2026-06-10
**Builds on:** `2026-06-09-paste-throughput-ceiling-investigation.md` (uniform pacing)
**Status:** implemented; validation log at bottom

## The workflow this serves

The primary real-world use is pasting **large generated files (~100k chars)**
through the paste menu (file upload). At reliable pacing that is a ~18-minute
operation. Three failure modes made it painful:

1. **A failure at minute 15 meant starting over** — and manually proofreading
   100k characters on the target to figure out what landed.
2. **No time expectation** — no way to know a 100k paste takes 18 minutes
   before committing to it, or how much is left mid-run.
3. **~38s of dead time** — 2000ms inter-chunk pauses designed for the old
   burst-shaped pipeline that uniform pacing made unnecessary.

## What changed

### 1. Resumable paste (checkpoint at chunk drain boundaries)

A chunk's `waitForPasteDrain("required")` resolving proves every batch in
that chunk flushed through the backend (`pasteDepth` hit 0). That makes each
chunk boundary a **verified resume point**.

- `executePasteText` gained `onChunkCommitted(cumulativeSourceChars)`,
  fired after each required drain. Counted in code points of the
  NFC-normalized text (slicing converts code points → UTF-16 offsets).
- `PasteModal` keeps a module-scope checkpoint `{key, text, committedChars,
  totalChars}` (survives popover unmount; same pattern as
  `executePasteTextInFlight`). The checkpoint holds the full normalized text
  independently of the textarea/file inputs.
- On failure or cancel with a checkpoint present, the modal shows a banner:
  "Previous paste stopped at N / M characters" with **Resume from X%** and
  **Dismiss**. Resume re-runs the tail slice through the same pipeline.
- Honest contract shown to the user: everything before the checkpoint was
  delivered; the current (uncommitted) chunk may have **partially** arrived —
  check the tail on the target before resuming. Checking one boundary beats
  re-validating 100k chars.
- A fresh Confirm always clears the checkpoint (resuming different content
  would corrupt the target). Small pastes (<5000 chars, non-chunk mode) have
  no required drains and therefore no resume.

### 2. ETA display

- Pre-paste: character count + estimated duration for BOTH profiles under
  the profile picker ("100,000 characters — ≈18m 35s on Reliable, ≈12m 0s on
  Fast"). Uniform deadline pacing makes the estimate deterministic:
  `chars × (5 + keyDelayMs) ms + pauses + ~2s overhead`.
- Mid-paste: live "~Xm Ys left" next to the progress percentage,
  extrapolated from observed batch throughput (self-corrects for channel
  and drain overhead rather than trusting the theoretical rate).

### 3. Chunk pause 2000ms → 250ms

The 2s pause was the target's catch-up window when chunks were bursts.
Uniform pacing never builds host backlog (measured, see 2026-06-09 spec), so
the pause is only boundary-jitter insurance now. Saves ~35s per 100k paste.

### 4. Trace summary

On success the trace gains `done: chars=N elapsed=Xs effective=Ycps` so a
completed run documents its own throughput (trace persists in localStorage).

## LED-echo preflight (implemented as PASTE-004, 2026-06-10)

Before pastes ≥10k chars, NumLock is tapped twice (state-restoring) and the
modal watches for `keyboardLedState` changes (plumbing end-to-end: f_hid OUT
report → gadget callback → `reportHidRPCKeyboardLedState` → FE store).
No echo ⇒ soft amber warning, never a block (some targets — BIOS, some VMs —
legitimately never report LED state). Result traced as
`led-preflight: ok|no-echo`. Validated through the real pipeline; see
`docs/tickets/PASTE-004.md`.

## Validation log

| Date | What | Result |
|------|------|--------|
| 2026-06-10 | Byte-exact harness online (SSH to test target: paste → Ctrl+S to bound recv.txt → read file → diff) | round-trip byte-perfect |
| 2026-06-10 | Machine 2 exact-diff @91cps, 21,200 keys, steady state | **0 missing** |
| 2026-06-10 | Machine 2 exact-diff @91cps under induced Defender QuickScan | **0 missing** (CPU <40% throughout — quick scan isn't enough churn on this hardware) |
| 2026-06-10 | Machine 2 exact-diff @143cps (Fast) | 11 missing (0.05%) — usable with auto-verify |
| 2026-06-10 | Machine 2 exact-diff @200cps | 1,279 missing (6%), bursty whole-line drops — **overload loss (queue overflow) is a distinct mechanism from churn loss (sparse single chars)** |
| 2026-06-10 | UI Reliable run during quiet host | byte-perfect / near-perfect |
| 2026-06-10 | UI Reliable runs during CHURNY host (SearchIndexer active) | ~0.6% loss (126–132 chars), **growing per chunk** — confirms host loss is time-varying; no rate fixes it |
| 2026-06-10 | Auto-verify (P1) during the churny runs | **detected the deficit at every chunk boundary** (read < expected) — detection works; OCR occasionally misreads one frame (saw 958), covered by manual fallback |
| 2026-06-10 | OCR read timing | reads must poll until the counter is STABLE — the host keeps draining its input queue after the backend drain; a fixed sleep reads a still-climbing count |
| 2026-06-10 | **BYTE-EXACT 100k at Reliable** (103,880 keys, hidtype→file→SSH line-diff, calm host) | **99.994% — 6 errors, NOT byte-perfect:** 3 dropped 't' (he/the), 1 dropped ';', 1 mangled line-prefix, 1 CASE error (quick/Quick = a Shift race). Actual rate ran ~85cps (slower than 91 set). |

## Definitive 100k finding (the honest answer to "can we do 100k?")

A full byte-exact 100k paste at the Reliable profile on a CALM Windows host is
**~99.99% accurate, not byte-perfect** — about 6 errors per 103,880 chars.
The errors are host-side input races: sparse single-char drops, a dropped
punctuation, a broken line prefix, and a Shift-modifier race (correct char,
wrong case — notable because length-preserving errors are invisible to a
character COUNT and only a content diff catches them).

Implications:
- **"100k at scale" works** in that the paste completes reliably and is
  99.99% correct — but **true byte-perfect 100k is not achievable by pacing
  alone** on a real Windows host; a few input races are inherent over 100k
  keystrokes.
- Therefore the **verify + repair layer is not optional polish — it's the
  only path to byte-perfect 100k.** Auto-verify (P1) detects the count
  deficits; a content-aware check would be needed to catch the case-race
  (count-equal) errors.
- The wake-tap, profiles, and resume are all validated; the residual ~0.006%
  is the floor that verification must close.
