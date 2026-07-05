# F8 Reclassified Summary

Generated: 2026-07-03T21:46:06.516Z

Classifier version: `paste-harness-classifier/1.0.1`

Evidence source: recv snapshots only. The stale early raw tee logs documented in harness conventions were not used.

Rows checked: 28
Rows with changed per-class vectors: 0
F9 spec threshold/table update required: no

## Manual Exclusions Present In Ledger

| Run | Reason |
|---|---|
| `20260703190840598-q9q5me` | contaminated by stale Notepad content after prior product no-done runs; excluded by F8 campaign summary |
| `20260703191710394-735kpg` | contaminated by stale product-240 no-done residue from 20260703191320547-z3gesv; recv line 1 inflated insertion count |

## Group Aggregates

| Group | n | chars | Reclassified vector | Garble class count | Changed rows |
|---|---:|---:|---|---:|---|
| baseline rate75 accepted rows | 3 | 18000 | drop=3, insertion=0, same-length-substitution=0, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| raw angle-dense 2k, rate75 | 3 | 6000 | drop=493, insertion=492, same-length-substitution=9, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| raw shifted-symbol 2k, rate75 | 3 | 6000 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| hidrpc angle-dense 2k, 11ms delay | 3 | 6000 | drop=0, insertion=0, same-length-substitution=3, case-error=6, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| hidrpc shifted-symbol 2k, 11ms delay | 4 | 8000 | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| product angle-dense single-batch | 3 | 165 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| product shifted-symbol single-batch | 4 | 204 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| layout probe | 1 | 167 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |
| layout mismatch | 1 | 167 | drop=6, insertion=1, same-length-substitution=15, case-error=0, stuck-modifier-run=0, layout-swap-signature=12 | 12 | none |
| layout matched controls | 3 | 501 | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | 0 | none |

## Row Vectors

| Run | Purpose | Previous version | Reclassified vector | Changed |
|---|---|---|---|---|
| `20260703182636516-amrcq7` | F8-baseline-diagnostic-rate75 | `paste-harness-classifier/1.0.0` | drop=1, insertion=0, same-length-substitution=0, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703182855170-8zt5pb` | F8-baseline-diagnostic-rate75 | `paste-harness-classifier/1.0.0` | drop=1, insertion=0, same-length-substitution=0, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703183027462-wfq3ey` | F8-baseline-diagnostic-rate75 | `paste-harness-classifier/1.0.0` | drop=1, insertion=0, same-length-substitution=0, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703183755273-tehtbt` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=164, insertion=164, same-length-substitution=3, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703183834136-y0voci` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=164, insertion=164, same-length-substitution=3, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703183912982-eb7siz` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=165, insertion=164, same-length-substitution=3, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703183951810-ld41xr` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184030601-3huqvv` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184109500-8d2utr` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184212026-tdzjzm` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=1, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184300548-80v3gl` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=1, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184348826-2fnhjn` | F8-replication-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=1, case-error=2, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184437197-h4r8bq` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184530845-9ua5ye` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=1, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703184624446-jqxm52` | F8-replication-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703192607422-q2y58a` | F8-replication-shifted-symbol-tee-current | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703190900575-hqhyby` | F8-replication-product-single-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703190920099-8rigjx` | F8-replication-product-single-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703192248428-6kk6nh` | F8-replication-product-single-angle-dense | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703190939291-bkinyy` | F8-replication-product-single-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703190958780-rm25xj` | F8-replication-product-single-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703191018709-hyjqf5` | F8-replication-product-single-shifted-symbol | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703192701004-d29m0p` | F8-replication-product-single-shifted-symbol-tee-current | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703180008814-nn6sd4` | F8-layout-probe | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703191153730-w1ujt4` | F8-layout-mismatch | `paste-harness-classifier/1.0.0` | drop=6, insertion=1, same-length-substitution=15, case-error=0, stuck-modifier-run=0, layout-swap-signature=12 | no |
| `20260703191208103-gr0x8k` | F8-layout-matched | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703191222706-zq3not` | F8-layout-matched | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |
| `20260703191237177-46xxht` | F8-layout-matched | `paste-harness-classifier/1.0.0` | drop=0, insertion=0, same-length-substitution=0, case-error=0, stuck-modifier-run=0, layout-swap-signature=0 | no |

