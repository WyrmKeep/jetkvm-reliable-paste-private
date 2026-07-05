# F14 Soak Matrix Campaign Summary

Generated: 2026-07-05T03:55:47.331Z

## Provenance

- Source commit: `ade0a2fbadcb7cf71f12ea35509e9ed88a7f7e04`
- Matrix binary sha256: `36505b38a12c2def95ce2424ebacecdb1a392a2013f0eea7478255154b9e106f`
- Harness expected-build gate: `36505b38a12`
- Device rows recorded running binary identity as `worklaptopjetkvm:36505b38a12c` with production/debug mismatch true.

## Product-path soak result (A-E5)

- Product cells passed: 20/20.
- Garble events across threshold-eligible M3 product cells: 0.
- No manual-fallback OCR rows were used. No >6k row requested auto-repair.
- Initial no-HID/UI-click failures for `M3-PROD-CODE-REL-6K` and `M3-PROD-INDEX-REL-6K` were excluded by outcome and rerun successfully.
- F17 annotated the deliberate layout-mismatch negative-control and A-X5 synthetic robustness rows as excluded from thresholds; they remain traceability evidence, not pass/fail datapoints.

| Cell | Run | Threshold | Pass | Total errors | Garble | Verification | Duration ms |
|---|---|---|---:|---:|---:|---|---:|
| `M3-PROD-CODE-REL-6K` | `20260705034828620-fm2ll2` | REL-6K | yes | 0 | 0 | auto-repair/engaged | 102750 |
| `M3-PROD-CODE-REL-30K` | `20260705023154702-c7vozr` | REL-30K | yes | 0 | 0 | manual-confirm-auto-continue/engaged | 436780 |
| `M3-PROD-CODE-FAST-6K` | `20260705023920192-ftp77r` | FAST-6K | yes | 0 | 0 | auto-repair/engaged | 82835 |
| `M3-PROD-CODE-FAST-30K` | `20260705024051759-na6l8o` | FAST-30K | yes | 0 | 0 | manual-confirm-auto-continue/engaged | 320131 |
| `M3-PROD-LONGTEXT-REL-6K` | `20260705024620617-wnpiiv` | REL-6K | yes | 0 | 0 | manual-confirm-auto-continue/engaged | 104041 |
| `M3-PROD-LONGTEXT-REL-30K` | `20260705024813355-x3dg2q` | REL-30K | yes | 0 | 0 | manual-confirm-auto-continue/engaged | 421135 |
| `M3-PROD-LONGTEXT-FAST-6K` | `20260705025523246-1t81vf` | FAST-6K | yes | 0 | 0 | auto-repair/engaged | 81906 |
| `M3-PROD-LONGTEXT-FAST-30K` | `20260705025653887-w7fl5e` | FAST-30K | yes | 0 | 0 | auto-verify/engaged | 305753 |
| `M3-PROD-SCRIPTS-REL-6K` | `20260705030208372-jn73k5` | REL-6K | yes | 0 | 0 | auto-repair/engaged | 107329 |
| `M3-PROD-SCRIPTS-REL-30K` | `20260705030404398-2sjjoz` | REL-30K | yes | 0 | 0 | auto-verify/engaged | 426077 |
| `M3-PROD-SCRIPTS-FAST-6K` | `20260705031119233-y0upzg` | FAST-6K | yes | 0 | 0 | auto-repair/engaged | 78756 |
| `M3-PROD-SCRIPTS-FAST-30K` | `20260705031246728-k39co5` | FAST-30K | yes | 0 | 0 | manual-confirm-auto-continue/engaged | 309129 |
| `M3-PROD-BINARY-REL-6K` | `20260705031804575-w1flhq` | REL-6K | yes | 0 | 0 | auto-repair/engaged | 98682 |
| `M3-PROD-BINARY-REL-30K` | `20260705031951979-f6i6s7` | REL-30K | yes | 0 | 0 | auto-verify/engaged | 399258 |
| `M3-PROD-BINARY-FAST-6K` | `20260705032639984-frm8ty` | FAST-6K | yes | 0 | 0 | auto-repair/engaged | 74613 |
| `M3-PROD-BINARY-FAST-30K` | `20260705032803304-hd1h4m` | FAST-30K | yes | 0 | 0 | auto-verify/engaged | 282647 |
| `M3-PROD-INDEX-REL-6K` | `20260705035020212-ojemfi` | REL-6K | yes | 0 | 0 | auto-repair/engaged | 101044 |
| `M3-PROD-INDEX-REL-30K` | `20260705033400652-vxtva5` | REL-30K | yes | 0 | 0 | auto-verify/engaged | 415987 |
| `M3-PROD-INDEX-FAST-6K` | `20260705034105329-xfeteg` | FAST-6K | yes | 0 | 0 | auto-repair/engaged | 76537 |
| `M3-PROD-INDEX-FAST-30K` | `20260705034230601-04s039` | FAST-30K | yes | 0 | 0 | auto-verify/engaged | 305269 |

