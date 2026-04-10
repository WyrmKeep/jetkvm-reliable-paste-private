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

### Verification gotchas

- **`ui-lint` CI has been failing on main since 2026-03-15** (pre-existing drift in `Button.tsx`, `PasteModal.tsx`, `pasteMacro.ts`, `stores.ts`). `golangci-lint` is the real merge gate. Don't block on ui-lint red.
- **ESLint locally on Windows**: 600+ `prettier/prettier` CRLF errors are a `core.autocrlf=true` working-copy artifact — committed blobs are LF. Verify: `git cat-file -p <sha>:<file> | tr -d -c '\r' | wc -c` → 0.
- **`go test ./...` exec-format-errors under buildkit** (ARM cross-compile on amd64 host). Compile-only gate: `go test -c -o /dev/null <pkg>` per package. Runtime tests via `./dev_deploy.sh -r <IP> --run-go-tests`.
- **buildkit requires `make build_native`** first to generate C artifacts before `go build ./...` succeeds inside the container.

## Paste pipeline gotchas (active work area)

- **Byte formula is `6 + stepCount * 18`**, not `6 + stepCount * 9`. Each `MacroStep` gets expanded into 2 `KeyboardMacroStep`s (press + reset) by `executeMacroRemote` in `ui/src/hooks/useKeyboard.ts`, and each wire step is 9 bytes. The single source of truth is `estimateBatchBytes()` in `ui/src/utils/pasteMacro.ts`.
- **Single batching path**: `buildPasteMacroBatches()` in `pasteMacro.ts`. Do not reintroduce inline batching in `executePasteText`.
- **Flow control lives in the hook**: `PASTE_LOW_WATERMARK`/`PASTE_HIGH_WATERMARK` watermarks and the `isPasteInProgress` drain subscription are in `executePasteText` because they need the WebRTC channel ref. Don't extract them.
- **Paste completion is edge-triggered on `pasteDepth atomic.Int32`** (PR #49). State emits fire only on 0↔1 transitions. Decisions use `Add()` return value, never `Load`. Non-paste macros don't touch it. `queuedMacro.session` carries the origin `*Session` — emits go to that session, not global `currentSession`.
- **Don't merge PR #37 wholesale** — built for pre-pipeline ACK-per-batch. #34 ✓ PR #49. Still pending cherry-pick: #33 leak, #35 timer reuse.
- **`drainMacroQueue`'s 200ms inter-macro `time.Sleep`** is PR #41's load-bearing fix — preserve verbatim in any drain refactor.
- **`waitForPasteDrain("required", ...)` ships with zero call sites** — reserved for #38 Phase 2 chunk boundaries. Don't delete as dead code.

## Phased paste patch rollout

- **Phase 1 ✓ PR #49** — #42 paste-depth semantics + #48 shallow 64-slot queue + #34 UpdateKeysDown guard + `waitForPasteDrain` helper + `onHidMessage` goroutine-leak fix
- **Phase 2** — #38 large-paste safe mode; wire `waitForPasteDrain("required")` into chunk boundaries
- **Phase 3a** — #40 profile retuning on consolidated batching
- **Phase 3b** — #43 timer reuse in `drainMacroQueue` (independent of 3a)
- **Phase 4** — #44 timed-sequence HID writer (REDESIGN required)
- **Phase 5** — #45 frontend vitest harness + alloc cleanup

## Oracle (GPT-5.4 Pro cross-review)

Independent cross-review via `oracle --engine browser --browser-manual-login` (project folder pinned in `~/.oracle/config.json` → `chatgpt.com/g/g-p-69d97bcf2f3881918b0de0e654f06bb2/project`). Every run MUST include all three inputs:

1. **Issue/PR link or number** in the prompt text (e.g., "Cross-review Phase 1 PR #49, closes #42 #48 #34")
2. **Spec and plan in full** via `--file docs/superpowers/specs/<topic>.md --file docs/superpowers/plans/<topic>.md`
3. **Explicit cross-review ask** in the prompt: "Cross-review against correctness invariants, scope constraints, and known races. Provide suggestions."

Template:
```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s --browser-auto-reattach-interval 3s --browser-auto-reattach-timeout 60s \
  --file docs/superpowers/specs/<topic>.md --file docs/superpowers/plans/<topic>.md \
  -p "Cross-review <issue/PR>. <1-line context>. Verify invariants, scope, race scenarios. Suggest concrete improvements."
```

Patched login probe at `~/AppData/Roaming/npm/node_modules/@steipete/oracle/dist/src/browser/actions/navigation.js` (NextAuth access token → Bearer header on `/backend-api/me`). Patch clobbered on `npm i -g @steipete/oracle` — reapply after upgrade.
