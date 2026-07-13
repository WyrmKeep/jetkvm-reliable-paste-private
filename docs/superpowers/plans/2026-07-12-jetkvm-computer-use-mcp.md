# JetKVM MCP v0.1 Six-Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public-first JetKVM MCP v0.1 with explicit device sessions, ten strict typed tools, browser/WebRTC input and frame control, native read-only display status and semantic ATX control, stdio plus legacy HTTP/SSE, complete fake/replay branch coverage, story-driven E2E evidence, stranger-ready documentation, and a reproducible semver release.

**Architecture:** The MCP facade owns public schemas, operator-supplied target/auth configuration, explicit device-session ownership, bounded timeouts, idempotency, result/error envelopes, and MCP transports. `BrowserPlane` owns live frame capture, mouse, physical keyboard, reliable paste, and input release through the product browser/WebRTC path. `NativeControlPlane` supplies individually qualified native observations and serialized fixed semantic ATX actions; `SessionService` composes public health/status and reconnect from explicit browser, channel, native-operation, and freshness signals. Device sessions are application state and never inherit ownership semantics from stdio or SSE transport sessions.

**Tech Stack:** Go 1.25 and the existing generation-scoped `internal/controlsession` manager; Node `>=22.23.1 <23` with exact Node 22.23.1 release evidence; TypeScript 5.9 ESM/NodeNext; `@modelcontextprotocol/sdk` 1.29.0; Zod 3; Playwright/Playwright Core 1.57; Vitest 4; the existing React 19/Zustand UI and paste harness; GitHub Actions.

**Canonical design:** `docs/superpowers/specs/2026-07-12-jetkvm-computer-use-mcp-design.md`

---

## 0. Locked decisions and execution protocol

### 0.1 Advice and divergence log

The canonical design and this plan are the durable advice log. Before any architecture or public-API decision in any phase, the orchestrator must read the current design, this section, and the completed Oracle consultations `jetkvm-expanded-api-advisor` and `jetkvm-expanded-security-test-advisor`. Record the adopted decision, rejected alternatives, reason, test consequence, and release consequence in the phase PR body before implementation. If a new issue is not covered, obtain advisor review before choosing an architecture or API; implementation does not begin while an architecture/API decision is unresolved.

The final authority is the superseding product brief and these locked decisions:

1. Preserve completed or in-flight foundation safety: Node/package/runtime policy, domain/error/lease/supervisor work, and the Go generation-scoped quiesce manager.
2. Replace the prior public `computer_*` design. No Phase 1 work may add handlers for that obsolete catalogue.
3. v0.1 ships exactly stdio and legacy HTTP/SSE. Streamable HTTP is deliberately deferred rather than becoming a third transport. Keep transport adapters replaceable.
4. Device sessions are independent of MCP transport sessions. `jetkvm_session_connect` never steals ownership unless the caller explicitly sets `takeover: true`.
5. A device URL and credentials are operator configuration, never tool arguments. LAN URLs, Tailscale names/URLs, and HTTPS reverse-proxy URLs are valid. Plain HTTP requires an explicit insecure opt-in. No lab IP, URL shape, credential, or auth method is hard-coded or required, and the model never chooses or receives them.
6. `BrowserPlane` owns frame, mouse, physical keyboard, nominally ~91 source-char/s reliable paste, and release.
7. `NativeControlPlane` owns qualified read-only resolution/EDID observations and serialized ATX. `SessionService`, not either plane alone, owns the composed health/status/reconnect contract. EDID mutation is not part of v0.1.
8. `jetkvm_power_control` accepts only `press_power`, `hold_power`, and `press_reset`, mapped to the existing fixed 200 ms, 5 s, and 200 ms native press/release actions. It accepts no arbitrary duration or GPIO timing.
9. Virtual media is absent from the product, API, tests, stories, documentation, capability inventory, and release claims.
10. Every public input root is strict and typed; every tool has an explicit bounded `timeout_ms`; every business failure is actionable and structured; no handler reports a silent no-op or partial success.

### 0.2 Exact public catalogue

The production tool inventory is exactly the following ten names. Inventory tests compare the complete sorted set, generated schemas, packed schemas, `tools/list`, README tables, examples, and story references byte-for-byte where applicable.

| Tool | Plane | Class | Implementation phase |
|---|---|---|---|
| `jetkvm_session_connect` | Session service + both planes | ownership mutation | Phase 4 |
| `jetkvm_session_status` | Session service + both planes | read | Phase 4 |
| `jetkvm_session_reconnect` | Session service + both planes | lifecycle mutation | Phase 4 |
| `jetkvm_display_capture` | BrowserPlane | read, returns fresh observation | Phase 3 |
| `jetkvm_display_status` | NativeControlPlane | read-only resolution/EDID | Phase 3 |
| `jetkvm_input_mouse` | BrowserPlane | mutation | Phase 3 |
| `jetkvm_input_keyboard` | BrowserPlane | mutation | Phase 3 |
| `jetkvm_input_paste` | BrowserPlane | mutation | Phase 3 |
| `jetkvm_input_release` | BrowserPlane + Go quiesce | idempotent safety mutation | Phase 3 |
| `jetkvm_power_control` | NativeControlPlane | mutation | Phase 4 |

No alias, compatibility name, hidden production tool, experimental tool, or catch-all action tool is registered.

### 0.3 Shared public contracts

Phase 2 copies and freezes the canonical design §8/§9 contracts before handler implementation. Every root is strict; every listed field is required unless marked optional; every `timeout_ms` is required and bounded exactly as §9 specifies.

```ts
type Success<T> = {
  ok: true;
  tool: JetKvmToolName;
  operation_id: string;
  session_id: string | null;
  session_generation: number | null;
  duration_ms: number;
  result: T;
};

type MutationState = {
  request_id: string;
  outcome: "applied" | "already_applied" | "not_sent" | "unknown";
  verification: "device_state_verified" | "device_ack_only" | "none";
  safe_to_retry: boolean;
  required_next_step:
    | "none"
    | "capture_then_retry"
    | "reconnect_then_capture"
    | "release_then_reconnect_then_capture"
    | "inspect_device_state_before_retry"
    | "wait_or_request_takeover"
    | "grant_permission"
    | "enable_capability";
};

type ToolError = {
  ok: false;
  tool: JetKvmToolName;
  operation_id: string;
  session_id: string | null;
  session_generation: number | null;
  duration_ms: number;
  error: {
    code: ErrorCode;
    message: string;
    phase: "validate" | "authorize" | "queue" | "connect" | "execute" | "verify" | "cleanup";
    outcome: "applied" | "already_applied" | "not_sent" | "unknown" | null;
    verification: "device_state_verified" | "device_ack_only" | "none";
    safe_to_retry: boolean;
    required_next_step: MutationState["required_next_step"];
    details: {
      permission: PermissionName | null;
      capability: keyof CapabilitySnapshot | null;
      failed_action_index: number | null;
      dispatched_action_count: number | null;
      completed_action_count: number | null;
      downstream_stage: "none" | "admission" | "write" | "acknowledgement" | "verification";
      expected_generation: number | null;
      actual_generation: number | null;
      observation_id: string | null;
    };
  };
};
```

- Every mutation has one caller key, `request_id`. The lookup scope is `{session_id, session_generation, tool, request_id}` and the stored entry contains the normalized-input digest; connect uses `{authenticated principal, configured device, tool, request_id}` before a session exists. There is no second idempotency key.
- Same request ID/digest returns `already_applied` only when the stored result proves the original applied; original `not_sent` returns the original result; unknown remains unknown. Same request ID with different input returns `REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT`. No branch performs a second write.
- A definitive correlated acknowledgement followed by failed/unavailable post-read remains `applied` with `device_ack_only`; persist it and never replay. Only a write without definitive acknowledgement is `unknown`.
- Actionable business errors use `isError:true` and put the same mapped object in structured content and compact JSON text. Malformed MCP messages, unknown tools, schema-invalid calls, and broken server dispatch remain protocol errors.
- Target URL, credentials, cookies, TLS policy, browser path, and server bearer credentials are process configuration only and never appear in tool input, output, logs, evidence, or model-visible errors.
- Input mutations require current `session_id` and `session_generation`; mouse, keyboard, and paste also require a fresh observation from capture. Release does not require an observation.
- Connect is exactly:

```ts
type SessionConnectInput = {
  request_id: string;
  takeover?: boolean; // default false
  timeout_ms: number; // required, 100..60000
};

type SessionConnectResult = MutationState & {
  state: "ready";
  connection_epoch: number;
  display_generation: number;
  takeover_performed: boolean;
  fresh_capture_required: true;
  permissions: PermissionName[];
  capabilities: CapabilitySnapshot;
};
```

The common success envelope supplies the newly issued `session_id` and `session_generation`. Connect accepts no mode, lease shape, target, URL, or credentials. A transport disconnect does not transfer the session. A conflicting connect returns `CONTROL_BUSY`; only explicit authorized takeover revokes the incumbent. Reconnect preserves logical ownership, publishes a new generation, invalidates old observations, and requires fresh capture.
### 0.4 Sole behavioral branch matrix inventory

Canonical design §11.2 is the only behavior-ID inventory. The plan, manifest, focused tests, generated matrix, docs, and evidence use these exact rows and do not define a second branch taxonomy.