## Targeted regression traceability

| Cell | Completed run(s) | Notes |
|---|---|---|
| `TGT-RAW-ANGLE-REL-2K` | `20260705020907505-8a8033` |  |
| `TGT-RAW-SHIFT-REL-2K` | `20260705020953668-he3omo` |  |
| `TGT-HIDRPC-ANGLE-REL-2K` | `20260705021039046-dtv1zt` |  |
| `TGT-HIDRPC-SHIFT-REL-2K` | `20260705021134239-bd9ts8` |  |
| `TGT-PROD-ANGLE-SINGLE-REL-55` | `20260705022733316-ooarvn` |  |
| `TGT-PROD-SHIFT-SINGLE-REL-51` | `20260705021433978-unlvfd` |  |
| `TGT-PROD-2BATCH-DONE-REL-240` | `20260705021500412-ik0kmd` |  |
| `TGT-PROD-ANGLE-REL-6K` | `20260705021528477-7r7nqc` |  |
| `TGT-PROD-SHIFT-REL-6K` | `20260705021729488-aoewke` |  |
| `TGT-LAYOUT-MISMATCH-RAW-167` | `20260705021234660-1s6uo0` | Deliberate mismatch, garble/layout-swap expected; F17 manual annotation excludes it from thresholds. |
| `TGT-LAYOUT-MATCHED-RAW-167` | `20260705021255543-h7vjn8`, `20260705021316367-0pf3r9`, `20260705021337238-s9yeql` |  |
| `TGT-AE8-TRIGGER-PROD-REL-598` | `20260705021944077-00gp5u`, `20260705022017338-vtgwtj`, `20260705022050423-d6a3ii`, `20260705022123630-jxcn6n`, `20260705022156929-we276m`, `20260705022230254-ud9tqf`, `20260705022303412-lzine1`, `20260705022336474-joopub`, `20260705022409577-g5uqom`, `20260705022442594-xjr2eu` |  |

## A-X5 robustness

- Unattended batch: attended=false, 10 consecutive completed product runs on `TGT-AE8-TRIGGER-PROD-REL-598`.
- Watchdog abort rows: `20260705022507363-99is8x:watchdog_abort` (F17 manual annotation excludes the synthetic row from thresholds).
- Focus-loss row: `20260705022912028-nqr4oe:focus_lost`; earlier `abort:focus` setup attempts were excluded and rerun until a true mid-run focus_lost row was recorded. F17 manual annotations document all A-X5 focus-loss synthetic rows as threshold-excluded.
- Kill -9 resume rows: `20260705022555843-y2dtkd:completed` (F17 manual annotation excludes the synthetic row from thresholds). Ledger lint passed immediately after the killed process and after resume.

## A-X3 cross-tab

- Product spec cells without completed row: none.
- Targeted spec cells without completed row: none.
- F14 soak/targeted runs without spec cell: none.
- No waivers were needed because every F9 product and targeted cell has campaign evidence.

## Paths

- Ledger: `ledger.jsonl`
- Dashboard: `dashboard.html`
- Threshold JSON: `threshold-summary.json`
- Cross-tab JSON: `cross-tab.json`
