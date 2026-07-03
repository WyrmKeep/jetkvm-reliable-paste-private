# A-X1 Triangulation Artifact: 20260703191153730-w1ujt4

Verdict: **host-mangled**. The tee re-decodes as the US-intended symbol stream, while the Windows readback follows the same tee reports under the UK host layout. This is deterministic layout crossover, not random device byte emission.

- Run: `20260703191153730-w1ujt4`
- Ledger cell: `A-E2-MISMATCH-1`
- Corpus hash: `sha256:f62c35d8e56131dae2f17b713b7cf2b8fae4d01de42c8e69971edd9c8d4ce79d`
- Device build: `worklaptopjetkvm:0b66afc5aef2`
- HID encoder layout: `us`
- Host decode layout: `en-UK`
- Classifier vector: `{"drop":6,"insertion":1,"same-length-substitution":15,"case-error":0,"stuck-modifier-run":0,"layout-swap-signature":12}`
- Tee excerpt: `tee-excerpt-layout-symbols.jsonl`

## Readback diff hunk

Expected (UK-intended probe):

```text
L0000 empirical-layout-probe UK symbols @ " # ~ \ | £ <> end
L0001 repeats @@@ """ ### ~~~ \\ ||| £££ <><><>
L0002 shifted-pairs 2" 3£ quote@ slash\ pipe| hash# tilde~
```

Actual readback:

```text
L0000 empirical-layout-probe UK symbols " @ £ ¬ # ~  <> end
L0001 repeats """ @@@ £££ ¬¬¬ ## ~~~  <><><>
L0002 shifted-pairs 2@ 3 quote" slash# pipe~ hash£ tilde¬
```

## Tee decoder cross-check

Decoded as US (device-side intent):

```text
L0000 empirical-layout-probe UK symbols @ " # ~ \ |  <> end
L0001 repeats @@@ """ ### ~~~ \\ |||  <><><>
L0002 shifted-pairs 2" 3 quote@ slash\ pipe| hash# tilde~
```

Decoded as UK (host interpretation, matches readback):

```text
L0000 empirical-layout-probe UK symbols " @ £ ¬ # ~  <> end
L0001 repeats """ @@@ £££ ¬¬¬ ## ~~~  <><><>
L0002 shifted-pairs 2@ 3 quote" slash# pipe~ hash£ tilde¬
```

## Recomputed classifier details

```json
{
  "labels": [
    "drop",
    "insertion",
    "same-length-substitution",
    "layout-swap-signature"
  ],
  "vector": {
    "drop": 6,
    "insertion": 1,
    "same-length-substitution": 15,
    "case-error": 0,
    "stuck-modifier-run": 0,
    "layout-swap-signature": 12
  },
  "layoutSwapDetails": [
    {
      "pair": "@<->\"",
      "from": "\"",
      "to": "@",
      "count": 2
    },
    {
      "pair": "@<->\"",
      "from": "@",
      "to": "\"",
      "count": 2
    },
    {
      "pair": "#<->\\",
      "from": "\\",
      "to": "#",
      "count": 2
    },
    {
      "pair": "#<->£",
      "from": "#",
      "to": "£",
      "count": 2
    },
    {
      "pair": "~<->¬",
      "from": "~",
      "to": "¬",
      "count": 2
    },
    {
      "pair": "~<->|",
      "from": "|",
      "to": "~",
      "count": 2
    }
  ]
}
```