| Branch | Required assertion |
|---|---|
| strict schema rejection | no controller/plane call |
| permission denied | actionable `PERMISSION_DENIED`, no capability disclosure, no write |
| capability missing | actionable `CAPABILITY_MISSING`, no mutation |
| deadline before admission | `not_sent`, queue/reservation released |
| cancellation before write | `not_sent`, zero downstream writes |
| disconnect before write | `not_sent`, safe retry classification |
| disconnect after write | `unknown`, gate closes, zero replay |
| malformed downstream response | fail closed; `not_sent` or `unknown` according to write boundary |
| stale session generation | `STALE_SESSION_GENERATION`, zero downstream writes |
| busy without takeover | `CONTROL_BUSY`, incumbent unchanged |
| authorized takeover | old generation quiesced before new publish |
| unauthorized takeover | permission error, incumbent unchanged |
| definitive acknowledgement | `applied` with exact verification strength |
| duplicate same request/digest | cached definitive result, zero second write |
| duplicate changed digest | `REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT`, zero second write |
| partial verification | applied acknowledgement preserved as `device_ack_only`; no replay |
| partial multi-event dispatch | `unknown` with exact dispatched/completed counts; suffix suppressed |
| post-reconnect input without capture | fresh-capture error, zero input |
| cleanup failure | cleanup-phase error evidence retained, no fabricated restoration |
| cached display observation | observed time/age/provenance returned; stale policy enforced; proxy streaming omitted |
| EDID lower-layer failure | `EDID_READ_FAILED`; no empty or qualified success |
| reconnect evidence | new WebRTC/RPC/HID/browser-channel generation required; restart/quiesce alone rejected |
| ATX gate and serialization | extension/serial preflight, one full-sequence mutex, request-ID reservation, exact fixed timing |
| ATX acknowledgement semantics | serial completion only; cached LED fact separate; no host-state proof |
| SSE route security | identical MCP HTTP auth/Host/Origin boundary runs before GET creation and POST lookup |
| SSE routing/close | session ID never authenticates; exact 400/404/202 and SDK internal 500 behavior; parsed-body limit; idempotent close; no double write after headers |
| shared DeviceRpcAdapter binding | one Browser/WebRTC RPC channel and one injected adapter instance; no direct/second channel |
| DeviceRpcAdapter replacement | old binding invalidated before new publish; stale reads have explicit freshness; stale EDID/ATX makes zero writes |
| DeviceRpcAdapter mid-flight loss | read errors or stale cached qualification; ATX uses pre/post-write outcome classification; no replay |

Every applicable handler/row cell cites both a focused unit/adapter assertion and a manifest story assertion. A non-applicable cell requires reviewed rationale. Input cells additionally cover stale/consumed/foreign observations, display change before/after first dispatch, invalid coordinates/keys, held-state cleanup, and post-operation capture failure. Paste covers event gap, cancellation, lifecycle downgrade, layout mismatch, and timeout before/after acceptance. Release races every deferred producer and writer. Power covers exactly three actions.
### 0.5 Story manifest is acceptance authority

Phase 2 creates the one strict, versioned machine-readable manifest under `tools/jetkvm-mcp/stories/`. It uses exactly the canonical `AcceptanceStory` shape; no plan-local story schema or prose-only steps are allowed:

```ts
type AcceptanceStory = {
  id: string;
  title: string;
  requirements: string[];
  tools: JetKvmToolName[];
  environments: Array<"fake" | "replay" | "live">;
  preconditions: StoryCondition[];
  fault_script: FaultStep[];
  steps: StoryStep[];
  pass: StoryAssertion[];
  evidence: EvidenceField[];
  restore: RestoreStep[];
  privacy: PrivacyRule[];
};
```

The reviewed Phase 2 manifest contains all 24 complete canonical stories—never placeholders or uppercase aliases:

1. `session-connect-without-takeover-busy`
2. `session-explicit-authorized-takeover`
3. `session-reconnect-invalidates-observations`
4. `display-capture-fresh-frame-and-geometry`
5. `display-status-resolution-and-read-only-edid`
6. `mouse-observation-fence-and-single-use`
7. `keyboard-physical-keys-only`
8. `reliable-paste-91cps-correlated-terminal`
9. `emergency-release-races-every-writer`
10. `power-three-semantic-actions`
11. `disconnect-before-write-not-sent`
12. `disconnect-after-write-unknown-no-replay`
13. `duplicate-request-id-definitive-replay`
14. `malformed-response-fails-closed`
15. `permission-and-capability-errors-actionable`
16. `stale-generation-zero-downstream-write`
17. `partial-verification-does-not-replay`
18. `transport-reconnect-does-not-own-device`
19. `display-status-cached-freshness-and-streaming-omission`
20. `edid-low-level-failure-propagates`
21. `reconnect-requires-new-channel-observations`
22. `atx-extension-serialization-idempotency-and-nonproof`
23. `sse-get-and-post-share-http-security-boundary`
24. `sse-session-id-is-routing-not-authentication`

Each story has complete setup/preconditions, exact calls, timing/fault boundaries, observable pass assertions, allowed evidence, unconditional restore, and privacy rules in Phase 2. Later phases implement and execute only through this reviewed manifest. Any story/schema/step change is an API/acceptance change that reruns advisor, manifest review, generated docs/matrix, affected tests, and downstream gates. The same manifest drives focused links, fake/replay E2E, docs, and serialized live hardware.
### 0.6 Branch, maker, review, and merge rules

These rules apply independently to all six phases and are repeated in each phase gate:

1. Phase 1 uses exact branch `feat/jetkvm-mcp-foundation`; current foundation work must be normalized onto that PR head without carrying unrelated work. Every later branch is created from updated, clean `main` only after the prior phase PR is merged: `git switch main`, `git pull --ff-only`, verify the worktree is clean, then `git switch -c <phase-branch>`. Never stack a phase branch on an unmerged predecessor.
2. Maker agents may edit and run only their focused RED/GREEN tests. They skip phase-wide gates, formatters, full suites, PR operations, and reviewer work. The orchestrator integrates makers, then runs each required gate once.
3. Before coding, the orchestrator completes the phase advisor gate in §0.1. Before opening the PR, it checks the phase against the canonical design and this exact catalogue.
4. Every PR body states: base/head; advice reviewed; decisions and rejected alternatives; intentional divergences; exact files/tools/stories changed; tests and clean-checkout evidence; security/privacy effects; known risks; rollback/restore plan; and hardware impact.
5. Fresh reviewers who did not make the reviewed change inspect the current full diff after maker integration. Findings use `P0 blocker`, `P1 major`, `P2 minor`, or `P3 note`, plus `confidence: high|medium|low` and the evidence or gap behind that confidence.
6. Maker agents fix findings. The orchestrator reruns affected focused tests and the phase-wide local gate once. A fresh reviewer checks the corrected current diff; do not reuse an approval of an earlier diff.
7. Merge requires zero unresolved P0/P1, all required CI green, the phase's full local gate green from a clean checkout, required approval, and no undocumented divergence. P2/P3 may remain only when disposition and owner are recorded and they do not contradict acceptance.

---

## Locked file map by phase

Existing names are retained where they already exist. New names below establish responsibility boundaries; implementation may not create a second competing abstraction.

### Phase 1 — Foundation

- Existing package/runtime/lease: `tools/jetkvm-mcp/package.json`, lock/config files, `src/domain.ts`, `errors.ts`, `runtimePolicy.ts`, `deviceLease.ts`, `deviceLeaseGroup.ts`, `deviceLeaseRunner.ts`, `deviceLeaseSupervisor.ts`, their focused tests, and lease scripts.
- Existing Go safety: `internal/controlsession/manager.go`, `manager_test.go`; `internal/usbgadget/hid_keyboard.go`, `hid_keyboard_test.go`, and the minimal test seam in `usbgadget.go`; root `session_manager_test.go`, `jsonrpc_test.go`; and existing integration points in `cloud.go`, `web.go`, `webrtc.go`, `hw.go`, `main.go`, `native.go`, `network.go`, `ota.go`, `serial.go`, `usb.go`, `video.go`, `hidrpc.go`, and `jsonrpc.go`.
- Foundation CI/package gate: `.github/workflows/jetkvm-mcp-foundation.yml`, every existing workflow Node job including `.github/workflows/build.yml` and `ui-lint.yml`, `tools/jetkvm-mcp/scripts/check-package.mjs`, its tests, and package scripts.

### Phase 2 — Transport/API contracts and seams

- Config/contracts: `tools/jetkvm-mcp/src/config.ts`, `config.test.ts`, replacement `domain.ts`, `domain.test.ts`, `errors.ts`, `errors.test.ts`.
- MCP: `src/mcp/toolCatalogue.ts`, `toolCatalogue.test.ts`, `schemas.ts`, `schemas.test.ts`, `results.ts`, `results.test.ts`, `server.ts`, `server.test.ts`, `stdio.ts`, `stdio.test.ts`, `legacySse.ts`, `legacySse.test.ts`.
- Sessions/request ledger: `src/session/deviceSessionClient.ts`, `deviceSessionClient.test.ts`, `src/idempotency/RequestLedger.ts`, `RequestLedger.test.ts`.
- Shared device RPC: `src/device/DeviceRpcAdapter.ts`, `DeviceRpcAdapter.test.ts`; one internal `DeviceRpcBinding` with camelCase fields `{sessionId, sessionGeneration, connectionEpoch, browserChannelGeneration}` references the existing BrowserPlane RPC channel; NativeControlPlane uses this injected adapter rather than opening another WebRTC connection.
- Planes: `src/planes/BrowserPlane.ts`, `NativeControlPlane.ts`; `test-support/fakes/FakeBrowserPlane.ts`, `FakeNativeControlPlane.ts`; `test-support/replay/BrowserPlaneReplay.ts`, `NativeControlPlaneReplay.ts`; seam tests under `test-support/`.
- Stories: `src/stories/manifest.ts`, `manifest.test.ts`, tracked `schemas/story-manifest.schema.json`, and `stories/*.json`.
- Protocol/docs/package scripts: `scripts/generate-schemas.mjs`, `check-schemas.mjs`, `check-docs-consistency.mjs` with focused tests, contract/protocol installed smokes, and package scripts that run them.

### Phase 3 — Input and display

- UI boundary: `ui/src/automation/bridge.ts`, `bridge.test.ts`, `inputGuard.ts`, `inputGuard.test.ts`, `controller.ts`, `controller.test.tsx`; `ui/src/utils/pasteText.ts`, `pasteText.test.ts`; focused changes/tests in `useKeyboard.ts`, `useMouse.ts`, `useHidRpc.ts`, `useJsonRpc.ts`, `hidRpcTransport.ts`, `WebRTCVideo.tsx`, and `devices.$id.tsx`.
- Browser implementation: `tools/jetkvm-mcp/src/browser/auth.ts`, `geometry.ts`, `frames.ts`, `keys.ts`, `input.ts`, `paste.ts`, `BrowserController.ts`, and focused tests beside each module.
- Plane/handlers: `src/planes/JetKvmBrowserPlane.ts`, `JetKvmBrowserPlane.test.ts`, `src/native/JetKvmNativeControlPlane.ts`, `JetKvmNativeControlPlane.test.ts`, `src/handlers/display.ts`, `display.test.ts`, `input.ts`, `input.test.ts`.
- Native read correctness: modify `internal/native/cgo_linux.go` at `videoGetEDID`, propagate its error through existing `VideoGetEDID` gRPC/JSON-RPC layers, and add focused native/JSON-RPC tests; adapter tests cover per-fact `cached_snapshot` (`getVideoState`) versus `cached_event` (`videoInputState`) freshness plus EDID unsupported/unavailable/read-failed distinctions and sanitized replays.
- Adapter fixture: `test-support/uiFixture.ts`, `BrowserPlane.adapter.test.ts`, sanitized native display replay tapes, and the Phase 3 story files.

