# F13 Fix Validation Campaign Summary

Generated: 2026-07-04T04:03:22.412Z

## Result

- **A-E4 failed**: the first repair-assisted 6k angle-dense product run calibrated OCR and completed with zero garble, but final readback was not byte-perfect (edit distance 13, delta 0). Per the F13 instruction, validation stops as failed evidence rather than attempting firmware surgery.
- **A-E8 passed its garble-dead gate**: 10/10 archived trigger runs completed with readback garble=0, and the tee decoder reproduced the trigger corpus exactly for all 10 tee logs.
- Layouts were standardized: .110 production/debug build `worklaptopjetkvm:6ea2828e3415` reports `keyboard_layout=en-UK`; .36 was verified `keyboard_layout=en-UK`; the F13 empirical layout probe row decoded as en-UK with layout-swap=0.

## A-E0 Baseline Re-anchor

| Run | Edit distance | Accuracy | Classifier vector | Garble |
|---|---:|---:|---|---:|
| 20260704032043546-6uxa3f | 5/6000 | 99.9167% | drop=29, insertion=26, same-length-substitution=0, case-error=1, stuck-modifier-run=0, layout-swap-signature=0 | 0 |
| 20260704032217092-tajav4 | 4/6000 | 99.9333% | drop=2, insertion=0, same-length-substitution=0, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | 0 |
| 20260704032350541-5eznjp | 3/6000 | 99.9500% | drop=27, insertion=26, same-length-substitution=0, case-error=1, stuck-modifier-run=0, layout-swap-signature=0 | 0 |

## F8 Before vs F13 Post-fix Side-by-side

F13 columns include threshold-eligible rows only, so the one Playwright pre-typing failure is excluded.

| Cell | F8 completed/n | F8 garble | F8 vector | F13 completed/n | F13 garble | F13 vector | F13 runs |
|---|---:|---:|---|---:|---:|---|---|
| F13-BASELINE-RATE75 (baseline rate75 raw 6k) | 3/3 | 0 | drop=3, insertion=0, same-length-substitution=0, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=58, insertion=52, same-length-substitution=0, case-error=4, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032043546-6uxa3f`<br>`20260704032217092-tajav4`<br>`20260704032350541-5eznjp` |
| TGT-RAW-ANGLE-REL-2K (raw angle 2k rate75) | 3/3 | 0 | drop=493, insertion=492, same-length-substitution=9, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=496, insertion=492, same-length-substitution=9, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032640274-7i24gw`<br>`20260704032720401-b4ij6p`<br>`20260704032800576-hkj7c8` |
| TGT-RAW-SHIFT-REL-2K (raw shifted 2k rate75) | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032840789-sh978p`<br>`20260704032921028-l9r93t`<br>`20260704033001241-e4r0ho` |
| TGT-HIDRPC-ANGLE-REL-2K (hidrpc angle 2k 11ms) | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=3, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=2, insertion=0, same-length-substitution=3, case-error=3, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033041440-60407l`<br>`20260704033131485-rl9miv`<br>`20260704033221995-bob2c3` |
| TGT-HIDRPC-SHIFT-REL-2K (hidrpc shifted 2k 11ms) | 4/4 | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033312132-864bge`<br>`20260704033407276-vvtiiz`<br>`20260704033502530-a48t1v` |
| TGT-PROD-ANGLE-SINGLE-REL-55 (product angle single) | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033642043-rdt36p`<br>`20260704033702601-s8rvfe`<br>`20260704033723514-wexc6w` |
| TGT-PROD-SHIFT-SINGLE-REL-51 (product shifted single) | 4/4 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033744345-xh8iqy`<br>`20260704033851406-3h2ya4`<br>`20260704034128310-wzkvgo` |
| TGT-PROD-2BATCH-DONE-REL-240 (product 2-batch done) | 0/2 | 0 | drop=480, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=18, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033912416-614kof`<br>`20260704033935453-rwacx5`<br>`20260704033958460-wmlt7c` |
| TGT-AE8-TRIGGER-PROD-REL-598 (AE8 trigger product tee) | 1/1 | 0 | drop=2, insertion=2, same-length-substitution=45, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 10/10 | 0 | drop=2, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704035131642-0ikzya`<br>`20260704035159358-f47dh5`<br>`20260704035228128-qr58rs`<br>`20260704035257075-0ilybp`<br>`20260704035326611-9wpilj`<br>`20260704035355400-ez2i8n`<br>`20260704035424161-5sc3kv`<br>`20260704035453096-tq9qjd`<br>`20260704035522109-qd30u4`<br>`20260704035551040-0k1hgy` |

## A-E4 Repair-assisted Gate Evidence

| Run | Outcome | OCR | Mode | Manual continues | Garble pre-repair | Delta | Edit distance | Vector | Done line |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 20260704034230019-wno22q | completed | engaged | auto-repair | 0 | 0 | 0 | 13 | drop=355, insertion=355, same-length-substitution=2, case-error=1, stuck-modifier-run=0, layout-swap-signature=0 | done: chars=6000 elapsed=419.1s effective=14.3cps |

The A-E4 row is calibration-engaged and repair-assisted, but final byte-perfect criteria were not met. The observed corruption is sparse race/case-class, not garble-class.

## A-E8 Trigger Gate Evidence

| Run | Outcome | Readback garble | Readback vector | Tee exact | Tee records | Tee unknown reports | Readback delta |
|---|---|---:|---|---|---:|---:|---:|
| 20260704035131642-0ikzya | completed | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1200 | 0 | -1 |
| 20260704035159358-f47dh5 | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035228128-qr58rs | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035257075-0ilybp | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035326611-9wpilj | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035355400-ez2i8n | completed | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | -1 |
| 20260704035424161-5sc3kv | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035453096-tq9qjd | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035522109-qd30u4 | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| 20260704035551040-0k1hgy | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |

Detailed tee decode data: `ae8-tee-decode-summary.json`. Dashboard: `dashboard.html`.
