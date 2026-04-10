# CLAUDE.md

Fork-specific context for Claude Code. For general dev setup, see `DEVELOPMENT.md`.

## This repo

- **Fork**: `WyrmKeep/jetkvm-reliable-paste-private` — paste reliability work, NOT upstream `jetkvm/kvm`
- **File issues/PRs on this fork**, not upstream. Upstream has different issue numbers.
- **Plans/specs** live in `docs/superpowers/{specs,plans}/YYYY-MM-DD-<topic>.md`

## Deploy to device

Two modes — pick carefully:

- **Ephemeral (iterating)**: `./dev_deploy.sh -r <IP>` — runs debug binary as child of SSH session. Closing terminal, killing the task, or SSH drop → binary dies → init restarts old production build.
- **Persistent (testing)**: `./dev_deploy.sh -r <IP> -i --skip-native-build` — release build, stages to `/userdata/jetkvm/jetkvm_app.update`, reboots device, boot process promotes it to production `jetkvm_app`. Survives everything.

Windows users must run from **WSL with the repo in Linux filesystem** (`~/jetkvm`, not `/mnt/c/`) — CRLF line endings break shell scripts, CMake FetchContent, and npm postinstall.

## Verification (no unit test framework)

Frontend has no vitest/jest — verify changes with:

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
```

Go tests: `./dev_deploy.sh -r <IP> --run-go-tests`. E2E: `make test_e2e DEVICE_IP=<IP>` (wipes device config, requires HDMI+USB attached).

## Paste pipeline gotchas (active work area)

- **Byte formula is `6 + stepCount * 18`**, not `6 + stepCount * 9`. Each `MacroStep` gets expanded into 2 `KeyboardMacroStep`s (press + reset) by `executeMacroRemote` in `ui/src/hooks/useKeyboard.ts`, and each wire step is 9 bytes. The single source of truth is `estimateBatchBytes()` in `ui/src/utils/pasteMacro.ts`.
- **Single batching path**: `buildPasteMacroBatches()` in `pasteMacro.ts`. Do not reintroduce inline batching in `executePasteText`.
- **Flow control lives in the hook**: `PASTE_LOW_WATERMARK`/`PASTE_HIGH_WATERMARK` watermarks and the `isPasteInProgress` drain subscription are in `executePasteText` because they need the WebRTC channel ref. Don't extract them.
- **Completion is paste-level (`isPasteInProgress`)** but still has known race issues tracked in #42. Don't assume macro-level completion.
- **Don't merge PR #37 wholesale** — it was built for the pre-pipeline ACK-per-batch model. Cherry-pick correctness fixes only (#33 leak, #34 UpdateKeysDown on failed write, #35 timer reuse).

## Preferred paste patch sequence

1. #42 (completion semantics, paste-level `State:true`/`State:false`)
2. #36/#38 (target-side settling, ported onto pipeline — not as old fixed sleeps)
3. #41 + #40 (batching consolidation ✓ done in PR #47, profile re-tuning)
4. Backend fixes cherry-picked from #37 (#33, #34, #35), then #44/#45