### Phase 4 — Power and session

- Session service/handlers: `src/session/SessionService.ts`, `SessionService.test.ts`, `src/handlers/session.ts`, `session.test.ts`.
- ATX serialization/readiness: create `internal/atx/controller.go`, `controller_test.go`; integrate it through `serial.go`, `serial_test.go`, `jsonrpc.go`, and `jsonrpc_test.go`; extend `src/native/JetKvmNativeControlPlane.ts`; create `src/handlers/power.ts`, `power.test.ts`; add sanitized ATX replay tapes.
- Composition: `src/ToolHandlers.ts`, `ToolHandlers.test.ts`, and production registration in `src/mcp/server.ts`.
- Phase 4 session/power stories.

### Phase 5 — System E2E, docs, package

- E2E: `tools/jetkvm-mcp/test-support/system/branchMatrix.ts`, `branchMatrix.test.ts`, `storyRunner.ts`, `storyRunner.test.ts`, `protocolE2E.test.ts`.
- Harness: `tools/paste-harness/src/mcpUserStories.ts`, `mcpUserStories.test.ts`, `mcpReleaseManifest.ts`, `mcpReleaseManifest.test.ts`, CLI shims, package/lock updates.
- Package checks: tracked generated schemas; extend the Foundation `scripts/check-package.mjs`; add `installed-smoke.mjs`, `installed-sse-smoke.mjs`, and tests.
- Documentation: package `README.md`, `SECURITY.md`, root `README.md`, and executable examples under `tools/jetkvm-mcp/examples/`; troubleshooting remains in the package README unless an existing docs convention requires another existing file.
- CI: `.github/workflows/jetkvm-mcp.yml` and only the minimum existing workflow changes needed to make it required.

### Phase 6 — Hardware evidence and release

- Hardware runner and validator: extend paste-harness story/manifest modules and CLI shims; no production source is changed for test-only behavior.
- Ignored external evidence directory for the chosen release candidate; immutable manifest/report/checksums are attached to the PR and release, not committed into the candidate tree.
- Release metadata, tag, tarball, checksum, generated schemas, and evidence manifest are all bound to the exact candidate.

---

# Phase 1 — Foundation safety PR

**Branch:** Put all current Foundation work on exact PR branch `feat/jetkvm-mcp-foundation`, based on `main`, without unrelated changes. Do not add any public tool handlers in this branch.

**Outcome:** Merge the reusable package/runtime/device-lease/supervisor foundation, Go generation-scoped quiesce manager, and keyboard auto-release/clear serialization that guarantees no post-zero HID, without preserving the obsolete public API as an implementation commitment.

## Task 1.1: Rebaseline the canonical advice log before code continues

- [ ] Read both completed advisor consultations and reconcile the canonical design and this plan with the locked decisions in §0.
- [ ] In the Phase 1 PR body, state that the reusable safety foundation remains, while the prior public catalogue and transport plan are superseded.
- [ ] Inventory current foundation changes as `complete`, `in progress`, or `not started`; do not rewrite passing foundation work merely to match the new plan's file names.
- [ ] Explicitly reject any Phase 1 diff that introduces old public handlers, a Streamable HTTP module, EDID mutation, or unrelated capability code.

## Task 1.2: Finish and preserve Task 1 package/runtime/device-lease/supervisor work

**Targets:** existing Task 1 files in the Phase 1 file map, especially `assertSupportedNodeRuntime`, domain/error redaction, `DeviceLease`, `DeviceLeaseGroup`, `DeviceLeaseRunner`, and `DeviceLeaseSupervisor`.

- [ ] Keep Node support `>=22.23.1 <23`, exact 22.23.1 release gates, production-only package output, and SDK/Playwright/Zod pins already established.
- [ ] Complete focused tests for atomic device-keyed lease acquisition, proof-file permissions and redaction, second contender, inherited proof, process-group supervision, signal/exception cleanup, stale fail-closed administration, and installed lease smoke.
- [ ] Keep the existing commit subject where the work is represented by that commit: `feat(mcp): define production computer-use contracts`. The subject is historical; the Phase 2 clean cutover replaces obsolete public domain types rather than treating the wording as a public API guarantee.
- [ ] If remediation is separate, use a narrow foundation subject such as `fix(mcp): complete device lease supervision`; do not squash away the useful history until PR policy decides.

## Task 1.3: Finish and preserve Task 2 Go session manager work

**Targets:** `internal/controlsession.Manager`, `Acquire`, `StartProducer`, `QuiesceAndZero`, `Takeover`, `Close`; session integration in `hidrpc.go`, `jsonrpc.go`, and root session tests; `internal/usbgadget.UsbGadget.performAutoRelease`, `ClearKeyboardState`, `hid_keyboard.go`, `hid_keyboard_test.go`, and the deterministic callback seam in `usbgadget.go`.

- [ ] Finish host-runnable race tests for manager-only maintenance leases, draining rejection, blocked/queued producer join, ordinary lease count zero before final zero, correlated receipts, stale generation no-write, and zero post-zero.
- [ ] Finish root integration tests for current-session snapshots, session-scoped candidates/close, session-bound `quiesceAndZero(operationId)`, matching operation/generation receipts, and stale-channel no-write after replacement.
- [ ] Fix the fired auto-release callback race by serializing callback validation/write with keyboard clear. Prove both lock orders deterministically: callback-first writes release then clear; clear-first removes the timer and the resumed callback writes zero HID reports. Preserve lock order and no timer-to-keyboard-lock cycle.
- [ ] Extend `scripts/run-device-go-tests.mjs` with a hardware-free Foundation root-integration mode that compiles/runs the full Phase 1 root integration selection against injected seams without deploy, network, target, or device. Unit-test command selection and fail closed if hardware/target inputs are present; device-dependent execution remains Phase 6.
- [ ] Audit direct current-session mutation so ownership changes are manager-backed.
- [ ] Preserve the exact commit subject: `fix(webrtc): revoke stale HID sessions atomically`; keep the auto-release race fix as its own narrow Foundation commit when history already separates it.
- [ ] Retain `scripts/run-device-go-tests.mjs` and its unit tests. Root/device hardware tests remain deferred to the serialized Phase 6 operator target; Phase 1 runs only hardware-free package races and host-runnable integrations.

## Task 1.4: Add the required hardware-free Foundation CI

**Files:** `.github/workflows/jetkvm-mcp-foundation.yml`, existing Node-job workflows including `build.yml` and `ui-lint.yml`, package scripts, `scripts/check-package.mjs`, and focused script tests.

