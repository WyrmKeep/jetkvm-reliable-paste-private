# PASTE-006 — Auto-verified paste: closed-loop integrity via on-video OCR

**Status:** P1 Done & validated (2026-06-10); P2 (auto-repair) designed, not built

## P1 validation (zero-touch, machine 2, on top of a 21,165-char document)

```
ocr-calibrate: counter=21165
ocr-verify chunk 1/5: 26157 ok   (= baseline + 4,992 exactly)
ocr-verify chunk 2/5: 31149 ok
ocr-verify chunk 3/5: 36141 ok
ocr-verify chunk 4/5: 41133 ok
done: chars=21200 — pauses=0 (no human interaction)
```

Counter auto-located in the frame, baseline-relative math validated on a
non-empty target document, every boundary self-verified — and each OCR
match doubles as a zero-loss proof for the preceding chunk. Known P1
limitations / follow-ups: the LAST chunk has no confirm boundary, so the
tail isn't OCR-checked yet (add a final read to the completion summary);
the summary's expected-count display assumes an empty starting document
(OCR math doesn't); tesseract.js assets load from CDN (bundle for offline).

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

## OCR-reads-truth validation (2026-06-10, dual-SSH)

A live verified run came back with OCR reporting 6,342 vs 6,360 expected and
falling back to manual. Cross-checked against the target's real status bar
(high-res KVM screenshot): the document genuinely contained **6,342**
characters — cursor on Ln 119 not 121, and a visible dropped char
(`Quick bown Fox`). So:

- **OCR == truth** (6,342 = 6,342): the on-video counter is trustworthy
  ground truth.
- Auto-verify correctly **detected a real ~0.3% churn loss** and fell back
  to manual — a true positive, not an OCR artifact.
- The region-geometry fix (anchor stable left edge, extend right ~360px)
  resolved the earlier `unreadable` reads; calibrate-on-zero + grow-right
  now reads cleanly as the count climbs.

This is the green light for P2: since OCR reads truth, it can *drive
repair*, not just warn.

## Phases

- **P1 ✓ done & validated:** zero-setup counter auto-location + per-chunk
  OCR auto-confirm (continues on match, manual only on mismatch/unreadable),
  + final-chunk OCR check in the completion summary.
- **P2 ⚠ implemented, NOT reliable — default OFF (experimental):** auto-repair
  (backspace landed part of chunk → re-type → re-verify, bounded + self-checked).

## P2 findings (2026-06-10, fault-injector validation)

Built a clean keystroke-drop fault injector (`JETKVM_PASTE_DROP=N`, off by
default) to inject *sparse* loss without the CPU stress that also degrades
video/OCR. Testing exposed two real problems:

1. **Verify fired too early.** The backend drain (pasteDepth→0) only means
   JetKVM finished *sending*; the Windows host keeps draining its USB input
   queue afterwards, so the on-screen counter is still climbing when OCR read
   it. A fixed post-drain sleep manufactured a phantom deficit → spurious
   repairs, and the multi-pass rollback backspaced *while the count was still
   settling* and over-deleted into prior committed content (observed: rolled
   back to 899 when the floor was 4,864). **Fixed:** read now polls until the
   counter is stable (two equal reads) before comparing.
2. **Whole-chunk retype can't converge under *persistent* loss.** The injector
   (and real Fast-profile loss) drops during the retype too, so a 4,864-char
   re-type rarely lands clean — repair oscillates and bails. Repair only
   converges when per-pass loss is near-zero (i.e. the Reliable profile, where
   it's also barely needed).

**Conclusion / recommended path:** the reliable answer for 100k is **Reliable
profile (byte-perfect, validated) + auto-verify (P1) for detection + manual
resume on the rare real miss**, NOT auto-repair. P2 stays in the tree behind
an opt-in toggle (default off) with the stabilise-read fix; revisiting it
well would mean much smaller repair-mode chunks (cheap, likely-clean retypes)
or targeted single-char repair, which needs position info OCR can't give.
