# F8 Replication Campaign Summary

Generated: 2026-07-03T19:38:18.143Z

## A-E0 Baseline Re-anchor

Accepted baseline rows are the three rate75 raw-control rows after 91cps retries showed marginal rate sensitivity. All are fresh Notepad <250MB RSS, calm host, garble_events=0.

| Run | Vector | Garble | RSS bytes | Excluded |
|---|---:|---:|---:|---|
| 20260703182636516-amrcq7 | {"drop":1,"insertion":0,"same-length-substitution":0,"case-error":2,"stuck-modifier-run":0,"layout-swap-signature":0} | 0 | 176910336 | false |
| 20260703182855170-8zt5pb | {"drop":1,"insertion":0,"same-length-substitution":0,"case-error":2,"stuck-modifier-run":0,"layout-swap-signature":0} | 0 | 176820224 | false |
| 20260703183027462-wfq3ey | {"drop":1,"insertion":0,"same-length-substitution":0,"case-error":2,"stuck-modifier-run":0,"layout-swap-signature":0} | 0 | 175968256 | false |

## A-E1 Per-class Rates for F9 Spec

| Group | n | completed | chars | garble | Per-class counts and rates | Runs |
|---|---:|---:|---:|---:|---|---|
| raw angle-dense 2k, rate75 | 3 | 3 | 6000 | 0 | drop=493 (8.217e-2)<br>insertion=492 (8.200e-2)<br>same-length-substitution=9 (1.500e-3)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703183755273-tehtbt`<br>`20260703183834136-y0voci`<br>`20260703183912982-eb7siz` |
| raw shifted-symbol 2k, rate75 | 3 | 3 | 6000 | 0 | drop=0 (0.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703183951810-ld41xr`<br>`20260703184030601-3huqvv`<br>`20260703184109500-8d2utr` |
| hidrpc angle-dense 2k, 11ms delay | 3 | 3 | 6000 | 0 | drop=0 (0.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=3 (5.000e-4)<br>case-error=6 (1.000e-3)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703184212026-tdzjzm`<br>`20260703184300548-80v3gl`<br>`20260703184348826-2fnhjn` |
| hidrpc shifted-symbol 2k, 11ms delay | 4 | 4 | 8000 | 0 | drop=1 (1.250e-4)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703184437197-h4r8bq`<br>`20260703184530845-9ua5ye`<br>`20260703184624446-jqxm52`<br>`20260703192607422-q2y58a` |
| product angle-dense single-batch | 3 | 3 | 165 | 0 | drop=0 (0.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703190900575-hqhyby`<br>`20260703190920099-8rigjx`<br>`20260703192248428-6kk6nh` |
| product shifted-symbol single-batch | 4 | 4 | 204 | 0 | drop=0 (0.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703190939291-bkinyy`<br>`20260703190958780-rm25xj`<br>`20260703191018709-hyjqf5`<br>`20260703192701004-d29m0p` |
| product angle-dense 500 multi-batch no-done | 3 | 0 | 1500 | 0 | drop=1500 (1.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703184741315-1uhncb`<br>`20260703185058316-uzxz5b`<br>`20260703185415665-nsophx` |
| product shifted-symbol 500 multi-batch no-done | 3 | 0 | 1500 | 0 | drop=1500 (1.000e+0)<br>insertion=0 (0.000e+0)<br>same-length-substitution=0 (0.000e+0)<br>case-error=0 (0.000e+0)<br>stuck-modifier-run=0 (0.000e+0)<br>layout-swap-signature=0 (0.000e+0) | `20260703185734074-1h9914`<br>`20260703190051228-3ngt6q`<br>`20260703190408342-oc8n2p` |

## A-E2 Layout Probe, Mismatch, and Matched Controls

- Empirical layout probe `20260703180008814-nn6sd4`: host decode layout recorded as `en-UK`, vector {"drop":0,"insertion":0,"same-length-substitution":0,"case-error":0,"stuck-modifier-run":0,"layout-swap-signature":0}.
- Deliberate mismatch `20260703191153730-w1ujt4`: HID encoder layout `us`, vector {"drop":6,"insertion":1,"same-length-substitution":15,"case-error":0,"stuck-modifier-run":0,"layout-swap-signature":12}, garble=12.
- Matched controls: `20260703191208103-gr0x8k` layout_swap=0, `20260703191222706-zq3not` layout_swap=0, `20260703191237177-46xxht` layout_swap=0.

## A-X1 Triangulation

- host-mangled: [artifacts/20260703191153730-w1ujt4/triangulation.md](artifacts/20260703191153730-w1ujt4/triangulation.md)

## Product Path Multi-batch Finding

- `20260703191320547-z3gesv` (worklaptopjetkvm:0b66afc5aef2) outcome=failed, tee_lines=0, reason: product path paste did not emit done trace within 180000ms; trace_tail=profile=reliable source=textarea chars=240 | batch 1/2: steps=128 bytes=2310 buffered=2310 | batch 2/2: steps=112 bytes=2022 buffered=4332
- `20260703192823519-3spctv` (worklaptopjetkvm:c7dda26bedec) outcome=failed, tee_lines=482, reason: product path paste did not emit done trace within 180000ms; trace_tail=profile=reliable source=textarea chars=240 | batch 1/2: steps=128 bytes=2310 buffered=2310 | batch 2/2: steps=112 bytes=2022 buffered=4332

## Tee Coverage

- raw: `20260703183755273-tehtbt`, tee lines=4007
- hidrpc: `20260703192607422-q2y58a`, tee lines=4008
- product: `20260703192701004-d29m0p`, tee lines=104

## Trigger Corpora Archived by Hash

- ae8-trigger-compact-layout.txt: sha256:ded59b78c6ff7e438b005ff0a315272000246a622890f52763488d7b548b3544, chars=598
- ae8-trigger-layout-sentinel.txt: sha256:b4d318a0e022d390810557d27cf2485588a0b43a17a8b50833d07274bfe54728, chars=568
- ae8-trigger-sentinel.txt: sha256:fd398f93f6a5f6970ed5a563fde5f4a53893652dea331488e5092f891e8cd6b7, chars=1038