- [ ] Pin every new and existing workflow Node job to exact Node 22.23.1 with `actions/setup-node`, then immediately assert `node --version` is exactly `v22.23.1`.
- [ ] Foundation CI runs `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `npm run test:installed-lease`, `npm run package:check`, the hardware-free Foundation root-integration mode, and `go test -race ./internal/controlsession ./internal/usbgadget`.
- [ ] `package:check` validates the production allowlist and rejects test, fixture, debug, trace, secret, lease-proof, and unallowlisted files.
- [ ] CI receives no hardware URL, target identity, lease proof, credential, secret, self-hosted label, or live-test discovery path. It cannot read or mutate a device; device-dependent root tests remain Phase 6-only.
- [ ] Required workflow policy covers every Phase 1 root integration/runtime path with safe gates: root `*.go`, relevant `internal/controlsession/**`, `internal/usbgadget/**`, `internal/hidrpc/**`, MCP runtime/lock/scripts, and `.github/workflows/*.yml`.

## Task 1.5: Focused and clean-checkout gates

Maker agents run only the focused tests for their touched Task 1 or Task 2 files. After all makers finish, the orchestrator runs once:

```bash
cd tools/jetkvm-mcp
npm ci
npm test
npm run typecheck
npm run build
npm run test:installed-lease
npm run package:check
npm run test:go-foundation

go test -race ./internal/controlsession ./internal/usbgadget
```

Then validate from a separate clean checkout of the Phase 1 head:

```bash
cd tools/jetkvm-mcp
npm ci
npm test
npm run typecheck
npm run build
npm run test:installed-lease
npm run package:check
npm run test:go-foundation
go test -race ./internal/controlsession ./internal/usbgadget
```

Acceptance: no test/fixture/debug file in production output; no secret or lease proof in stdout/stderr/artifacts; no old public handler exists; hardware-free controlsession/usbgadget race gates pass; deterministic auto-release tests prove no post-zero HID; root/device hardware tests remain deferred to Phase 6.

## Phase 1 PR/review/merge gate

- [ ] PR base is `main`, head is `feat/jetkvm-mcp-foundation`; body contains the §0.6 advice/divergence/test/risk content and calls out preserved Task 1/Task 2 commit subjects and the hardware-free CI boundary.
- [ ] Fresh architecture reviewer checks that only foundation safety survives; fresh concurrency/security reviewer checks the current Go manager, usbgadget callback/clear lock ordering, lease, supervisor, and CI diff.
- [ ] Findings are P0-P3 with confidence and evidence. Makers fix; orchestrator reruns focused failures and the full Phase 1 local gate once; fresh reviewers recheck the corrected diff.
- [ ] Merge only with zero P0/P1, green required CI, green full local and clean-checkout gates, and required approval.

---

# Phase 2 — Transport/API contracts PR

**Branch:** After Phase 1 is merged, update clean `main` and create `feat/jetkvm-mcp-transport-api`. It must contain the Phase 1 merge and no unmerged Phase 1 branch commits.

**Outcome:** Freeze the exact ten-tool catalogue, canonical result/error/request-ledger/session contracts, operator URL/auth configuration, complete reviewed story manifest, browser/native Fake/Replay seams, one session-owned `DeviceRpcAdapter`, connect/reconnect client foundation, and replaceable stdio plus legacy SSE adapters. Do not wire fake or placeholder planes into production.

## Task 2.1: Advisor gate and public-first operator configuration

**Files:** `src/config.ts`, `config.test.ts`, `src/browser/auth.ts`, `auth.test.ts`, `src/observability/logger.ts`, `logger.test.ts` if logging is not already centralized.

- [ ] Record the transport decision and public-first URL/auth decision in the PR advice log before code.
- [ ] RED-test operator configuration accepting an explicit HTTPS URL, LAN hostname/IP URL, and Tailscale DNS/HTTPS URL without preferring any of them.
- [ ] RED-test that plain HTTP is rejected unless the operator explicitly enables insecure HTTP; malformed URL, embedded credentials, fragments, and unsafe schemes fail closed.
- [ ] RED-test credential source precedence/conflict, current-user file permissions, disposal/redaction, and proof that tool schemas and results have no URL/credential fields.
- [ ] RED-test SSE bind/Host/Origin/bearer policy independently from the configured JetKVM URL. Default local bind is safe; non-loopback exposure requires explicit operator settings.
- [ ] Implement one immutable `OperatorConfig` parsed before transport/device effects. The model never selects a target or authenticates.

## Task 2.2: Replace obsolete domain types with the exact catalogue and envelopes

**Files:** `domain.ts`, `domain.test.ts`, `errors.ts`, `errors.test.ts`, `mcp/toolCatalogue.ts`, `toolCatalogue.test.ts`, `mcp/schemas.ts`, `schemas.test.ts`, `mcp/results.ts`, `results.test.ts`.

- [ ] Delete obsolete public action/result types and tests instead of aliasing them. Keep generic primitives only when the new catalogue actually uses them.
- [ ] RED-test the complete sorted inventory of ten names and absence of every other production registration.
- [ ] Copy all ten strict inputs/results and bounds from canonical design §9 and test them structurally and as generated JSON Schema; do not introduce optional defaults or fields absent from §9.
- [ ] `jetkvm_session_connect` accepts exactly required `request_id`, optional `takeover` defaulting false, and required `timeout_ms` in 100..60000. It accepts no mode, lease, target, URL, or credential. Its result is exactly §0.3/§9.1, with `session_id` and `session_generation` in the common envelope.
- [ ] `jetkvm_power_control` accepts exactly session ID/generation, request ID, one of three semantic actions, and required bounded timeout—no precondition or timing field. Keyboard accepts only canonical physical actions.
- [ ] Copy the exact §0.3 success, mutation, and error envelopes; assert every legal/illegal outcome-verification-retry-next-step combination, including definitive ack plus failed post-read staying `applied/device_ack_only`.
- [ ] RED-test screenshot-byte isolation: image bytes occur only in the authorized MCP image content block, never structured content, text, errors, logs, schemas, or evidence.
- [ ] Generate tracked JSON Schemas and fail on missing, extra, or stale schema files.

## Task 2.3: Implement the bounded request ledger and session client foundation

**Files:** `idempotency/RequestLedger.ts`, tests; `session/deviceSessionClient.ts`, tests.

- [ ] RED-test canonical input digesting; request-ledger key exactly `{session_id, session_generation, tool, request_id}`, or `{principal, configured_device, tool, request_id}` for connect; digest stored and compared inside the entry, never in the key; same-request/digest definitive replay; `REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT`; in-flight duplicate; TTL/size bounds; terminal persistence before response; cache loss; and no secret/payload persistence.
- [ ] RED-test that a definitive ack followed by failed post-read is persisted as `applied/device_ack_only` and never replayed; unknown is persisted and never replayed; not-sent retry releases only valid reservations.
- [ ] RED-test application `session_id` and `session_generation` independent of MCP transport IDs; closing/reopening SSE cannot steal, transfer, or mint ownership.
- [ ] RED-test exact connect input/result, busy without takeover, authorized takeover plumbing, reconnect generation rotation, stale-generation rejection, abort propagation, and required bounded timeouts.
- [ ] Implement only the client/coordinator foundation needed to call injected planes. Ownership-changing production handlers remain Phase 4.

## Task 2.4: Define BrowserPlane and NativeControlPlane Fake/Replay seams

**Files:** `planes/BrowserPlane.ts`, `NativeControlPlane.ts`, `test-support/fakes/*`, `test-support/replay/*`.

- [ ] Keep interfaces capability-shaped: BrowserPlane owns frame/input/release and exposes its current session/generation-owned device-RPC channel handle; NativeControlPlane owns qualified display reads and semantic power through `DeviceRpcAdapter`. NativeControlPlane does not invent unified health or open transport.
- [ ] Fakes deterministically force deadline/cancellation before admission; disconnect before write, after write before ack, after definitive ack before post-read, and after persisted terminal result; malformed response; permission/capability denial; busy/takeover; stale generation; partial multi-event counts/suffix suppression; partial verification; cleanup failure; and post-reconnect input without capture.
- [ ] Post-ack read failure is `applied/device_ack_only`, not unknown. Unknown requires begun write without definitive correlated acknowledgement.
- [ ] Replays consume sanitized, versioned request/response tapes and reject unexpected order/shape. They never contain URL, credential, cookie, SDP/ICE, frame bytes, or paste text.
- [ ] RED-test every fault injector and replay mismatch so later handlers cannot pass through an inert fake.

## Task 2.5: Implement the session-owned generation-fenced DeviceRpcAdapter

**Files:** `device/DeviceRpcAdapter.ts`, `DeviceRpcAdapter.test.ts`; BrowserPlane channel-handle contract and fakes/replays.

- [ ] Create one internal `DeviceRpcBinding` with camelCase fields `{sessionId, sessionGeneration, connectionEpoch, browserChannelGeneration}`. It is the sole internal tuple; snake_case appears only in explicit MCP/wire mapping and is never maintained as a duplicate object.
- [ ] Validate all four binding fields before admission, queue, and send; any stale component produces zero downstream write. Reuse the sole product Browser/WebRTC `rpc` data channel; native display/EDID/ATX share this adapter with no second browser, peer connection, RPC channel, signaling flow, or direct HID transport.
- [ ] Provide typed, bounded operations only for proven status/display/power downstream calls. Correlate IDs, qualify malformed errors, redact payloads, expose ack/write boundaries, and cancel on deadline.
- [ ] RED-test camelCase wire mapping and all binding fields, including epoch-only replacement with unchanged session/generation/channel; old-binding invalidation before publish; replacement at admission/queue/send/ack; takeover; pre-write timeout/cancel; response on old binding; malformed/duplicate response; post-ack read failure; mid-flight loss; close; stale cached qualification; and no migration.
- [ ] Fake/Replay NativeControlPlane implementations consume the same typed adapter contract, so unit, replay, and production code agree on one channel and one fencing model.

## Task 2.6: Create the complete reviewed machine-readable story manifest

**Files:** `stories/manifest.ts`, tests; the one generated `schemas/story-manifest.schema.json`; `stories/*.json`.

- [ ] Implement exactly the strict `AcceptanceStory` fields in §0.5 and reject unknown fields; generate the one JSON Schema from that type instead of maintaining a second hand-authored story schema.
- [ ] Commit all 24 lowercase canonical IDs from §0.5 with complete requirements, tools, environments, preconditions, fault scripts, steps, pass assertions, evidence, restore, and privacy. No placeholder, uppercase alias, phase-local rename, or deferred fields are permitted.
- [ ] Test unique exact IDs, complete tool/requirement references, unconditional restoration for mutations/faults, privacy fields, no URL/credential/topology, and no unmapped tool/matrix row. Link the three DeviceRpcAdapter rows into existing stories only: replacement/single-channel proof in story 21, cached/stale binding behavior in story 19, and ATX pre/post-write fencing in story 22; never create story 25.

## Task 2.7: Implement stdio and legacy HTTP/SSE protocol adapters only


**Files:** `mcp/server.ts`, tests; `mcp/stdio.ts`, tests; `mcp/legacySse.ts`, tests; package scripts and installed contract smokes.

- [ ] Build `createMcpServer(handlerRegistry)` so production composition can inject only complete real handlers in Phase 4. Phase 2 tests inject deterministic test handlers from `test-support`; no fake is imported by production `src`.
- [ ] Prove stdio framing from the installed SDK 1.29.0 implementation/read-buffer behavior and black-box client/server interoperability, including partial and multiple messages. Do not cite declarations as framing proof. Test initialize, `tools/list`, calls, cancellation, malformed input, subprocess exit, and stdout purity.
- [ ] RED-test `GET /sse` separately from `POST /messages`. Project MCP authentication and Host/Origin/anti-CSRF/DNS-rebinding middleware run on both routes before GET transport creation or POST lookup. Do not conflate this middleware with the SDK's deprecated POST-only request-header validator.
- [ ] Both routes independently return adapter `401` for missing/invalid authentication and `403` for authenticated but forbidden Host/Origin/policy. Tests prove no session allocation/lookup occurs first.
- [ ] GET success is 200 `text/event-stream` with the exact endpoint event to `/messages?sessionId=...`; stream/response close is idempotent, tolerates duplicate callbacks, deletes the registry entry, and server shutdown closes all entries.
- [ ] POST treats `sessionId` only as routing. Missing or malformed ID returns 400. Unknown, closed, expired, and cross-principal IDs are indistinguishable 404 with the same safe body/timing class. Accepted valid JSON-RPC returns 202.
- [ ] Test exact JSON media type, parsed-body coordination/limit, invalid JSON/message 400 bodies, auth-info forwarding after middleware, SSE message framing, cancellation, and in-flight disconnect. Directly force the SDK inactive-stream path once: exactly one 500 `SSE connection not established`, no second write after headers.
- [ ] Keep SSE transport registries inside the adapter; bind routing entries to authenticated principal but never treat session ID as authentication, authorization, ownership, or a device-session ID.
- [ ] Ban project-owned Streamable HTTP imports, registrations, routes, CLI modes, schemas, examples, and direct dependencies. Do not fail merely because the installed MCP SDK package contains unused Streamable symbols.
- [ ] Installed smokes unpack the tarball, initialize test handlers, list exactly ten tools, exercise success/business/protocol errors, and prove SDK-grounded stdio plus SSE framing. No placeholder plane is wired into production.
- [ ] Document contract inspection, operator config, and transport status accurately: handler activation follows in Phase 4 and the release is not claimed usable until Phase 5.

## Task 2.8: Phase-wide and clean-checkout gates

- [ ] Add `check-docs-consistency.mjs` and focused tests that enforce the approved component-to-phase map in the canonical design, this plan, package scripts, and story ownership: Phase 2 owns `DeviceRpcAdapter` plus the complete 24-story manifest; Phase 3 owns display capture/status and read-only EDID. Fail on duplicate ownership, another story inventory, a 25th ID, or drift in tool/branch/phase names.
Add deterministic scripts `test:phase2`, `schemas:check`, and installed contract/protocol smokes. Maker agents skip them. The orchestrator runs once after integration:

```bash
cd tools/jetkvm-mcp
npm ci
npm run test:phase2
npm run typecheck
npm run build
npm run schemas:check
npm run docs:check
npm run smoke:installed-contracts
npm run smoke:installed-stdio-protocol
npm run smoke:installed-sse-protocol
```

Repeat the same gate from a clean checkout using only committed files and a freshly packed tarball. Assert production output has no test-support import, target URL, credential, replay tape, frame, or paste payload.

## Phase 2 PR/review/merge gate

- [ ] PR base is updated `main`, head is `feat/jetkvm-mcp-transport-api`; body contains advice, the deliberate two-transport divergence, exact ten schemas, security posture, test evidence, risks, and rollback.
- [ ] Fresh API reviewer checks catalogue/schema/envelopes; transport/security reviewer checks stdio/SSE and Host/Origin/auth; test reviewer checks seam fault power and story manifest completeness.
- [ ] Findings use P0-P3/confidence/evidence. Makers fix; orchestrator reruns affected focused tests and one full Phase 2/clean-checkout gate; fresh reviewers inspect the corrected diff.
- [ ] Merge only with zero P0/P1, green CI, green full local/clean install, and required approval.

---

# Phase 3 — Input and display PR

**Branch:** After Phase 2 is merged, update clean `main` and create `feat/jetkvm-mcp-input-display`. Do not branch from the Phase 2 feature branch.

**Outcome:** Implement Phase 3's approved display component boundary—browser frame capture plus native display status and read-only EDID—and browser mouse/physical-keyboard/reliable-paste/release, with every applicable canonical cell forced through fakes/replays and reviewed stories. `DeviceRpcAdapter` and the complete manifest remain Phase 2-owned.

## Task 3.1: Advisor gate and proven protocol mapping

- [ ] Before implementation, record which existing product surfaces each method uses. Browser operations use the real browser/WebRTC path through the Phase 2 `DeviceRpcAdapter`. Native status uses `getVideoState` as `cached_snapshot`, `videoInputState` as `cached_event`, and `getEDID` only with qualified read semantics.
- [ ] Base `jetkvm_display_status` requires `display_status`, not `edid_read`. Record explicit EDID `unsupported` (capability absent), `unavailable` (read path not currently available), and attempted-read `EDID_READ_FAILED` behavior, per-fact snapshot/event freshness, proxy-`streaming` omission, and read-only/no-mutation policy.
- [ ] If a fact is unavailable, return its canonical unknown/null/status with provenance and freshness. Do not fabricate it, infer live state from a zero value, or add mutation.

## Task 3.2: Build the stable product automation boundary

**Files:** the Phase 3 UI boundary files.

- [ ] RED-test one route-lifetime automation facade across rerenders/StrictMode, ready/not-ready/unmount, current layout/capabilities, monotonic lifecycle sequences, event gaps, and no successful no-op.
- [ ] RED-test exact input admission receipts: capture admitted, product handler queued, transport write, and generation are distinct states.
- [ ] RED-test channel close/replacement between admission and write for mouse, keyboard, paste, and release; an event admitted on one channel cannot migrate to another.
- [ ] RED-test paste normalization and lifecycle without storing paste text; progress is bounded and terminal state retained until acknowledged.
- [ ] Implement the minimum stable bridge/controller/hook seams. Reuse current product input behavior; no separate hidden HID path.
- [ ] Release cancels active paste, joins emitters, and delegates final zero to correlated `quiesceAndZero(operationId)`.

## Task 3.3: Implement fresh display capture and observation fencing

**Files:** `browser/geometry.ts`, `frames.ts`, `BrowserController.ts`, `planes/JetKvmBrowserPlane.ts`, `handlers/display.ts`, focused tests and adapter fixture.

- [ ] RED-test fresh decoded-frame advance, no-signal/stall, format and byte/dimension bounds, geometry/rotation, display-generation changes, maximum observation age, single-use mutation reservation, and stale observation rejection.
- [ ] RED-test image bytes and hashes through the real MCP result mapping; payload exists only in the authorized image block.
- [ ] Implement `jetkvm_display_capture` and its BrowserPlane adapter against the managed product page. Capture returns observation ID, session generation, display generation, dimensions, frame age/hash, and image.
- [ ] A reconnect or display-generation change invalidates all old observations and requires a fresh capture.

## Task 3.4: Implement read-only native display status

**Files:** `native/JetKvmNativeControlPlane.ts`, `handlers/display.ts`, focused tests and sanitized display replay tapes; `internal/native/cgo_linux.go`, existing gRPC/JSON-RPC EDID propagation paths, and focused native/JSON-RPC tests.

- [ ] RED-test signal, width, height, refresh/FPS, and resolution facts independently. A `getVideoState` response is `cached_snapshot`; `videoInputState` is `cached_event`; each fact preserves source, observation time, age, fresh/stale/unknown classification, event supersession, and binding-loss behavior. Receipt time is never mislabeled as hardware acquisition time.
- [ ] RED-test normal proxy omission of `Streaming`: no status/result treats the reconstructed zero value as live capture truth.
- [ ] RED-test base status success when `display_status` exists but `edid_read` does not: display facts return and EDID is explicitly `unsupported` with null detail. Distinguish that from `unavailable` when the supported read path cannot currently be attempted.
- [ ] Fix `videoGetEDID` to detect C `NULL` after open/`VIDIOC_G_EDID` failure before `C.GoString` and propagate a non-nil error through native gRPC/JSON-RPC. An attempted lower-level failure returns `EDID_READ_FAILED`, never unsupported, unavailable, not-reported, empty, or qualified success.
- [ ] Return EDID summary/hash only after successful verified read; a proven successful no-EDID result uses the canonical not-reported state. Never call/register `setEDID`; contract-test no mutation. Correlate browser capture and per-fact native observations without equating render/source/native resolution or freshness.

## Task 3.5: Implement mouse and physical keyboard handlers

**Files:** `browser/keys.ts`, `input.ts`, `handlers/input.ts`, focused tests.

- [ ] For `jetkvm_input_mouse`, implement bounded move/click/double-click/drag and the exact scroll contract: `delta_y` is a signed integer HID wheel step from -127 through 127 excluding 0; optional `delta_x` is exactly 0. Reject zero, fractions, overflow/underflow, nonzero horizontal scroll, and unknown fields before reservation with zero plane calls.
- [ ] For `jetkvm_input_keyboard`, implement physical press/down/up/chord operations, modifier-first/reverse-release behavior, layout/capability validation, and whole-request prevalidation. Reject text fields and unsupported keys before admission.
- [ ] Test every applicable canonical §11.2 cell with FakeBrowserPlane, BrowserPlaneReplay, and the real Playwright fixture, including partial multi-event counts/suffix suppression, cleanup failure, post-capture failure, and admission-to-write generation barriers.
- [ ] Persist request-ledger terminal state before returning. A definitive acknowledgement with failed post-capture remains `applied/device_ack_only`; no uncertain dispatch is auto-replayed.

## Task 3.6: Implement reliable paste at nominal ~91 source chars/s

**Files:** `browser/paste.ts`, `handlers/input.ts`, UI bridge/normalizer, focused tests.

- [ ] Implement only the reliable profile, paced deterministically at the established nominal ~91 source characters per second through the existing product paste path.
- [ ] RED-test normalization, byte/hash counts, empty/maximum input, pacing with fake clock, bounded progress, active/cancelled/completed/failed lifecycle, gap/duplicate/out-of-order terminal events, capability/layout change, timeout/disconnect at each lifecycle boundary, and no text persistence.
- [ ] `jetkvm_input_paste` reports acceptance separately from verified terminal completion and uses the common mutation envelope.
- [ ] No browser text insertion, clipboard API shortcut, SSH injection, or optimistic completion is allowed.

## Task 3.7: Implement correlated input release

**Files:** UI controller/bridge; `BrowserController.ts`; `handlers/input.ts`; Go receipt integration tests as needed.

- [ ] RED-test first-use already-zero release, active mouse/key state, active paste, queued/blocked work, correlated operation/generation receipt, stale receipt, timeout, disconnect, and zero post-zero.
- [ ] `jetkvm_input_release` always executes correlated zero/release on first use. A first-use already-zero device returns `applied/device_state_verified`; `already_applied` is legal only for cached replay of the same `request_id` and digest. Uncertain quiesce closes the gate and requires canonical recovery.

## Task 3.8: Complete Phase 3 stories and docs

- [ ] Implement and execute the reviewed manifest stories `display-capture-fresh-frame-and-geometry`, `display-status-resolution-and-read-only-edid`, `mouse-observation-fence-and-single-use`, `keyboard-physical-keys-only`, `reliable-paste-91cps-correlated-terminal`, `emergency-release-races-every-writer`, `display-status-cached-freshness-and-streaming-omission`, and `edid-low-level-failure-propagates`; do not rename or redefine them.
- [ ] Execute applicable fault scripts and canonical §11.2 cells through the same reviewed manifest, then generate human usage excerpts from it.
- [ ] Document coordinate/observation rules, physical keyboard versus paste, nominal pacing, progress/terminal meaning, release recovery, display status field semantics, and read-only EDID.

## Task 3.9: Phase-wide and clean-checkout gates

Add `test:phase3` scripts in MCP/UI packages. Maker agents run only focused files; the orchestrator runs once:

```bash
cd ui
npm ci
npm run test:phase3
npm run typecheck

cd ../tools/jetkvm-mcp
npm ci
npx playwright install chromium
npm run test:phase3
npm run typecheck
npm run build
npm run stories:validate
npm run docs:check
```

Run the equivalent committed-file gate in a clean checkout, including the real Playwright adapter fixture and package artifact scan. No physical hardware is used in this phase.

## Phase 3 PR/review/merge gate

- [ ] PR base is updated `main`, head is `feat/jetkvm-mcp-input-display`; body contains advisor decisions, plane boundaries, every applicable canonical story/cell, tests, image/text privacy, risks, and rollback/release impact.
- [ ] Fresh browser/input reviewer checks product-path authenticity and generation barriers; native reviewer checks display calls/read-only EDID; test/security reviewer checks full handler branch matrices and payload redaction.
- [ ] Findings use P0-P3/confidence/evidence. Makers fix; orchestrator runs affected tests and the one full Phase 3/clean-checkout gate; fresh reviewers inspect corrected diff.
- [ ] Merge only with zero P0/P1, green CI, green full local/adapter/clean-checkout gates, and required approval.

---

# Phase 4 — Power and session PR

**Branch:** After Phase 3 is merged, update clean `main` and create `feat/jetkvm-mcp-power-session`. Do not branch from the Phase 3 feature branch.

**Outcome:** Complete explicit connect/status/reconnect ownership and capability behavior plus fixed semantic ATX power control, then compose all ten production handlers.

## Task 4.1: Advisor gate and native action proof

- [ ] Record explicit ownership, no-steal default, transport independence, composed health/reconnect semantics, fixed ATX timing, serial readiness/serialization, and partial-release recovery decisions before code.
- [ ] Confirm mappings against existing JetKVM behavior: public `press_power` is `power-short` with 200 ms between ON/OFF, `hold_power` is `power-long` with 5 s, and `press_reset` is `reset` with 200 ms. Do not expose native duration parameters.
- [ ] Record that `getATXState` returns cached LED globals, not a synchronous serial read or host-power confirmation. Record extension state, serial-controller readiness, ON/OFF write receipts, cached LED/video observations, and their provenance separately; missing indicators remain typed unavailable.

## Task 4.2: Implement explicit SessionService ownership

**Files:** `session/SessionService.ts`, tests; `handlers/session.ts`, tests.

- [ ] Implement `jetkvm_session_connect` with exactly required `request_id`, optional `takeover`, and required bounded `timeout_ms`. On success the common envelope issues `session_id` and `session_generation`; the result is exactly `state`, connection/display generations, takeover flag, `fresh_capture_required`, permissions, capabilities, and `MutationState`. No mode, lease, target, URL, credential, or additional result shape is accepted.
- [ ] A normal connect never steals. Busy ownership returns `CONTROL_BUSY`, `not_sent/none`, `safe_to_retry:true`, and `required_next_step:"wait_or_request_takeover"`; the incumbent is unchanged.
- [ ] Explicit takeover invokes Go generation-scoped quiesce, waits for its input-release receipt, revokes old plane work, rotates generation, and invalidates old observations. The quiesce receipt proves only input drain/zero; it does not prove browser/native health or reconnect. Failure never grants ambiguous ownership.
- [ ] Implement `jetkvm_session_status` with exact canonical §9.2 input/result. It composes separate ownership, browser, WebRTC, RPC/HID, native-process, cached capture, capabilities, mutation, blocker, and version observations without adding mode, lease, or unified-health fields.
- [ ] `ping` proves only that one RPC handler ran on the current channel. Private/hard-coded `IsReady`, opaque `getVideoLogStatus`, cached `getVideoState`/`getATXState`, and native proxy auto-restart are not unified health proof and must never be promoted as such.
- [ ] Implement `jetkvm_session_reconnect` with exact §9.3 input/result: preserve logical session, close/observe old generation, rebuild browser/WebRTC RPC/HID channels, boundedly re-probe actual native reads through the same `DeviceRpcAdapter`, publish new generation, and require fresh capture. Native auto-restart, reboot launch, ping, and quiesce cannot satisfy reconnect.
- [ ] Test every applicable canonical §11.2 cell and stories `session-connect-without-takeover-busy`, `session-explicit-authorized-takeover`, `session-reconnect-invalidates-observations`, `transport-reconnect-does-not-own-device`, and `reconnect-requires-new-channel-observations`, including partially rebuilt planes and two-client/cross-transport cases.

## Task 4.3: Implement semantic ATX power control

**Files:** create `internal/atx/controller.go`, `controller_test.go`; modify `serial.go`, `serial_test.go`, `jsonrpc.go`, `jsonrpc_test.go`; extend `native/JetKvmNativeControlPlane.ts`; create `handlers/power.ts`, `power.test.ts`; add sanitized replay tapes.

- [ ] Implement one Go ATX controller/adaptor that checks `atx-power` is active and the serial controller is actually ready before admission, then holds a mutex across the complete newline/ON/sleep/OFF sequence. Mount/`SetMode` failure cannot result in ready state; unmount clears readiness.
- [ ] Preserve exactly the existing semantic wire actions and timing: power ON then OFF after 200 ms, power-long ON then OFF after 5 s, reset ON then OFF after 200 ms. The public and Node layers cannot choose or alter these durations.
- [ ] Return a structured internal receipt that distinguishes not admitted, ON write attempted/completed, fixed hold completed, OFF write attempted/completed, and serial error phase. Do not expose the existing unscoped/best-effort `setATXPowerAction` directly as the MCP completion contract.
- [ ] Treat ON-write failure as `not_sent` only when the writer proves no ON command was accepted. Treat OFF-write failure after ON as `unknown`, close the ATX gate, perform bounded best-effort OFF/release cleanup without repeating ON/the action, and require `inspect_device_state_before_retry`.
- [ ] Implement `jetkvm_power_control` with exactly session ID/generation, request ID, one of three actions, and required bounded timeout. There is no second idempotency key, precondition, duration, delay, or sequence field.
- [ ] A complete correlated serial ON/OFF receipt is `applied/device_ack_only` even when the subsequent cached LED read is unavailable or unchanged; persist it and never replay. Report cached LED observation separately with provenance/age and never upgrade it to host-state proof.
- [ ] Test extension/readiness failure, two concurrent requests serialized across ON/OFF, exact fake-clock durations, ON failure, OFF-after-ON failure and cleanup evidence, cancel-before-write, partial verification preserved as applied, malformed reply, terminal persistence, and every applicable canonical §11.2 cell with Fake/Replay seams.
- [ ] Never label an action or observation as host shutdown/start/reboot, never claim host-state change, and never infer action success from cached LEDs/video alone.

## Task 4.4: Compose and register exactly ten real handlers

**Files:** `ToolHandlers.ts`, tests; `mcp/server.ts`, catalogue/results integration tests; CLI entry points.

- [ ] Build a production handler registry from `SessionService`, `JetKvmBrowserPlane`, and `JetKvmNativeControlPlane`; production imports no fake/replay/test fixture.
- [ ] Register all and only the ten catalogue tools. Every registered handler implements timeout cancellation, common envelopes, redaction, and stable errors.
- [ ] Activate production stdio and legacy SSE CLI modes now that every tool has a real handler. Startup asserts runtime/config before transport or device effects; stdout remains protocol-only.
- [ ] Run inventory and packed-schema checks against production `tools/list` for both transports.

## Task 4.5: Complete Phase 4 stories and docs

- [ ] Execute reviewed stories `session-connect-without-takeover-busy`, `session-explicit-authorized-takeover`, `session-reconnect-invalidates-observations`, `reconnect-requires-new-channel-observations`, `power-three-semantic-actions`, and `atx-extension-serialization-idempotency-and-nonproof`; do not add phase-local story IDs.
- [ ] Assert canonical mutation outcomes/verification, evidence, and unconditional restoration through the reviewed manifest.
- [ ] Document ownership and takeover risk, reconnect/fresh-capture recovery, capability blockers, semantic ATX meaning, and unknown-effect handling. No host-OS claim is made.

## Task 4.6: Phase-wide and clean-checkout gates

Maker agents run focused handler tests only. The orchestrator runs once:

```bash
cd tools/jetkvm-mcp
npm ci
npx playwright install chromium
npm run test:phase4
npm run test:phase2
npm run test:phase3
npm run typecheck
npm run build
npm run schemas:check
npm run stories:validate
npm run docs:check
npm run smoke:installed-stdio
npm run smoke:installed-sse
```

Repeat from a clean checkout and freshly packed tarball. Smokes initialize/list exactly ten tools and execute fake-device-independent status/protocol/error paths without contacting a real device.

## Phase 4 PR/review/merge gate

- [ ] PR base is updated `main`, head is `feat/jetkvm-mcp-power-session`; body contains advisor decisions, native RPC proof, ownership/transport separation, ATX semantics, tests/stories, risks, restore/rollback, and hardware implications.
- [ ] Fresh concurrency reviewer checks takeover/quiesce/reconnect; native/security reviewer checks ATX, permissions, and unknown effects; API/test reviewer checks exact registration and branch matrices.
- [ ] Findings use P0-P3/confidence/evidence. Makers fix; orchestrator reruns affected tests and one full Phase 4/clean-checkout gate; fresh reviewers inspect corrected diff.
- [ ] Merge only with zero P0/P1, green CI, green full local/installed-smoke/clean-checkout gates, and required approval.

---

# Phase 5 — System E2E, docs, and packaging PR

**Branch:** After Phase 4 is merged, update clean `main` and create `feat/jetkvm-mcp-system-e2e-docs`. Do not branch from the Phase 4 feature branch.

**Outcome:** Generate fake/replay system E2E from named stories, prove the complete behavioral branch matrix and protocol contracts, finish stranger-ready README/examples/troubleshooting, freeze semver/package behavior, and make clean-checkout verification required in CI.

## Task 5.1: Advisor gate and acceptance crosswalk

- [ ] Before E2E/docs/package decisions, crosswalk every locked decision, tool, branch row, and story to an executable test and evidence field.
- [ ] Record any deliberate protocol divergence, unsupported capability behavior, security choice, and release risk in the PR body. No feature is added to simplify documentation or release.
- [ ] Fail the crosswalk on an unowned tool, branch, story, schema, or document claim.

## Task 5.2: Generate story-driven fake/replay E2E

**Files:** `test-support/system/storyRunner.ts`, tests; manifest generator; paste-harness story modules.

- [ ] Generate one success E2E and every applicable fault case from each machine-readable story; tests may add assertions but not redefine story steps in a second source.
- [ ] Run stories through real MCP server/result mapping over in-memory protocol, installed stdio, and installed legacy SSE, using only Fake/Replay planes.
- [ ] Assert preconditions before steps, pass criteria after steps, required evidence fields, and restore after every mutation—even on test failure.
- [ ] Drive every canonical §11.2 fault boundary from the reviewed manifest, including request-ID digest mismatch/replay, cancel-before-write, partial multi-event counts/suffix suppression, post-reconnect input without capture, cleanup failure, cached display/EDID, reconnect proof, ATX acknowledgement, SSE security/routing/close, and all three DeviceRpcAdapter rows—linked only to existing stories 21, 19, and 22.

## Task 5.3: Prove the complete behavioral branch matrix

**Files:** `test-support/system/branchMatrix.ts`, tests and generated report.

- [ ] Materialize canonical design §11.2 exactly as a machine-checkable matrix keyed by all ten tools; this file contains no additional behavior IDs.
- [ ] Require every applicable cell to cite both a focused unit/adapter test and a reviewed-manifest story assertion; non-applicable cells require reviewed rationale, never blank/skip.
- [ ] Require explicit cells for cancellation before write, partial multi-event dispatched/completed counts and suffix suppression, post-reconnect input without capture, cleanup failure evidence, cached display/EDID, reconnect proof, ATX, SSE route-security/routing/close, and the exact three DeviceRpcAdapter binding/replacement/mid-flight-loss rows.
- [ ] Fail on skipped tests, `.only`, duplicate/extra behavior IDs, missing evidence assertions, or any handler branch absent from canonical §11.2. Source coverage is diagnostic only.

## Task 5.4: Prove end-to-end protocol contracts

**Files:** `protocolE2E.test.ts`, installed smoke scripts, package-check scripts.

- [ ] For stdio and legacy SSE, test initialize, exact `tools/list`, all ten strict schemas, each result outcome, business versus protocol error, cancellation, disconnect, reconnect, logs, and payload redaction.
- [ ] Through the installed tarball, repeat both-route SSE contracts: independent adapter 401/403 on GET and POST before allocation/lookup; GET 200; missing/malformed `sessionId` 400; unknown/closed/expired/cross-principal 404 indistinguishable; accepted POST 202; SDK inactive-stream single 500; exact safe bodies; parsed-body limit; routing-only ID; duplicate-safe close; and device-session independence.
- [ ] Test runtime floor/later-supported-22/next-major behavior before any transport or device effect.
- [ ] Scan project source/dist/tarball/schemas/examples/docs for Streamable HTTP imports, registration, routes, CLI, schema, example, or direct dependency; ignore unused symbols nested in the SDK dependency.

## Task 5.5: Finish stranger-ready README, examples, troubleshooting, and security guidance

**Files:** package/root README, SECURITY, executable examples.

- [ ] Document a five-minute clean install from the packed artifact under supported Node, with exact stdio host configuration and legacy SSE server/client examples.
- [ ] Document operator-only device URL/auth configuration for HTTPS, LAN, and Tailscale; insecure HTTP opt-in; SSE bind/Origin/Host/bearer security; secret handling; and why tools never accept credentials.
- [ ] List exactly ten tools with strict input/result summaries and realistic examples for connect/status/reconnect, capture/status, mouse/keyboard/paste/release, and all three power actions.
- [ ] Explain ownership/no-steal/takeover, transport-session independence, generation/observation fencing, idempotency outcomes, safe retry, next steps, and no-silent-partial-success behavior.
- [ ] Explain reliable paste pacing, physical keyboard versus paste, exact signed-integer wheel bounds, per-fact cached-snapshot/event display freshness, base display-status success without EDID capability, EDID unsupported/unavailable/read-failed semantics, image/paste privacy, and semantic ATX limitations.
- [ ] Add troubleshooting for auth/permission, insecure HTTP rejection, CONTROL_BUSY, capability missing, stale generation/observation, no video/stalled frame, paste interruption, unknown input/power effect, release/reconnect/manual recovery, SSE reconnect, and runtime/browser setup.
- [ ] Execute every example against the installed fake/replay E2E environment. Examples must fail if they drift from schemas.

## Task 5.6: Finalize semver/package metadata and CI

**Files:** package metadata/lock, schemas, check scripts, `.github/workflows/jetkvm-mcp.yml`.

- [ ] Keep package version at release candidate `0.1.0` metadata without publishing. Verify package name, licence, repository, engines, bin/exports, files allowlist, and generated schema set.
- [ ] Make pack deterministic and production-only; exclude tests, fixtures, replays, traces, source maps containing secrets, and debug artifacts.
- [ ] Add required hardware-free CI jobs for foundation Go race tests, UI focused tests, MCP phase suites, pinned browser adapter, schema/package scans, installed stdio/SSE smokes, story E2E, branch matrix, examples, and docs/schema consistency.
- [ ] Public CI has no device secrets and never discovers or runs live hardware stories.

## Task 5.7: Full local and clean-checkout gates

Maker agents run only focused E2E/docs-script tests. The orchestrator runs the repository's complete hardware-free gate once, including:

```bash
go test -race ./internal/controlsession ./internal/usbgadget

cd ui
npm ci
npm run test:unit
npm run typecheck

cd ../tools/jetkvm-mcp
npm ci
npx playwright install chromium
npm test
npm run typecheck
npm run build
npm run schemas:check
npm run stories:validate
npm run branch-matrix:check
npm run docs:check
npm run package:check
npm run smoke:installed-stdio
npm run smoke:installed-sse
npm run examples:check

cd ../paste-harness
npm ci
npm test
npm run typecheck
```

Repeat from a separate clean checkout using a freshly created tarball and empty install directory. Run every README/example command in that environment. Required result: zero skips, exact ten tools, only stdio/SSE, deterministic package/checksum, no secrets/payloads, complete matrix.

## Phase 5 PR/review/merge gate

- [ ] PR base is updated `main`, head is `feat/jetkvm-mcp-system-e2e-docs`; body contains advisor/crosswalk decisions, protocol divergence, complete test and matrix evidence, stranger-install proof, package risks, rollback, and the planned hardware matrix.
- [ ] Fresh system-test reviewer checks story generation/matrix; artifact/security reviewer checks tarball/smokes/redaction; stranger reviewer follows README/examples from no context and records confidence/gaps.
- [ ] Findings use P0-P3/confidence/evidence. Makers fix; orchestrator reruns affected tests and the one full Phase 5/clean-checkout gate; fresh reviewers inspect corrected diff.
- [ ] Merge only with zero P0/P1, green required CI, green full local and clean-checkout install, complete matrix, and required approval.

---

# Phase 6 — Hardware evidence and release PR

**Branch:** After Phase 5 is merged, update clean `main` and create exact branch `feat/jetkvm-mcp-hardware-release`. It must not contain unmerged feature-branch work. `jetkvm-mcp-v0.1.0` is reserved for the release tag only.

**Hardware target:** The runner receives a protected operator target at runtime and derives the device lease key from its normalized identity without logging it. No fixed IP, hostname, URL, lease key, network path, or topology appears in package defaults, schemas, public examples, manifest, or evidence.

**Outcome:** Freeze one candidate, run every release-gating story serially under one device lease with evidence and restoration, bind an immutable manifest to exact source/package/runtime/firmware identities, obtain fresh review, merge, tag, publish, and verify the downloadable release from a clean checkout and empty install.

## Task 6.1: Advisor gate, release branch preflight, and candidate freeze

- [ ] Re-read both advisors, canonical design, plan, merged PRs, and story/branch matrix before any release decision. Record final advice/divergence/risk disposition in the release PR body.
- [ ] Require merged `main`, green Phase 5 CI, clean worktree, complete six-phase history, zero known P0/P1, complete behavioral matrix, and no skipped release-gating story.
- [ ] Record candidate commit `C`, tree `G`, package-lock hash, story-manifest hash, generated-schema hash, and exact Node 22.23.1 identity.
- [ ] Clean-build the package tarball `T` once and record filename, size, SHA-256, package-tree hash, and unpacked-file manifest. No code/schema/doc change is allowed after freezing `C/G/T`.
- [ ] Any required fix invalidates the candidate: make the fix on the release branch, rerun affected plus full hardware-free gates, freeze a new `C/G/T`, and rerun every hardware story whose code, schema, package, docs, or evidence interpretation changed.

## Task 6.2: Acquire one serialized device lease and establish baseline

- [ ] Before any device read, browser login, deploy, status request, or mutation, accept the protected operator target, derive its lease key at runtime, acquire that single device-keyed lease, and enter one outer `try/finally`. Every child inherits matching proof; no child reacquires or logs target/key/proof.
- [ ] Under the lease, record pre-run firmware/app version, running revision/binary identity, ATX extension/capability state, video/display status, EDID hash, input-zero state, no active paste, ownership state, and agreed host power baseline.
- [ ] Deploy or select the exact candidate using the repository's approved release procedure, then prove running identity. If exact candidate identity cannot be proven, stop before stories.
- [ ] Run installed `T` under exact Node 22.23.1. Record browser executable/version and a sanitized connection-configuration class without persisting target, route, URL, credential, or topology.

## Task 6.3: Run stories serially with per-story restore

For every reviewed manifest story whose `environments` includes `live`, the runner uses the canonical ID/steps without redefinition and writes a record before moving to the next story:

1. story ID/name and exact manifest hash;
2. capability check and explicit preconditions;
3. ordered tool calls and timing;
4. pass criteria and actual observed values;
5. privacy-safe evidence hashes/metadata;
6. restoration commands and observed restored baseline;
7. terminal result `pass` or `fail`—never skip.

Run at minimum, in manifest order:

- [ ] Session available connect/status, busy without takeover, explicit takeover with old-generation rejection, and disconnect/reconnect with fresh generation. Evidence records each composed browser/channel/native observation and its freshness; neither ping, native auto-restart, nor quiesce alone passes. MCP transport reconnect never transfers ownership.
- [ ] Fresh display capture and read-only display status: frame hash/dimensions/age; per-fact `cached_snapshot`/`cached_event` provenance/age; base success without `edid_read`; EDID unsupported, unavailable, verified/not-reported, and explicit low-level read-failure cases; no proxy-`streaming` claim or mutation.
- [ ] Mouse move/click/double-click/drag and signed integer vertical wheel values -127, -1, 1, and 127 with fresh observations; live-safe stale-observation negative; fraction/zero/overflow remain fake/replay zero-call evidence.
- [ ] Physical keyboard press/chord/layout cases, stale-generation negative case, and post-action evidence.
- [ ] Reliable paste corpus at nominal ~91 source chars/s, including normalization and representative sizes; record original/normalized counts/hashes, elapsed time, terminal lifecycle, and target-visible verification without persisting text or frame bytes.
- [ ] Input release during inactive and active/uncertain state; prove paste cancelled, emitters joined, correlated generation receipt, and zero post-release HID.
- [ ] Inside the single canonical `power-three-semantic-actions` story, run three ordered/restored cases for `press_power`, `hold_power`, and `press_reset`; each case has active-extension/serial-ready preconditions, exact 200 ms/5 s/200 ms ON/OFF timing, serialized receipt, separately cached LED/video evidence, OFF-write unknown recovery, and baseline restoration. Do not create three story IDs or claim host-state change.
- [ ] Required live error rows that are safe to induce: permission/policy denial, capability missing where a controlled fake/config can prove the public behavior, busy/takeover, stale generation/observation, and reconnect recovery. Destructive transport fault races already proven by fake/replay remain linked evidence unless the manifest explicitly marks a safe live method.

After every story—including failure—the runner must release input, reconcile session state, restore the agreed host power/display baseline, and verify restoration. If outcome is unknown and baseline cannot be automatically proven, stop the suite, retain evidence, perform documented manual recovery while still holding the lease, and mark the run incomplete.

## Task 6.4: Finalize immutable evidence before releasing the lease

- [ ] Still inside the one lease, flush and validate every story record, timing series, sanitized replay capture, frame hash/dimensions, ATX indicator transition, restore result, and final device status.
- [ ] Manifest binds exact `C`, `G`, `T` SHA-256/package tree/lock/schema/story hashes, Node executable/version, browser executable/version, JetKVM firmware/app/running binary identity, device capability snapshot, evidence hashes, and PR/run IDs.
- [ ] Require zero skipped gating stories, zero failed restores, zero unresolved unknown outcomes, and no target identity, network topology, secret, URL, cookie, token, lease proof, SDP/ICE, screenshot bytes, or paste text in the manifest/artifacts.
- [ ] In the outer `finally`, stop child processes, run correlated input release, reconcile session/power baseline, flush final evidence, and only then release the lease. No device action occurs outside the lease.

## Task 6.5: Release PR, fresh review, remediation rule, and merge

- [ ] Open the release PR from `feat/jetkvm-mcp-hardware-release` to updated `main`. Body includes all §0.6 content plus `C/G/T`, Node/browser/firmware identities, story table and restore status, evidence links/hashes, complete matrix, six-deliverable audit, known risks, and rollback.
- [ ] Fresh reviewers who did not make the candidate perform: architecture/API divergence review; security/privacy/artifact review; full diff and branch-matrix review; and hardware evidence/restore review.
- [ ] Every reviewer reports P0-P3 findings and confidence with evidence/gaps. Zero P0/P1 is mandatory. A code/schema/doc/package fix invalidates `C/G/T` and triggers the new-candidate rule; evidence-only correction requires a new signed manifest and rerun of affected story validation.
- [ ] Required CI and the full Phase 5 hardware-free local gate remain green on the exact release head. The immutable hardware manifest validates against the exact tarball.
- [ ] Merge only when the resulting `main` tree contains exact candidate tree `G` without conflict edits. If the merge changes the candidate tree, stop and create/retest a new candidate.

## Task 6.6: Tag, publish, and clean-download verification

- [ ] Tag the exact released candidate commit `jetkvm-mcp-v0.1.0`.
- [ ] Create the semver GitHub release with exact tarball `T`, checksum, generated schemas, SBOM if produced, compatibility/setup/security/rollback notes, and immutable hardware manifest/evidence links.
- [ ] From a separate clean checkout and empty install directory, download the release tarball and checksum; verify hash; install under exact Node 22.23.1; run full package/schema/story/branch-matrix tests; run installed stdio and legacy SSE smokes; run README/examples; and confirm exactly ten tools.
- [ ] Confirm tag, source tree, tarball, lock, schemas, story manifest, Node, firmware evidence, and release manifest identities all match. Do not rebuild or substitute another tarball.

## Task 6.7: Six-deliverable audit

The release is incomplete unless all six deliverables are present and mutually consistent:

1. **Canonical architecture/advice record:** superseding design and this executable six-phase plan, with advisor decisions/divergences resolved.
2. **Installable public package:** deterministic semver tarball with stdio and legacy SSE only, public-first operator config, and no test fixtures/secrets.
3. **Exact typed API:** ten generated/packed/listed schemas and common result/error/idempotency contracts, with no aliases or removed capability.
4. **Complete verification system:** focused tests, Fake/Replay seams, protocol E2E, machine-readable behavioral branch matrix, and green CI/full local clean-checkout gates.
5. **Stranger-ready operator experience:** README, executable examples, security guidance, troubleshooting, clean-install proof, and recovery/rollback instructions.
6. **Immutable real-hardware evidence:** one-lease serialized story run, per-story restore, exact artifact/runtime/firmware binding, privacy-safe manifest, tag, release, and clean-download verification.

## Phase 6 final merge/release gate

- [ ] Advisor gate complete and release PR body complete.
- [ ] Zero unresolved P0/P1; every fresh reviewer records confidence and evidence.
- [ ] Required CI green; exact full local hardware-free gate green; immutable hardware story suite green with zero skips and verified restores.
- [ ] Clean-checkout download/install/full suite green against exact `T`.
- [ ] Six-deliverable audit passes with no mismatch.
- [ ] Merge, tag, and release identities match exactly.

---

## Plan self-review and acceptance crosswalk

| Acceptance requirement | Planned phase/gate |
|---|---|
| Preserve package/runtime/device lease/supervisor, Go quiesce, no-post-zero keyboard auto-release, and hardware-free Foundation CI | Phase 1 Tasks 1.2–1.5 |
| No old public handlers in Foundation | Phase 1 advisor/focused/PR gates |
| Public URL/auth; LAN/Tailscale/HTTPS; insecure HTTP opt-in; model never chooses credentials | Phase 2 Task 2.1, Phase 5 docs/security, protocol tests |
| Exact ten strict schemas and bounded timeouts | Phase 2 Task 2.2; Phase 4 production inventory; Phase 5/6 pack audits |
| Exact common envelopes, request-ID ledger, verification, retry, and next-step contract | §0.3, Phase 2 Tasks 2.2–2.3, canonical §11.2 matrix |
| One session-owned generation-fenced RPC channel, no second WebRTC | Phase 2 Task 2.5, Phase 3 display and Phase 4 session/power adapters |
| Explicit sessions independent of transports; no steal without takeover | Phase 2 foundation tests, Phase 4 session implementation/stories, Phase 6 live stories |
| stdio and legacy SSE only | Phase 2 Task 2.7, Phase 5 protocol/package scan, Phase 6 release audit |
| Browser frame/mouse/keyboard/~91 char/s paste/release | Phase 3 Tasks 3.2–3.7 and Phase 6 stories |
| Phase 3 display boundary: capture, status base success, per-fact freshness, and read-only EDID distinctions | Phase 3 Tasks 3.1, 3.3–3.4 and reviewed display stories |
| Semantic ATX only | Phase 4 Task 4.3 and the three cases inside canonical story `power-three-semantic-actions` |
| Sole complete behavior inventory with focused+story evidence | §0.4/canonical design §11.2 and Phase 5 branch matrix/E2E |
| Exact 24-story `AcceptanceStory` manifest with preconditions/steps/pass/evidence/restore | Phase 2 Task 2.6; Phases 3–6 execute the reviewed manifest |
| README/examples/troubleshooting and clean install | Phase 5 Tasks 5.5–5.7, Phase 6 clean-download verification |
| Component-to-phase documentation consistency | Phase 2 `docs:check`, rerun by Phases 3–6 and CI |
| Six independent branches/PRs with fresh reviews and merge gates | §0.6 and every phase PR gate |
| One serialized runtime-derived device lease on the protected operator target, per-story restore, no public topology | Phase 6 Tasks 6.2–6.4 |
| Immutable manifest bound to tarball/Node/firmware | Phase 6 Tasks 6.1, 6.4, 6.6 |
| Semver tag/release and six-deliverable audit | Phase 6 Tasks 6.6–6.7 |

### Resolved ambiguities

- “SSE” means the SDK 1.29.0 legacy HTTP/SSE pair (`GET /sse` plus per-session `POST /messages`), not a third or modern HTTP transport.
- “Public-first” means operator-selectable URL/auth/configuration with secure defaults; it does not mean anonymous public Internet exposure or a hard-coded cloud path.
- “Session” means an application-level JetKVM device session. stdio process lifetime and SSE transport session IDs are transport details only.
- “~91 char/s” is the nominal deterministic reliable-paste pacing target measured and reported by stories; correctness and exact normalized content remain the pass authority, not optimistic throughput.
- “Native display” means per-fact `cached_snapshot` (`getVideoState`) or `cached_event` (`videoInputState`) provenance/age. Base status succeeds without `edid_read`; unsupported, unavailable, verified/not-reported, and attempted-read failure are distinct. Proxy `streaming` is omitted and EDID remains read-only.
- “Power control” means serialized fixed 200 ms/5 s/200 ms serial press/release semantics plus separately qualified cached indicators. Serial acknowledgement and LED/video observations never claim the host OS or host power state changed.
- “Full local” in Phases 1–5 means all hardware-free repository, package, UI, adapter, fake/replay, protocol, story, docs, and clean-install gates. Phase 6 adds the serialized real-device story suite.
- The hardware target and lease key are protected runtime inputs. The runner derives the key from normalized target identity, and public evidence omits network topology.
