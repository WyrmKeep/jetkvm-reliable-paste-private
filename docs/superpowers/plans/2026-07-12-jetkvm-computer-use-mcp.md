# JetKVM Computer-Use MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a release-grade MCP server that owns one browser/WebRTC JetKVM session, returns maximum-age single-use views, executes Codex-style action batches, and exposes deterministic Reliable Paste.

**Architecture:** A managed, sandboxed, ephemeral Chromium context is the sole WebRTC/video decoder. A serialized Go session manager atomically revokes the previous HID generation on takeover. Playwright uses ordinary video/pointer/keyboard paths; a stable route-lifetime `window.__jetkvmAutomationV1` facade supplies ownership, effective layout, physical text plans, deterministic paste lifecycle, and zero-state release. SDK adapters remain outside the controller.

**Tech Stack:** Go 1.25/Pion WebRTC, Node `>=22.23.1 <23` with exact 22.23.1 release gates, TypeScript 5.9 ESM/NodeNext, React 19/Zustand, `@modelcontextprotocol/sdk` 1.29.0, Zod 3, Playwright/Playwright Core 1.57, Vitest 4, jsdom/Testing Library, existing paste harness/Windows SSH rig, GitHub Actions.

**Canonical spec:** `docs/superpowers/specs/2026-07-12-jetkvm-computer-use-mcp-design.md`

---

## Locked file map

### Firmware/session safety

- Create `internal/controlsession/manager.go`, `manager_test.go`: ordinary leases plus manager-only maintenance `quiesceAndZero`.
- Modify `cloud.go`, `web.go`, `webrtc.go`, `hw.go`, `main.go`, `native.go`, `network.go`, `ota.go`, `serial.go`, `usb.go`, `video.go`: snapshots, takeover quiesce, maintenance-leased zero.
- Modify `hidrpc.go`, `jsonrpc.go`: every write leased; correlated quiesce command; cancel/join queued/in-flight work.
- Create root tests for both offers, callbacks, command receipts, blocked/queued/stale barriers and scoped close/candidates.

### Production UI automation boundary

- Create `ui/src/automation/bridge.ts`, `bridge.test.ts`: event/lifecycle/paste plus correlated firmware quiesce receipts.
- Create `ui/src/automation/inputGuard.ts`, `inputGuard.test.ts`: reusable exact capture guard.
- Create `ui/src/automation/controller.ts`, `controller.test.tsx`: capabilities, mandatory paste cancellation, firmware release, ownership.
- Create `ui/src/utils/pasteText.ts`, `pasteText.test.ts`: BOM/newline/NFC normalization.
- Modify `ui/src/hooks/useKeyboard.ts`, `useMouse.ts`, `useHidRpc.ts`, `useJsonRpc.ts`; add focused tests: propagate transport queue booleans/channel generation and quiesce emitters.
- Modify `ui/src/utils/hidRpcTransport.ts` and tests: finalize armed event receipt at actual send point.
- Modify `ui/src/components/WebRTCVideo.tsx`: cancel/join deferred emitters and capture-phase guard.
- Modify `ui/src/routes/devices.$id.tsx`: install facade once and set takeover before navigation.
- Modify `ui/vitest.config.ts`, `ui/package.json`/lock: include `.test.tsx` and exact jsdom/Testing Library dependencies.

### MCP package

- Create `tools/jetkvm-mcp/`: package/build/test configs, README, SECURITY, GPL licence, schemas, and scripts.
- Create `src/domain.ts`, `errors.ts`, `config.ts`, `deviceLease.ts`, `observability/logger.ts`.
- Create browser modules `auth.ts`, `geometry.ts`, `frames.ts`, `keys.ts`, `input.ts`, `paste.ts`, `browserPolicy.ts`.
- Create `OperationCoordinator.ts`, `BrowserController.ts`.
- Create MCP modules `mcp/schemas.ts`, `results.ts`, `server.ts`, `stdio.ts`, `streamableHttp.ts`; create `cli.ts`, `cli/doctor.ts`.
- Create focused tests beside modules and external real-controller fixture under `test-support/` outside production `src`.
- Create scripts `clean.mjs`, `with-device-lease.mjs`, `run-device-go-tests.mjs`, schema/package checks, and installed stdio/HTTP smokes.

### Harness/CI/release

- Create paste-harness `mcpUserStories.ts`, `mcpReleaseManifest.ts`, `mcpLease.ts` plus tests and CLI shims.
- Add exact MCP SDK dependency and explicit live/manifest scripts to paste-harness package/lock.
- Create `.github/workflows/jetkvm-mcp.yml` with hardware-free required jobs, pinned browser provisioning, self-hosted live concurrency.
- External ignored evidence directory: `tools/paste-harness/artifacts/mcp-v0.1.0-rc1/`; nothing inside is committed into the candidate tree.

