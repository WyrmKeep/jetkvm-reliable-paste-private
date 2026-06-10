# PASTE-001 — Validate resumable paste (20k, cancel → resume)

**Status:** Done (2026-06-10)
**Feature spec:** `docs/superpowers/specs/2026-06-10-large-paste-ux.md`

## What was validated

Single-session E2E through the real paste UI against a Win11 target ("machine
2", a different laptop than the 2026-06-09 measurement machine), 21,200-key
corpus at the Reliable profile:

1. **Chunk mode on the first paste of the session** — the new
   `getPasteCapabilities` RPC replaced the observe-events latch that used to
   force every session's first paste onto the non-chunk path (no chunking, no
   resume for exactly the big first paste that needs them). Chunk labels
   appeared immediately: `Chunk 3 / 5` at cancel time.
2. **Cancel mid-chunk** → popover closes; Notepad shows a partial line
   (`L0189 the Quick brown Fox jumps` cut mid-word) — exactly the
   "uncommitted chunk may partially arrive" contract.
3. **Resume banner on reopen** (checkpoint survives popover unmount):
   "Previous paste stopped at 9,984 / 21,200 characters (47%)" — 9,984 =
   exactly 2 committed chunk drains.
4. **Resume** typed the remaining 11,216 chars in 124.9s and the document
   ended with a complete final line `L0400 … ;`.

## Count reconciliation (and what it taught us)

The run lost 12 of 21,200 chars (0.06%) at the host: C1 showed 9,977 vs
9,984 committed; final 21,188 vs 21,200. Counter semantics were ruled out by
calibration (2,448/2,448 exact at 50cps on this machine). Follow-up steady-
state sweeps on the same machine were **clean at 70, 80 AND 91 cps**
(2,448/2,448 × 3) — the loss window coincided with the first minutes after
Windows boot (EDR/indexing churn). Conclusions:

- The resume mechanism itself is correct; checkpoints reflect backend truth.
- Host-side loss is machine- AND time-varying (post-boot churn windows).
  91cps is safe on this machine in steady state, but "reliable everywhere,
  always" needs margin and/or per-target calibration → PASTE-003.

## Evidence

- ETA line rendered: "21,200 characters — ≈3m 56s on Reliable, ≈2m 31s on Fast"
- Screenshots: /tmp/resume3_c1.png, /tmp/resume3_banner.png, /tmp/resume3_c2.png
  (session host), counts read from Notepad's status bar via the KVM video.
