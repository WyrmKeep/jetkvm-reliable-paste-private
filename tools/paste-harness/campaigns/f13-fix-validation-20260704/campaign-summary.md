# F13 Fix Validation Campaign Summary

Generated: 2026-07-04T11:01:40.050Z

## Result

- **A-E4 passed, amended 2026-07-04 gate**: 5/5 angle-dense and 5/5 shifted-symbol-storm product-path Reliable runs qualified on build `worklaptopjetkvm:e30c5d20b113`. Every qualifying row had calibration engaged, auto-repair mode, manual continuations 0, delta 0, final garble 0, tee decode exact, and isolated races 0.
- **A-E8 remains passed**: the archived F8 trigger corpus has 10/10 fixed-build product-path runs with readback garble 0 and tee decode exact. Detailed tee decode data remains in `ae8-tee-decode-summary.json`.
- **A-F8 passed**: docker golangci, scoped linux/arm cross-build, UI typecheck/vitest, and harness tests all passed on the final branch state.
- Layouts remained standardized: .110 running/debug build `worklaptopjetkvm:e30c5d20b113` reports `keyboard_layout=en-UK`, .36 was previously verified `en-UK`, and host decode layout is `en-UK`.

## A-E0 Baseline Re-anchor

| Run | Edit distance | Accuracy | Classifier vector | Garble |
| --- | --- | --- | --- | --- |
| `20260704032043546-6uxa3f` | 5/6000 | 99.9167% | drop=29, insertion=26, same-length-substitution=0, case-error=1, stuck-modifier-run=0, layout-swap-signature=0 | 0 |
| `20260704032217092-tajav4` | 4/6000 | 99.9333% | drop=2, insertion=0, same-length-substitution=0, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | 0 |
| `20260704032350541-5eznjp` | 3/6000 | 99.9500% | drop=27, insertion=26, same-length-substitution=0, case-error=1, stuck-modifier-run=0, layout-swap-signature=0 | 0 |

## F8 Before vs F13 Post-fix Side-by-side

F13 columns include threshold-eligible rows only. The manual-fallback A-E4 row `20260704103717408-cenjcu` is append-only annotated out of thresholds and was rerun.