---

# Phase A — Ownership and public contracts

## Task 1: Scaffold production-only package output and domain contracts

**Files:**
- Create `tools/jetkvm-mcp/package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Create `tools/jetkvm-mcp/.prettierignore`, `README.md`, `SECURITY.md`, `LICENSE`
- Create `tools/jetkvm-mcp/src/domain.ts`, `domain.test.ts`, `errors.ts`, `errors.test.ts`, `runtimePolicy.ts`, `runtimePolicy.test.ts`
- Create `tools/jetkvm-mcp/scripts/clean.mjs`
- Create `tools/jetkvm-mcp/src/deviceLease.ts`, `deviceLease.test.ts`
- Create `tools/jetkvm-mcp/scripts/with-device-lease.mjs`
- Modify `ui/.nvmrc`, `ui/package.json`, `ui/package-lock.json`, `tools/paste-harness/package.json`, `tools/paste-harness/package-lock.json`, `.devcontainer/{docker,podman}/devcontainer.json`, `DEVELOPMENT.md`

- [ ] **Write RED tests** for the exact five tool/domain result contracts, action union, `MutationOutcome`, stable codes, the invariant that `retryable:true` is impossible for `sent|unknown`, and runtime-policy boundaries around `>=22.23.1 <23`.
- [ ] **Write RED lease tests** for device-keyed atomic `open(...,"wx")`, owner/run/host/PID/time/token proof, second contender, matching inherited proof, signal/exception `finally`, and stale fail-closed administrative cleanup.

```ts
expect(makeFailure({ code: "ACTION_OUTCOME_UNKNOWN", outcome: "unknown" })).toMatchObject({
  ok: false,
  error: { retryable: false, effectsUnknown: true },
});
expect(isCoordinateAction({ type: "wait", ms: 1 })).toBe(false);
```

- [ ] **Create package/build configs and secure the repo runtime baseline.** Pin `.nvmrc`, devcontainers, docs and release CI to Node 22.23.1; set every affected package engine to `>=22.23.1 <23` and update locks. The MCP package and doctor reject runtimes outside that supported range, but do not reject later patched Node 22 releases. Pin SDK 1.29.0, Playwright Core 1.57.0, Zod 3.25.76; pin dev Playwright 1.57.0, TypeScript 5.9.3, Vitest 4.1.5, Prettier 3.7.4, and `@types/node` 22.20.1. `build` runs `node scripts/clean.mjs && tsc -p tsconfig.build.json`. Build config explicitly excludes `**/*.test.ts`, `src/test/**`, and `test-support/**`; package files allowlist only `dist`, schemas, README, SECURITY, LICENSE.

- [ ] **Run RED:** install, then focused domain/error/runtime-policy/device-lease tests must fail on missing exports/behavior.

- [ ] **Implement minimal contracts, pure runtime assertion, and shared lease wrapper.** The runtime assertion accepts an injected version for tests and has no side effects. `npm run device-lease:run -- --device-key <key> -- <command...>` holds the lease across the child process and releases on every exit; it never logs proof token.

- [ ] **Run GREEN:** focused domain/error/runtime-policy/device-lease tests, `npm run typecheck`, `npm run build`, then unpack `npm pack` and confirm no test/fixture file in `dist`.

- [ ] **Commit:** `feat(mcp): define production computer-use contracts`.

## Task 2: Make takeover an atomic server-side revocation

**Files:**
- Create `internal/controlsession/manager.go`, `manager_test.go`
- Modify `cloud.go`, `web.go`, `webrtc.go`, `hw.go`, `main.go`, `native.go`, `network.go`, `ota.go`, `serial.go`, `usb.go`, `video.go`, `hidrpc.go`, `jsonrpc.go`
- Create `session_manager_test.go`; modify `jsonrpc_test.go`
- Create `tools/jetkvm-mcp/scripts/run-device-go-tests.mjs`, `run-device-go-tests.test.mjs`

- [ ] **Write RED pure race tests** for `quiesceAndZero`: maintenance handler is outside ordinary wait-group (no self-join), draining rejects work, blocked/queued workers join, ordinary count zero, only maintenance lease writes final zero, correlated acks, stale generation no write, zero post-zero.

- [ ] **Run host-runnable RED:** `go test -race ./internal/controlsession`; no native/cgo dependency.

- [ ] **Write root integration RED tests** for wire `quiesceAndZero(operationId)`: handler injects originating Session manager generation; receipt returns operation+generation; old channel after replacement gets stale/no-write. Also cover offers/callbacks, macro/paste, blocked writer, zero steps, takeover, candidates/close.

- [ ] **Implement manager/integrations.** Command handler holds no ordinary lease and is excluded from the workers it joins. Every gadget write holds current ordinary or manager-only maintenance lease; takeover/emergency share quiesce; snapshots/ICE/close stay scoped.

- [ ] **Audit direct pointer use:** repository search for `currentSession` must leave only manager-backed read helpers; no direct assignment outside manager.

- [ ] **Run GREEN under one lease:** `device-lease:run` launches `run-device-go-tests.mjs`; that single child reads pre-revision/app identity, runs `dev_deploy.sh ... --run-go-tests-only`, reads post-identity, compares and flushes its artifact before exit. Lease releases only after child completes. RED-test sequencing/failure with injected fetch/spawn.

- [ ] **Commit:** `fix(webrtc): revoke stale HID sessions atomically`.

## Task 3: Implement fail-closed config, auth, browser policy, and redaction

**Files:**
- Create `tools/jetkvm-mcp/src/config.ts`, `config.test.ts`
- Create `tools/jetkvm-mcp/src/browser/auth.ts`, `auth.test.ts`, `browserPolicy.ts`, `browserPolicy.test.ts`
- Create `tools/jetkvm-mcp/src/observability/logger.ts`, `logger.test.ts`

- [ ] **Write RED tests** for fixed URL, password-file precedence/conflict, setup-only status, noPassword/401, 429 retry-after, cookie extraction, layout, 30-second view age, browser allowlist/sandbox/scrubbed env, encoded secret/SDP/ICE/paste data, and screenshot bytes absent from config/auth/logger/error serialization. Image-block authorization starts in Task 10.

- [ ] **Run RED** with the four focused test files.

- [ ] **Implement config/auth/policy.** Credentials are opaque/disposable and cannot serialize. Browser resolution accepts explicit configured approved path or matching pinned Playwright-managed installation only. Launch policy uses ephemeral context, `chromiumSandbox:true` where supported, no persistent profile/download/record/trace/extension, and an environment allowlist excluding all device/MCP secrets.

- [ ] **Run GREEN:** focused tests and typecheck.

- [ ] **Commit:** `feat(mcp): add secure device and browser policy`.

## Task 4: Build bridge registry, normalization, and keyboard lifecycle seams

**Files:**
- Create `ui/src/automation/bridge.ts`, `bridge.test.ts`
- Create `ui/src/utils/pasteText.ts`, `pasteText.test.ts`
- Modify `ui/src/hooks/useKeyboard.ts`
- Create `ui/src/hooks/useKeyboard.test.ts`

- [ ] **Write RED tests** for contract version, monotonic lifecycle/paste sequences, bounded progress coalescing, terminal retention, typed `EVENT_GAP`, per-method unmounted errors, channel-generation reset, and operation mismatch.

- [ ] **Write normalization RED tests**: one BOM stripped; CRLF/lone CR -> LF; NFC; original/normalized UTF-8 byte counts/hashes; exact progress prefix bytes.

- [ ] **Write keyboard RED tests** for `completedSourceChars/totalSourceChars`, capability reset on data-channel replacement, paste failure sequence, zero-state reset, and no change to current batch/flow-control behavior.

- [ ] **Run RED:** focused UI Vitest files.

- [ ] **Implement pure bridge registry/normalizer and minimal hook seams.** Registry never stores paste text. Terminal event cannot be evicted before acknowledgement; old sequence returns `EVENT_GAP`.

- [ ] **Run GREEN:** focused tests, UI typecheck, touched-file ESLint.

- [ ] **Commit:** `feat(ui): define deterministic automation lifecycle`.

## Task 5: Install one stable route facade with layout, paste, release, and takeover

**Files:**
- Create `ui/src/automation/controller.ts`, `controller.test.tsx`
- Create `ui/src/automation/inputGuard.ts`, `inputGuard.test.ts`
- Modify `ui/src/components/WebRTCVideo.tsx`
- Modify `ui/src/hooks/useKeyboard.ts`, `useMouse.ts`, `useHidRpc.ts`, `useJsonRpc.ts`
- Modify `ui/src/utils/hidRpcTransport.ts`
- Modify `ui/src/routes/devices.$id.tsx`
- Modify `ui/vitest.config.ts`, `ui/package.json`, `package-lock.json`

- [ ] Add exact `jsdom@29.1.1` and `@testing-library/react@16.3.2`; update Vitest include to `src/**/*.{test,spec}.{ts,tsx}` while retaining per-file jsdom directive. CI must assert `controller.test.tsx` appears in the executed file list.

- [ ] **Write RED lifecycle tests**: not-ready->ready, rerenders, StrictMode, callback replacement, layout change, active paste rerender, true unmount, no successful no-op.

- [ ] **Write RED capability/input tests:** probe layout/capability, physical plans, absolute/zero-throttle, and one-shot arm. Capture-blocked, handler-not-queued, and transport-send receipts are distinct; only transport `queued:true` includes current channel generation and crosses first dispatch.

- [ ] **Write RED transport barrier tests:** admit capture, then close/replace HID or JSON-RPC channel before product handler send for pointer/wheel/key. Queue boolean propagates through transport/hooks; no dispatch is reported and the old arm cannot send on the replacement channel.

- [ ] **Write RED product-event tests:** replace the `mousemove` consumer with the same `pointermove` event guarded by automation and run real Playwright stale move/drag barriers proving zero HID. For admitted automation keys, suppress human-browser-loss timers (Meta associated-key 10 ms, Meta release 100 ms, Windows Ctrl/AltGr 3 ms); successful Meta+R and AltGr sequences emit only armed transport-receipted events and nothing after completion.

- [ ] **Write RED quiescence tests:** join UI emitters, always cancel paste, send only `quiesceAndZero(operationId)`. Receipt must return matching operation and server generation plus all step acks. Assert browser `channelGeneration` is never supplied/compared as firmware generation; old channel receipt is stale/no-write.

- [ ] **Write RED takeover test:** ownership precedes navigation; stale firmware receipt is rejected.

- [ ] Implement one route-lifetime facade with live refs. Bridge release always delegates final zero to the correlated firmware command; keep E2E hooks separate.

- [ ] **Run GREEN:** explicitly observe `controller.test.tsx` plus all automation/hook tests, typecheck, touched ESLint.

- [ ] **Commit:** `feat(ui): expose stable JetKVM automation facade`.

## Checker Gate A — Contracts, ownership, and UI lifecycle

- [ ] Dispatch independent architecture and evidence reviewers distinct from makers.
- [ ] Review exact five tools/non-goals, atomic server revocation/candidate scoping, bridge boundedness/stability, layout/capability bootstrap, pointer mode, normalization, release command, auth side effects, and Go/UI tests.
- [ ] Maker agents fix every blocker/major; rerun focused and phase-wide Go/UI/package gates.
- [ ] An independent checker verifies the corrected diff. Phase B cannot start before `APPROVE`.
- [ ] Commit any remediation as `fix(mcp): resolve contract checker findings`.

---

# Phase B — Views, actions, paste, controller, transports

## Task 6: Implement fresh frames and maximum-age single-use views

**Files:**
- Create `tools/jetkvm-mcp/src/browser/geometry.ts`, `geometry.test.ts`
- Create `tools/jetkvm-mcp/src/browser/frames.ts`, `frames.test.ts`

- [ ] **Write RED geometry tests** for image/native/render mapping, letter/pillarboxing, bounds, immutable geometry fingerprint, absolute-mode requirement, and display-generation changes.

- [ ] **Write RED view tests** for post-request `requestVideoFrameCallback` advance, frozen `VIDEO_STALLED`, JPEG/PNG/no crop/no upscale/2 MiB, monotonic 30-second age, atomic reservation, release when `not_sent`, consumption at first dispatch, reuse rejection after sent/unknown, and display changes before/between events.

- [ ] **Run RED**, implement bounded server-side view registry plus browser observers (`loadedmetadata`, resize/source/route/navigation/content rectangle) that monotonically update display generation.

- [ ] **Run GREEN:** focused tests/typecheck.

- [ ] **Commit:** `feat(mcp): bind actions to fresh single-use views`.

## Task 7: Implement physical key plans, action dispatch generation, and release quiescence

**Files:**
- Create `tools/jetkvm-mcp/src/browser/keys.ts`, `keys.test.ts`
- Create `tools/jetkvm-mcp/src/browser/input.ts`, `input.test.ts`
- Create `tools/jetkvm-mcp/src/OperationCoordinator.ts`, `OperationCoordinator.test.ts`

- [ ] **Write RED key tests** for Codex aliases, bridge-resolved physical plans, modifier-first/reverse-release, uppercase/punctuation/dead/non-US sequences, duplicates/unsupported keys, and whole-batch prevalidation.

- [ ] **Write RED action tests** for click/double/move/drag every point, vertical chunks, horizontal zero-only, waits, modifiers, and pre/post dispatch outcomes.

- [ ] **Write RED event-guard races:** for each pointer/wheel/key class, test display/dispatch mismatch before capture, handler no-op after admission, and channel close/replacement between admission and transport send. Only `queued:true` consumes the view/counts dispatch; no event can migrate to a replacement channel.

- [ ] **Write RED coordinator/release tests** for mandatory paste cancel and session-bound wire quiesce. Node sends only operation ID; validates returned operation/server generation and steps. Cover queues, blocked writers, timeout/stale unknown, zero post-zero; gate remains closed.

- [ ] **Run RED**, then implement arm/event/receipt dispatch and the bounded bridge-to-firmware release path. Never use browser text insertion.

- [ ] **Run GREEN:** focused tests/typecheck.

- [ ] **Commit:** `feat(mcp): execute race-safe physical input actions`.

## Task 8: Implement deterministic paste client and progress

**Files:**
- Create `tools/jetkvm-mcp/src/browser/paste.ts`, `paste.test.ts`

- [ ] **Write RED tests** for exact contract/version, current channel/layout/capability ready, normalized size/hash, monotonic <=4 Hz byte progress, active required, event gap, missing/duplicate/out-of-order terminal, terminal retention, capability downgrade, cancellation inactive acknowledgement, and timeout/disconnect/unmount after acceptance.

- [ ] **Run RED**, implement server operation ID, view reservation/consumption at acceptance, one bridge start call, sequence polling, per-method result handling, and mutation-gate lock for every uncertain accepted operation.

- [ ] **Run GREEN:** focused tests/typecheck.

- [ ] **Commit:** `feat(mcp): correlate reliable paste lifecycle`.

## Task 9: Compose BrowserController lifecycle and takeover

**Files:**
- Create `tools/jetkvm-mcp/src/BrowserController.ts`, `BrowserController.test.ts`

- [ ] **Write RED tests** for lazy explicit claim, unclaimed status, auth/browser/context/page readiness, exact facade version, epoch/generation increments, current browser/layout/pointer checks, synchronous takeover abort/no reclaim, view/paste/action/release composition, shutdown quiescence, and secret disposal.

- [ ] **Run RED**, implement one approved Chromium process/context/page. Use LAN ICE flags already proven by product path without disabling sandbox. Observe explicit lifecycle event rather than delayed URL polling.

- [ ] **Run GREEN:** controller tests/typecheck.

- [ ] **Commit:** `feat(mcp): compose single-session browser controller`.

## Task 10: Register exact five tools and stdio

**Files:**
- Create `tools/jetkvm-mcp/src/mcp/schemas.ts`, `results.ts`, `server.ts`, `server.test.ts`, `stdio.ts`
- Create `tools/jetkvm-mcp/src/cli.ts`

- [ ] **Write RED schema inventory tests:** exact five names, strict roots/bounds, `scroll_x:0`, no screenshot-none, and strict-empty `computer_release_input`.

- [ ] **Write RED MCP result tests:** screenshot bytes decode/hash exactly in the sole `content[type="image"].data` field; structuredContent, JSON text, errors, logs and other content contain no identical payload. Cover all success/error/progress/abort paths.

- [ ] **Write RED CLI startup tests:** a test seam supplies below-floor, supported-later-22, and next-major versions; every mode (`stdio`, `serve`, `doctor`) invokes the same runtime assertion before argument dispatch, transport construction, output, or device signaling.

- [ ] **Run RED**, implement the first-instruction CLI runtime assertion, SDK registration and field-aware result mapping; stdout remains transport-only.

- [ ] **Run GREEN:** MCP tests/typecheck/build.

- [ ] **Commit:** `feat(mcp): expose five computer-use tools`.

## Task 11: Add secured Streamable HTTP and doctor

**Files:**
- Modify `tools/jetkvm-mcp/src/deviceLease.ts`, `deviceLease.test.ts`
- Create `tools/jetkvm-mcp/src/mcp/streamableHttp.ts`, `streamableHttp.test.ts`
- Create `tools/jetkvm-mcp/src/cli/doctor.ts`, `doctor.test.ts`
- Modify `tools/jetkvm-mcp/src/cli.ts`
- Modify `tools/jetkvm-mcp/src/BrowserController.ts`, `BrowserController.test.ts`

- [ ] **Write RED HTTP transfer tests:** fake-clock expiry/disconnect/release during long operations; contender stays busy through abort/quiesce/close. Then B receives a new BrowserController/WebRTC/firmware generation, every A view fails, B must screenshot, and B can mutate. Include owner-only release, cross-view, bind/path/Origin/auth limits and bearer/lease-token redaction.

- [ ] **Write RED doctor/lease tests:** offline zero signaling; destructive claim requires lease proof and never echoes token; doctor reuses the shared runtime assertion and reports the accepted version.

- [ ] Implement HTTP leases so ownership never transfers a drained controller: close A after quiescence, instantiate B fresh, require fresh view. Implement shared device proof and doctor modes; no mode owns a separate runtime guard.

- [ ] **Run GREEN:** focused tests, full typecheck/build.

- [ ] **Commit:** `feat(mcp): secure HTTP transport and diagnostics`.

## Checker Gate B — Races, views, release, transport, browser

- [ ] Independent reviewers inspect controller races/outcomes, per-event generations, view age/reservation/consumption, paste gaps, release quiescence/acknowledgement, five schemas, HTTP security, browser sandbox/env/compatibility, and doctor.
- [ ] Fix all blocker/major findings with maker agents; rerun phase-wide package/Go/UI gates.
- [ ] Independent recheck must return `APPROVE` before packaging/evidence.
- [ ] Commit remediation as `fix(mcp): resolve controller checker findings`.

---

# Phase C — Real adapter, production artifact, docs, harness, CI

## Task 12: Exercise real BrowserController with pinned Chromium fixture

**Files:**
- Create `tools/jetkvm-mcp/test-support/uiFixture.ts`, `uiFixture.test.ts`, `BrowserController.adapter.test.ts`

- [ ] **Provision exact browser locally/CI:** `npx playwright install chromium`; on Linux CI use `npx playwright install --with-deps chromium`. Pass resolved executable to tests and record `browser.version()`.

- [ ] **Build fixture RED-first** and import the exact `ui/src/automation/inputGuard.ts`. Real Playwright stale move/drag must emit zero pointer ledger events; normal pointermove emits once. Also cover video/geometry/channel close, handler-noop, layout, paste/release, unmount and takeover.


- [ ] **Run real BrowserController/MCP through fixture** and map every reachable stable error code. Fixture is external test support, never compiled into `dist`.

- [ ] **Run GREEN:** adapter tests plus production build. Inspect `dist` for zero test/fixture imports.

- [ ] **Commit:** `test(mcp): exercise pinned real browser adapter`.

## Task 13: Harden pack, schemas, installed smoke, and secret scan

**Files:**
- Create `tools/jetkvm-mcp/scripts/generate-schemas.mjs`, `check-schemas.mjs`, `check-package.mjs`, `installed-smoke.mjs`, `installed-http-smoke.mjs`
- Create tracked `tools/jetkvm-mcp/schemas/*.json`
- Modify `tools/jetkvm-mcp/package.json`

- [ ] **Write RED script tests** for complete schema file-set/byte comparison using a temporary output directory, production tar allowlist beneath `dist`, absence of tests/fixtures/Vitest/test server/fixture switch/secret source maps, and deterministic pack.

- [ ] **Write RED installed smokes:** stdio and HTTP entry points refuse below-floor/next-major runtime seams before transport/device setup, accept a later patched Node 22 seam, and run release success under exact Node 22.23.1; also cover security/lease behavior and screenshot success whose exact bytes/hash appear only in the authorised image block.

- [ ] **Use field-aware scanners:** exclude only `content[type="image"].data` after decode/hash validation; require the same screenshot payload absent from structured/JSON/errors/logs/stderr/doctor/reports/proofs/schemas/tar. Continue encoded secret and SDP/ICE/paste scans everywhere.

- [ ] **Run RED**, then implement scripts/schemas and package commands: `schemas:check`, `package:check`, `smoke:installed`, `smoke:http`. Schema check fails on missing/untracked/changed files.

- [ ] **Run GREEN:** format/type/unit/adapter/build, then exact `npm run package:check`, `npm run smoke:installed`, `npm run smoke:http`, `npm run schemas:check`.

- [ ] **Commit:** `test(mcp): validate exact production artifact`.

## Task 14: Finalize packed documentation and compatibility

**Files:**
- Finalize `tools/jetkvm-mcp/README.md`, `SECURITY.md`, `LICENSE`
- Modify root `README.md` with concise MCP pointer

- [ ] Document five-minute stdio setup, password file, explicit claim, Codex/Claude configs, Node `>=22.23.1 <23` support with exact 22.23.1 release baseline, pinned browser install, doctor, exact tools.
- [ ] Document coordinates/single-use age, physical layout typing, vertical-only scroll, focus precondition, dispatch-vs-acceptance, normalization, paste completion-vs-byte verification, takeover/revocation, unknown effects, release.
- [ ] Document HTTP security, browser/sandbox/H.264 matrix, firmware/UI contract, target layout/app profiles, privacy, troubleshooting, rollback.
- [ ] Execute every command against installed tarball/fixture; rerun pack allowlist and format.
- [ ] **Commit:** `docs(mcp): finalize setup safety and compatibility`.

## Task 15: Extend harness with atomic lease, stories, and external manifest validator

**Files:**
- Create `tools/paste-harness/src/mcpLease.ts`, `mcpLease.test.ts`
- Create `tools/paste-harness/src/mcpReleaseManifest.ts`, `mcpReleaseManifest.test.ts`
- Create `tools/paste-harness/src/mcpUserStories.ts`, `mcpUserStories.test.ts`
- Create CLI/shims `src/cli/mcp-user-stories.ts`, `src/cli/mcp-manifest-lint.ts`, `mcp-user-stories.js`, `mcp-manifest-lint.js`
- Modify `tools/paste-harness/package.json`, lockfile
- [ ] Use the MCP package's documented device-lease path/owner-token format so `doctor --claim-session` validates the inherited proof without reacquiring; reject mismatched token/path.

- [ ] Add exact runtime dependency `@modelcontextprotocol/sdk:1.29.0` and scripts `mcp:stories`, `mcp:manifest:lint`; manifest schema and runner require exact Node 22.23.1 identity.

- [ ] **Write RED lease tests:** atomic acquire/hold/finally/contender/stale behavior; proof token is accepted only from matching path+owner and never reaches logs/evidence.

- [ ] **Write RED manifest tests:** exact candidate identities, zero skips and artifact hashes; no payload, MCP bearer, or lease token in any encoded form.
- [ ] Assert the harness never persists image bytes; it stores only frame hashes/dimensions and verifies the MCP image in memory.

- [ ] **Write RED orchestration tests** for all spec stories/guards and enforce that SSH prepares/reads only, never performs tested input.

- [ ] Implement runner using SDK `StdioClientTransport` against exact installed tarball; evidence path fixed under ignored `artifacts/mcp-v0.1.0-rc1/`.

- [ ] **Run GREEN:** harness tests/typecheck and standalone manifest-lint fixture.

- [ ] **Commit:** `test(mcp): add atomic live evidence harness`.

## Task 16: Add required CI after all hardware-free commands exist

**Files:**
- Create `.github/workflows/jetkvm-mcp.yml`
- Modify `.github/workflows/build.yml`, `.github/workflows/ui-lint.yml`

- [ ] Required PR/push jobs:
  - every Node job in all three workflows uses `actions/setup-node` with exact `22.23.1` and immediately fails unless `node --version` is `v22.23.1`;
  - pure host-runnable `go test -race ./internal/controlsession`, then repository native build/root compile gate (never execute cross-built ARM archives on amd64);
  - UI `npm ci`, automation/hook tests including an asserted executed `controller.test.tsx`, typecheck, touched ESLint;
  - MCP `npm ci`, pinned browser+deps, format/type/unit/adapter/build, then exact `package:check`, `smoke:installed`, `smoke:http`, `schemas:check`;
  - paste harness `npm ci`, MCP lease/manifest/story tests, typecheck, standalone manifest linter fixture.

- [ ] Trigger on every depended source/lock/config/spec/plan/workflow path. Public jobs get no hardware secrets and do not discover live tests.

- [ ] Manual approved self-hosted live job uses device-keyed `concurrency` and `cancel-in-progress:false`, calls only explicit `mcp:stories`, and verifies allowlisted hosts/atomic lease.

- [ ] Validate workflow YAML and run all equivalent local hardware-free commands.

- [ ] **Commit:** `ci(mcp): require complete package and harness gates`.

## Checker Gate C — Artifact, CI, and evidence readiness

- [ ] Independent artifact/security/evidence reviewers inspect clean build exclusions, unpacked tar allowlist, installed smoke, browser provisioning, sentinel scan, schema full-set comparison, docs, harness dependency/atomic lease/manifest linter, CI triggers/concurrency, and complete live matrix.
- [ ] Fix all blocker/major findings; rerun every hardware-free gate; independent recheck returns `APPROVE`.
- [ ] Commit remediation as `fix(mcp): resolve release-readiness findings`.

---

# Phase D — Frozen candidate, live evidence, PR, release

## Task 17: Freeze candidate, run live matrix, and release

**External artifacts:** `tools/paste-harness/artifacts/mcp-v0.1.0-rc1/` (ignored, uploaded to PR/release; never committed)

- [ ] **Freeze candidate `C/G/T`:** ensure all code, schemas, docs, licence, metadata, workflow, harness are committed. Record PR-head commit C, git tree G, package-tree hash, lock hash; clean-build tarball T once and SHA-256 it. No branch changes after this point.

- [ ] **Run all hardware-free gates** and manifest schema preflight against C/T.

- [ ] Push unchanged C and open a draft PR containing architecture, five schemas, safety/security, checker gates, C/G/T, planned live matrix, non-goals and rollback. Run and require all hardware-free Actions for C before touching the device.

- [ ] **Before any device read or mutation, acquire the device lease** and enter one outer `try/finally`; pass the same inherited proof to every child process below.

- [ ] Inside the lease, persistently deploy full candidate: `./dev_deploy.sh -r 192.168.1.110 -i`; after reboot verify revision `C`, local `C^{tree}=G`, running binary SHA, auto-update off, UI contract 1.

- [ ] From exact T, run session-destructive `doctor --claim-session` with the inherited lease proof. Record exact Node 22.23.1 identity, executable path/hash/version, sandbox, frame callback/H.264 advance, LAN ICE, facade/layout/pointer, WebRTC/HID/video and proof acceptance in the manifest.

- [ ] Run exact-T live HTTP transfer: A claims and screenshots; B is `CONTROL_BUSY`; A disconnect/release quiesces and closes its controller; B claims a fresh browser/WebRTC generation, A view is rejected, B takes a fresh screenshot and successfully performs a harmless mutation.

- [ ] Run live view/input matrix: host nonces, frozen frame, max-age/reuse, display changes before/between events, click/double/move/drag/vertical, horizontal zero, physical layout characters, release races, no stuck state/replay. Live channel close is only before event or after queued; admission-to-send remains Task12 fixture evidence.

- [ ] Run paste matrix: 1 B, 1/8/32 KiB, configured maximum; reliable/fast; prose/JSON/TS/PowerShell/Markdown/punctuation/supported Unicode; BOM/CRLF/lone-CR/NFC; cold/warm. Record original/normalized bytes/hashes, actual hash, first mismatch, lifecycle/queue state.

- [ ] Emergency release always cancels paste and leaves generation drained; explicitly restart/reclaim and take a fresh screenshot before later mutation.

- [ ] Run cancel/disconnect/takeover and host ground-truth rows; record hashes/counts/mismatch and zero replay/post-zero HID.

- [ ] Still inside the lease, lint/flush the immutable manifest/report/artifacts and perform final device reads. Require zero skips, exact C/G/T/browser/device identities, resolvable hashes, and no persisted screenshot/secret/payload.

- [ ] In the single outer `finally`, shut down children, perform safe cleanup, then release the lease. Never deploy/read/flush outside it.

- [ ] Upload immutable manifest/report/artifacts to that draft PR check/CI store, then update PR metadata with actual device/browser identities and evidence link. Do not commit or modify C.


### Final checker and release

- [ ] Independent final whole-diff/evidence/security review of exact C/G/T and PR artifact; any fix creates a new candidate and reruns affected gates.

- [ ] Confirm required Actions remain green, no blocker/major remains, finalize PR body, mark ready, and obtain required approval.

- [ ] Merge with a method that preserves C as an ancestor and produces a main tree equal to G. If conflicts or any source/tree/package/lock change occur, stop, create new C/G/T, and rerun affected live evidence. Never silently build another tarball.

- [ ] Tag C itself `jetkvm-mcp-v0.1.0`.

- [ ] Create GitHub release attaching exact T, checksum, generated schemas, compatibility/setup/rollback, SBOM if produced, and external immutable manifest. Notes distinguish dispatch/queue completion from host-byte verification.

- [ ] Clean-room release verification: under exact Node 22.23.1, download T/checksum, install empty directory, initialize/list over stdio and loopback `serve`, run default offline doctor (zero device signaling), and confirm tag/package/manifest C/G/T/runtime identities.

---

## Plan self-review

- Every spec tool/option/invariant has a task and evidence row.
- Atomic takeover, session-scoped ICE, revoked queued HID, and release quiescence are implemented before controller claims.
- The bridge is stable across rerenders, resets capability/layout per channel, resolves physical text, retains terminal events, and exposes zero-state release.
- Views are maximum-age, reserved, consumed on dispatch, and generation-checked before every event.
- Production build excludes tests/fixture; browser is pinned/provisioned/sandboxed; schemas compare full sets.
- Harness has exact SDK dependency, atomic lease, executable manifest linter, and required CI.
- All packed docs precede candidate freeze.
- Manifest is external; candidate C/G/T is never modified after live testing.
- Checker Gates A/B/C and final review precede dependent evidence.
- No production clear/focus/OCR/SSH action option, horizontal scroll, best-effort paste completion, hidden retry, placeholder, skipped acceptance row, or unowned file remains.
