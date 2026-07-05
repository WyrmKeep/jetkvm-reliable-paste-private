# F15 Deploy .110 Campaign Summary

Generated: 2026-07-05T10:33:52.384Z

## Build and deploy identity

- Branch SHA deployed: `58eac4f7216a6bd7963783c015a8a7a1de952d29`
- Deployed binary sha256: `fb5a6bdb12efe66508e4661faf8ffba60ae0a113cbd203d727727d7e95ba39ab`
- Harness/device build identity: `worklaptopjetkvm:fb5a6bdb12ef`
- Version JSON after reboot: `0.5.5`, branch `paste/008-content-verification`, revision `58eac4f7216a6bd7963783c015a8a7a1de952d29`, build date `2026-07-05T10:12:48+0000`.
- Persistent deploy command run: `./dev_deploy.sh -r 192.168.1.110 -i --skip-native-build`
- Pre-deploy production sha256: `6ea2828e34153a83fdb6e6621a9fdf47ee10bff96a8410630d6ada327c1334f6`
- Post-reboot/final production sha256: `fb5a6bdb12efe66508e4661faf8ffba60ae0a113cbd203d727727d7e95ba39ab`

## Provenance prerequisite

F14 green evidence was recorded at source commit `ade0a2fbadcb7cf71f12ea35509e9ed88a7f7e04` with binary sha256 `36505b38a12c2def95ce2424ebacecdb1a392a2013f0eea7478255154b9e106f` (20/20 product cells passed, garble total 0). Current HEAD `58eac4f7216a6bd7963783c015a8a7a1de952d29` only adds committed F14 campaign evidence on top of that code, but the deployed binary embeds the current revision and has a distinct hash, so F15 ran the short A-E4 confirmation on the exact deployed hash.

The ledger also contains `purpose=deploy_provenance` row `20260705103021000-f15prov` recording the hash-to-branch mapping.

## A-E4 short confirmation on deployed hash

Qualifying consecutive window: `20260705102217529-fiwf2s`, `20260705102520347-pk4a7y`. Both were product path, Reliable, 6k angle-dense, calibration engaged, auto-repair, calm host, tee enabled/non-empty, final readback exact, tee decode exact, and garble 0. Two no-HID UI-click attempts were excluded before any HID output: `20260705101806491-5hcube`, `20260705101951092-fci1tt`.

| Run | Outcome | Excluded | Readback exact | Tee exact | Tee records | Garble | OCR | CPU max | Done |
|---|---|---|---|---|---:|---:|---|---:|---|
| `20260705101613067-sm4ujf` | completed | no | yes | yes | 12003 | 0 | engaged | 13.07% | done: chars=6000 elapsed=87.6s effective=68.5cps |
| `20260705101806491-5hcube` | failed | yes | no | no | 0 | 0 | not-requested | 6.22% | failed |
| `20260705101951092-fci1tt` | failed | yes | no | no | 0 | 0 | not-requested | 17.64% | failed |
| `20260705102217529-fiwf2s` | completed | no | yes | yes | 12003 | 0 | engaged | 19.47% | done: chars=6000 elapsed=87.7s effective=68.4cps |
| `20260705102520347-pk4a7y` | completed | no | yes | yes | 12003 | 0 | engaged | 1.6% | done: chars=6000 elapsed=87.6s effective=68.5cps |

## Deploy smoke

| Run | Outcome | Readback exact | Garble | Vector | CPU max | Done |
|---|---|---|---:|---|---:|---|
| `20260705102856838-khjcmi` | completed | yes | 0 | {"drop":0,"insertion":0,"same-length-substitution":0,"case-error":0,"stuck-modifier-run":0,"layout-swap-signature":0} | 7.75% | done: chars=2000 elapsed=31.4s effective=63.7cps |

## Final device state

- `auto_update_enabled=false` in `/userdata/kvm_config.json`.
- `keyboard_layout=en-UK` in `/userdata/kvm_config.json`.
- No `/userdata/jetkvm/jetkvm_app.update` remains staged.
- Production process trio is running from `/userdata/jetkvm/bin/jetkvm_app`: supervisor, app, native+video.
- No `jetkvm_app_debug` process remains.

## Paths

- Ledger: `ledger.jsonl`
- Dashboard: `dashboard.html`
- Summary JSON: `campaign-summary.json`