| Cell | F8 completed/n | F8 garble | F8 vector | F13 completed/n | F13 garble | F13 vector | F13 runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F13-BASELINE-RATE75 | 3/3 | 0 | drop=3, insertion=0, same-length-substitution=0, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=58, insertion=52, same-length-substitution=0, case-error=4, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032043546-6uxa3f`<br>`20260704032217092-tajav4`<br>`20260704032350541-5eznjp` |
| TGT-RAW-ANGLE-REL-2K | 3/3 | 0 | drop=493, insertion=492, same-length-substitution=9, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=496, insertion=492, same-length-substitution=9, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032640274-7i24gw`<br>`20260704032720401-b4ij6p`<br>`20260704032800576-hkj7c8` |
| TGT-RAW-SHIFT-REL-2K | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704032840789-sh978p`<br>`20260704032921028-l9r93t`<br>`20260704033001241-e4r0ho` |
| TGT-HIDRPC-ANGLE-REL-2K | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=3, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=2, insertion=0, same-length-substitution=3, case-error=3, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033041440-60407l`<br>`20260704033131485-rl9miv`<br>`20260704033221995-bob2c3` |
| TGT-HIDRPC-SHIFT-REL-2K | 4/4 | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033312132-864bge`<br>`20260704033407276-vvtiiz`<br>`20260704033502530-a48t1v` |
| TGT-PROD-ANGLE-SINGLE-REL-55 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033642043-rdt36p`<br>`20260704033702601-s8rvfe`<br>`20260704033723514-wexc6w` |
| TGT-PROD-SHIFT-SINGLE-REL-51 | 4/4 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033744345-xh8iqy`<br>`20260704033851406-3h2ya4`<br>`20260704034128310-wzkvgo` |
| TGT-PROD-2BATCH-DONE-REL-240 | 0/2 | 0 | drop=480, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 3/3 | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=18, stuck-modifier-run=0, layout-swap-signature=0 | `20260704033912416-614kof`<br>`20260704033935453-rwacx5`<br>`20260704033958460-wmlt7c` |
| TGT-AE8-TRIGGER-PROD-REL-598 | 1/1 | 0 | drop=2, insertion=2, same-length-substitution=45, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 10/10 | 0 | drop=2, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | `20260704035131642-0ikzya`<br>`20260704035159358-f47dh5`<br>`20260704035228128-qr58rs`<br>`20260704035257075-0ilybp`<br>`20260704035326611-9wpilj`<br>`20260704035355400-ez2i8n`<br>`20260704035424161-5sc3kv`<br>`20260704035453096-tq9qjd`<br>`20260704035522109-qd30u4`<br>`20260704035551040-0k1hgy` |

## A-E4 Amended Gate Evidence

### Angle-dense, 5/5 qualifying rows

| Run | Corpus | Delta | Final garble | Isolated races | Tee exact | Tee records | OCR | CPU max | Sink RSS | Done line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `20260704090615177-fffabj` | angle-dense:seed=f13-angle:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 0.28% | 172437504 | done: chars=6000 elapsed=91.5s effective=65.6cps |
| `20260704090807774-qt89l1` | angle-dense:seed=f13-angle:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 0.58% | 173580288 | done: chars=6000 elapsed=90.9s effective=66.0cps |
| `20260704091001592-ge2nji` | angle-dense:seed=f13-angle:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 5.66% | 173387776 | done: chars=6000 elapsed=91.4s effective=65.7cps |
| `20260704101922456-iog9eh` | angle-dense:seed=f13-angle:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 7.16% | 173191168 | done: chars=6000 elapsed=92.5s effective=64.9cps |
| `20260704102444764-niolbb` | angle-dense:seed=f13-angle:size=6000 | 0 | 0 | 0 | yes | 12004 | engaged | 8.4% | 245714944 | done: chars=6000 elapsed=93.2s effective=64.4cps |

### Shifted-symbol-storm, 5/5 qualifying rows

| Run | Corpus | Delta | Final garble | Isolated races | Tee exact | Tee records | OCR | CPU max | Sink RSS | Done line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `20260704104252550-ni8i0f` | shifted-symbol-storm:seed=f13-shifted:size=6000 | 0 | 0 | 0 | yes | 12004 | engaged | 2.81% | 172662784 | done: chars=6000 elapsed=106.8s effective=56.2cps |
| `20260704104515052-omynqx` | shifted-symbol-storm:seed=f13-shifted:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 18.18% | 172789760 | done: chars=6000 elapsed=106.5s effective=56.3cps |
| `20260704104737294-viuxfd` | shifted-symbol-storm:seed=f13-shifted:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 3.88% | 172937216 | done: chars=6000 elapsed=106.9s effective=56.1cps |
| `20260704105001133-igo4mb` | shifted-symbol-storm:seed=f13-shifted:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 16.36% | 173510656 | done: chars=6000 elapsed=106.1s effective=56.5cps |
| `20260704105223245-we4p89` | shifted-symbol-storm:seed=f13-shifted:size=6000 | 0 | 0 | 0 | yes | 12003 | engaged | 8.1% | 172933120 | done: chars=6000 elapsed=106.6s effective=56.3cps |

### Excluded and rerun rows

| Run | Cell | Outcome | HID reports | Reason |
| --- | --- | --- | --- | --- |
| `20260704101208918-1gow7y` | TGT-PROD-ANGLE-REL-6K | abort:preflight | 0 | build_identity_mismatch |
| `20260704103344657-itgos6` | TGT-PROD-SHIFT-REL-6K | failed | 0 | locator.click: Timeout 15000ms exceeded.<br>Call log:<br>  - waiting for getByRole('button', { name: /Confirm Paste/i }).first()<br>    - locator resolved to <button disabled class="group cursor-pointer outline-hidden">…</button><br>  - attempting click action<br>    2 × waiting for element to be visible, enabled and stable<br>      - element is not enabled<br>    - retrying click action<br>    - waiting 20ms<br>    2 × waiting for element to be visible, enabled and stable<br>      - element is not enabled<br>    - retrying click action<br>      - waiting 100ms<br>    28 × waiting for element to be visible, enabled and stable<br>       - element is not enabled<br>     - retrying click action<br>       - waiting 500ms<br> |
| `20260704103717408-cenjcu` | TGT-PROD-SHIFT-REL-6K | completed | 12008 | A-E4 manual-fallback run excluded and rerun; OCR calibration manual-fallback with manual_confirm_continuations=4 |

Step-only preflight attempts with no run row and no HID output: `20260704102123204-x5diub` (abort:preflight: Warning: Permanently added '192.168.1.110' (ED25519) to the list of known hosts.
), `20260704102646820-2tfmsd` (abort:preflight: Warning: Permanently added '192.168.1.110' (ED25519) to the list of known hosts.
), `20260704103200789-sv5iw4` (abort:preflight: Warning: Permanently added '192.168.1.110' (ED25519) to the list of known hosts.
).

## A-E8 Trigger Gate Evidence

| Run | Outcome | Readback garble | Readback vector | Tee exact | Tee records | Tee unknown reports | Readback delta |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `20260704035131642-0ikzya` | completed | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1200 | 0 | -1 |
| `20260704035159358-f47dh5` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035228128-qr58rs` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035257075-0ilybp` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035326611-9wpilj` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035355400-ez2i8n` | completed | 0 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | -1 |
| `20260704035424161-5sc3kv` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035453096-tq9qjd` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035522109-qd30u4` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |
| `20260704035551040-0k1hgy` | completed | 0 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | yes | 1199 | 0 | 0 |

## A-F8 Final Validators

| Command | Exit | Observation |
| --- | --- | --- |
| `DOCKER_HOST= DOCKER_CONFIG=/tmp/jetkvm-docker-config docker run --rm --platform linux/amd64 -v "$PWD:/build" -w /build -e GOFLAGS=-buildvcs=false golangci/golangci-lint:v2.12.2 golangci-lint run --timeout 5m` | 0 | 0 issues. |
| `GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build $(go list ./internal/... ./pkg/... \| grep -v -e internal/native -e internal/regression)` | 0 | Scoped linux/arm cross-build completed successfully. |
| `cd ui && npx tsc --noEmit && npx vitest run` | 0 | TypeScript passed; vitest reported 5 files and 16 tests passed. |
| `cd tools/paste-harness && npm test` | 0 | Vitest reported 13 files and 73 tests passed. |
| `cd tools/paste-harness && node ledger-lint.js campaigns/f13-fix-validation-20260704/ledger.jsonl` | 0 | Ledger lint returned ok=true with zero violations. |

Dashboard: `dashboard.html`.
