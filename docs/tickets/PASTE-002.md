# PASTE-002 — 100k file-upload paste at scale

**Status:** Done (2026-06-10)

## Run

The real workflow end-to-end: 103,880-key corpus uploaded as a FILE through
the paste menu, Reliable profile (91 cps uniform), Win11 target "machine 2".

| Metric | Result |
|---|---|
| Predicted (ETA feature) | ≈19m 10s |
| Actual | 19m 12s (1151.7s), 90.2 effective cps |
| Delivered | **103,730 / 103,880 (99.86%)** |
| Mechanics | file upload ✓, 21 chunks ✓, drains ✓, no stalls, no failures |

## The 0.14% and what it means

This machine is *clean* at 91 cps in short runs (3 × 2,448/2,448 sweeps at
70/80/91 cps the same morning). The ~150 lost keys over 19 minutes land in
transient Windows background-churn windows (Defender/indexing/updates) that
any multi-minute run will cross. Conclusion, now twice-measured: **no fixed
rate makes long blind typing lossless on arbitrary Windows machines — the
product answer is verification + checkpoint repair, not more slowness.**
That is PASTE-003.

## Evidence

- Driver log: ETA line, `paste finished=true elapsedSec=1151.7 effectiveCps=90.2`
- Final Notepad status bar: `Ln 1956, Col 3 — 103,730 characters`
