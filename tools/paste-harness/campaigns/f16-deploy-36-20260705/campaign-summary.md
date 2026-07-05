# F16 Deploy .36 and Checklist Summary

Generated: 2026-07-05T10:56:39.107Z

## Build and deploy identity

- Device: `192.168.1.36` (`jetkvm-50248789f5727d74`)
- Required source SHA: `58eac4f7216a6bd7963783c015a8a7a1de952d29`
- Deployed binary sha256: `fb5a6bdb12efe66508e4661faf8ffba60ae0a113cbd203d727727d7e95ba39ab`
- Device build identity: `jetkvm-50248789f5727d74:fb5a6bdb12ef`
- Version JSON after reboot: `0.5.5`, branch `paste/008-content-verification`, revision `58eac4f7216a6bd7963783c015a8a7a1de952d29`, build date `2026-07-05T10:12:48+0000`.
- Deploy started: `2026-07-05T10:55:26.300Z`; verified post-reboot: `2026-07-05T10:56:39.107Z`.

The `.36` device previously ran stale Apr-29 build `0.5.5-dev202604292220` at revision `a83a02501855a5e77ad6becf0e65fd41e21b548b`, binary sha256 `91f7f2949c52b600e9077ccb24b234f8057ed4206c339b51d0277fe357817f97`.

## Parity target

F15 validated and permanently deployed `.110` to the same source SHA and same binary hash:

- `.110` campaign: `tools/paste-harness/campaigns/f15-deploy-110-20260705/`
- `.110` build identity: `worklaptopjetkvm:fb5a6bdb12ef`
- `.110` binary sha256: `fb5a6bdb12efe66508e4661faf8ffba60ae0a113cbd203d727727d7e95ba39ab`
- `.110` provenance row: `20260705103021000-f15prov`

## Deployment method

The feature requested the persistent install command:

```bash
./dev_deploy.sh -r 192.168.1.36 -i --skip-native-build
```

For exact bit-for-bit parity, F16 staged the already-built F15 `bin/jetkvm_app` to `/userdata/jetkvm/jetkvm_app.update` and rebooted. Rebuilding with `dev_deploy.sh` would embed a new build date and produce a different binary hash. The staged hash, post-reboot production hash, and `.110` production hash all match.

## Final `.36` device state

- `auto_update_enabled=false`
- `keyboard_layout=en-UK`
- No `/userdata/jetkvm/jetkvm_app.update` remains staged
- Production `jetkvm_app` process trio is running from `/userdata/jetkvm/bin/jetkvm_app`
- No `jetkvm_app_debug` process is running

## Ledger and dashboard

- Ledger: `tools/paste-harness/campaigns/f16-deploy-36-20260705/ledger.jsonl`
- Identity artifact: `tools/paste-harness/campaigns/f16-deploy-36-20260705/artifacts/f16-deploy-36-parity/identity.json`
- Dashboard: `tools/paste-harness/campaigns/f16-deploy-36-20260705/dashboard.html`

## Manual checklist

User checklist for the `.36`-attached host:

- `docs/handoff/2026-07-05-jetkvm-36-user-checklist.md`

The checklist header requires confirming revision `58eac4f7216a6bd7963783c015a8a7a1de952d29` in the device web UI before step 1. No pre-parity checklist result counts toward acceptance.
