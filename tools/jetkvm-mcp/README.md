# `@wyrmkeep/jetkvm-mcp`

Computer-use MCP server for one operator-configured JetKVM per process.

## Implementation status

The current `0.1.0` source tree contains the reviewed Phase 1 safety foundation, Phase 2 public contracts, the Phase 3 input/display implementation, and the Phase 4 power/session composition:

- the exact ten-tool catalogue and generated JSON Schemas;
- transport-independent application sessions, request-id ledger, and a generation-fenced `DeviceRpcAdapter`;
- capability-shaped browser/native interfaces plus deterministic test-only fake and sanitized replay seams;
- MCP SDK 1.29 stdio and opt-in legacy HTTP/SSE protocol adapters;
- a strict 24-story acceptance manifest with execution-produced focused-assertion gates;
- implemented display capture/status, mouse, physical keyboard, Reliable Paste, emergency input release, session, and power handlers; and
- a first-party CLI that creates the managed browser/native planes, validates the operator configuration before device contact, registers all ten handlers atomically, and serves MCP over stdio while a device-keyed lease is held.

The all-ten production registry and Phase 5 release gates are active. The package is a standalone `0.1.0` release candidate; only the separately leased live-hardware validation and publication/release steps remain.

The v0.1 catalogue is exactly:

1. `jetkvm_session_connect`
2. `jetkvm_session_status`
3. `jetkvm_session_reconnect`
4. `jetkvm_display_capture`
5. `jetkvm_display_status`
6. `jetkvm_input_mouse`
7. `jetkvm_input_keyboard`
8. `jetkvm_input_paste`
9. `jetkvm_input_release`
10. `jetkvm_power_control`

## Runtime

Node.js `>=22.23.1 <23` is supported. Repository development and release evidence use Node.js 22.23.1 exactly.

## Install from a clean checkout

From `tools/jetkvm-mcp`, install the exact lockfile, run the release checks, and install the executable:

```sh
npm ci
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run branch-matrix:check
npm run stories:e2e
npm run smoke:installed-stdio-protocol
npm install --global .
command -v jetkvm-mcp
```

Node.js 22.23.1 is required. Do not use `sudo npm install`: use a user-owned npm prefix or a Node version manager. After publication, `npm install --global @wyrmkeep/jetkvm-mcp@0.1.0` installs the same package artifact.

Create the credential file without putting the credential in shell history or process arguments:

```sh
./examples/create-credential-file.sh \
  "$HOME/.config/jetkvm-mcp/credential"
```

The helper reads without terminal echo, writes atomically, and leaves a current-user-only `0600` regular file. Then copy `examples/operator-config.json`, replace both example paths, and launch:

```sh
jetkvm-mcp --config "$HOME/.config/jetkvm-mcp/operator-config.json"
```

## Operator configuration

The JetKVM URL and credentials are process configuration. They never occur in a tool input or result, so a model cannot select a target or authenticate.

`parseOperatorConfig` accepts an explicit HTTPS URL supplied as `targetUrl` or `JETKVM_TARGET_URL`. LAN hostnames, LAN IPv4/IPv6 addresses, public names, and Tailscale-routed DNS names are treated equally; the package does not discover, require, or trust a particular network product. Plain HTTP is rejected unless `allowInsecureHttp` or `JETKVM_ALLOW_INSECURE_HTTP=true` is explicitly set; non-loopback HTTP additionally requires `allowDangerousTargetHttp` or `JETKVM_ALLOW_DANGEROUS_TARGET_HTTP=true`. System TLS validation remains mandatory for HTTPS. Embedded URL credentials, fragments, queries, malformed URLs, and non-HTTP schemes fail closed.

Supply the JetKVM credential through a current-user protected file (`credentialFile` or `JETKVM_CREDENTIAL_FILE`) or through the secret environment variable selected by `credentialEnvironmentVariable`/`JETKVM_CREDENTIAL_ENV` (default `JETKVM_CREDENTIAL`). The secret itself must not be placed in command-line arguments. Conflicting file and populated environment sources fail closed. File reads reject symlinks, non-regular files, wrong ownership, and group/other permissions; in-memory secret buffers are disposable and redacted.

Configuration is parsed before a browser, listener, transport output, or device contact. Structured diagnostics go to stderr and recursively redact URLs, credentials, bearer/cookie material, proofs, SDP/ICE, image/frame data, and paste/text payloads.

## MCP transports

Stdio is the default protocol boundary. `startStdioServer(handlerRegistry)` uses the SDK 1.29 stdio implementation; stdout is MCP frames only, while redacted diagnostics use stderr. The adapter accepts at most 2 MiB per newline-delimited input frame, bounds the aggregate accepted stdout queue to 16 MiB, and closes after 10 seconds of output backpressure. Normal EOF and explicit close perform idempotent cleanup and never exit the process or destroy stdin/stdout; injected or shared streams likewise never force exit or destroy their underlying streams. Output queue overflow or write timeout forces `exit(1)` only when the streams are exactly `process.stdin` and `process.stdout`, after idempotent close and a bounded stderr diagnostic flush, because Node pipe `WriteWrap` operations cannot be cancelled. MCP transport identities never own hardware or substitute for application `session_id` plus `session_generation`.

Legacy HTTP/SSE is a separate, explicit adapter, not a JetKVM endpoint. `LegacySseAdapter` serves `GET /sse` and `POST /messages`; the generated `sessionId` is a principal-bound routing key only. The security policy defaults to disabled, HTTPS, loopback binding, and exact loopback Host validation. Construct listeners only with `adapter.createHttpServer()` or `adapter.createHttpsServer(tlsOptions)`: these project-owned constructors set the header-check interval, freeze a 16 KiB strict HTTP-parser header cap, install an absolute TLS handshake deadline no later than the header deadline, and enforce an absolute per-connection request-header deadline from HTTP socket acceptance or completed TLS handshake and after each keep-alive response; `attachServer` fails closed for an unproven server. Plaintext requires `allowPlaintextHttp`, non-loopback plaintext also requires `allowDangerousNetworkPlaintext`, and each enabled plaintext listener emits exactly one fixed redacted stderr warning: `legacy SSE plaintext transport enabled`. Every non-loopback listener requires explicit exposure, an independent bearer credential, exact Host and Origin allowlists, anti-CSRF protection, and one raw Host, Origin, Authorization, and anti-CSRF header. Duplicate protected/framing headers and simultaneous Content-Length/Transfer-Encoding fail before routing or authentication. A missing Host is classified by middleware, preserving 401 for bearer failure and 403 after successful authentication. A global route-attempt ceiling runs first; authenticated global/principal stream and POST buckets remain in force, POST session buckets are scoped by principal plus routing key, and stable handler admission cannot be multiplied across streams. `Expect` handling is project-owned: both event forms consume the same single route attempt and complete Host/authentication/Origin/anti-CSRF admission before any interim bytes; only an admitted `POST` with `Expect: 100-continue` receives one 100 response, while other expectations receive a fixed 417. Every pre-body rejection sends `Connection: close` and destroys after flush. POST bodies are capped at 2 MiB, decoded with fatal UTF-8, grown geometrically, and reserved atomically under fixed 64 MiB adapter, 16 MiB principal, and 4 MiB SSE-session limits. Every original `IncomingMessage` chunk and every adapter-owned coalescing buffer is zeroed after consumption, replacement, or release, including over-limit and capacity-rejection paths. The default and minimum configured per-message response ceiling is 14 MiB; queued responses are reserved atomically under fixed 64 MiB adapter, 16 MiB principal, and 16 MiB stream limits and released on callback, drain, close, or error. Adapter close destroys active POST sockets, aborts body reads and stream handlers, and awaits reservation cleanup.

V0.1 deliberately supports stdio plus legacy SSE only. Project-owned Streamable HTTP is out of scope pending a separate design and security review.

## Standalone CLI

Build the package, configure one target and one credential source, then launch the stdio server:

```sh
export JETKVM_TARGET_URL='https://jetkvm.example'
export JETKVM_CREDENTIAL_ENV='JETKVM_CREDENTIAL'
export JETKVM_CREDENTIAL='operator-secret'
npm run build
node dist/bin.js
```

The installed `jetkvm-mcp` executable invokes the same entry point. Startup acquires a private device-keyed lease before constructing Chromium or contacting the target. A second process for the same target fails closed. Inherited proof is accepted only in the internal `--leased` child mode, and the proof's cryptographic lease path must match the configured target fingerprint. The detached lease supervisor and CLI remain attached to inherited stdio for the lifetime of the MCP transport; EOF closes the server, browser, and lease in bounded order. Startup errors are redacted and emitted only on stderr.

By default, managed Chromium is headless and uses an ephemeral profile. `JETKVM_HEADLESS=false` makes the browser visible. `JETKVM_CHROMIUM_EXECUTABLE_PATH` selects an explicit Chromium-family executable by absolute path. Each tool call's bounded `timeout_ms` covers browser admission and execution. Plain LAN HTTP requires both `JETKVM_ALLOW_INSECURE_HTTP=true` and `JETKVM_ALLOW_DANGEROUS_TARGET_HTTP=true`. With that explicit opt-in, Chromium treats only the configured HTTP target origin as a secure context so frame hashing remains available; this enables secure-context browser APIs for that origin but does not secure or encrypt the HTTP transport.

## MCP client configuration

`examples/claude-desktop.json` is a complete stdio server entry. Copy its `jetkvm` object into the client's `mcpServers` object, replace the URL and absolute credential path, and replace `jetkvm-mcp` with the absolute output of `command -v jetkvm-mcp` when a GUI client does not inherit the login-shell `PATH`:

```json
{
  "mcpServers": {
    "jetkvm": {
      "command": "jetkvm-mcp",
      "args": [],
      "env": {
        "JETKVM_TARGET_URL": "https://jetkvm.example",
        "JETKVM_CREDENTIAL_FILE": "/Users/you/.config/jetkvm-mcp/credential"
      }
    }
  }
}
```

The client must launch one server process per JetKVM target. Keep the credential in the protected file; do not add `JETKVM_CREDENTIAL`, bearer values, cookies, lease proofs, or the credential itself to a checked-in client configuration. `examples/run-stdio.sh` is an executable environment-driven alternative:

```sh
export JETKVM_TARGET_URL='https://jetkvm.example'
export JETKVM_CREDENTIAL_FILE="$HOME/.config/jetkvm-mcp/credential"
exec ./examples/run-stdio.sh
```

Device leases use a stable per-user state directory across reboots: `~/Library/Application Support/jetkvm-mcp/device-leases` on macOS, `%LOCALAPPDATA%\jetkvm-mcp\device-leases` on Windows, and `$XDG_STATE_HOME/jetkvm-mcp/device-leases` or `~/.local/state/jetkvm-mcp/device-leases` on other systems. Set `JETKVM_DEVICE_LEASE_DIRECTORY` to an absolute private directory when an operator-managed location is required; use the same value for normal launch and retained-lease recovery.

The wrapper requires HTTPS and an absolute regular credential file, removes ambient credential-value variables, and passes no secret or target argument on the command line. `npm run examples:check` parses the JSON examples, syntax-checks both shell examples, creates and inspects a real `0600` credential file, and executes `run-stdio.sh` against a probe executable.

## Phase 3 input and display semantics

`jetkvm_display_capture` returns a fresh frame, an opaque observation ID, immutable source and rendered geometry, and exactly one authorized image content block. Coordinates are interpreted against the source image geometry recorded by the fresh single-use observation; absolute mouse input must present that observation, and reconnect, age, consumption, or a display-generation change invalidates it. Coordinates are never guessed from a browser viewport or a later frame.

Physical keyboard actions accept canonical physical keys only. Key presses, key down/up, and chords model physical state; arbitrary text fields are rejected. Use `jetkvm_input_paste` for text. Reliable Paste follows the existing product paste path at a nominal ~91 source characters per second, reports normalized byte/hash evidence, and separates acceptance/progress from its correlated terminal event. A successful terminal means the correlated producer completed; it is not proof that the target application accepted or interpreted the text.

Release is the recovery primitive for held or uncertain input. After an unknown mutation, the safe sequence is inspect, release, reconnect, and fresh capture; automatic replay is forbidden. `jetkvm_input_release` closes the mutation gate, stops and joins Reliable Paste and other producers, drains the generation, and verifies zero keyboard and pointer state before recovery proceeds.

Display status has per-fact provenance: signal, native resolution, and FPS each carry their own observation time, age, freshness, and source. A valid device event produces `cached_event`; before any valid event the source is `none`, values are null or `unknown`, and a validation-only poll never fabricates a snapshot or resets event age. Browser-rendered geometry, native source resolution, and freshness are correlated observations, not interchangeable facts.

EDID is read-only EDID. Without the capability it is `unsupported` with no read attempt; a completed successful empty read is `unavailable`; returned data is `available`; and an attempted lower-layer failure is `EDID_READ_FAILED`. There is no EDID mutation tool. Image bytes remain only in the authorized MCP image content block, paste text is never retained, and the managed browser runs with its sandbox and artifact recorders preserved.

## Phase 4 session and power semantics

`jetkvm_session_connect` establishes the authenticated browser/WebRTC control channel, qualifies browser/HID/video observations, and performs an actual native display-state read through that connection's exact shared `DeviceRpcAdapter` binding before reporting `device_state_verified`. A failed native post-read after an opened connection preserves the usable connection with `device_ack_only` verification and conservative capabilities rather than closing a valid channel. Reconnect invalidates the old adapter before replacement begins, drains the old generation, releases input, closes the old channel, opens and qualifies a successor, and requires a fresh display capture.

`jetkvm_session_status` composes ownership, browser, native, capability, and version facts without inventing a unified health field. Missing `session.status` permission or capability fails before any browser/native probe. Per-fact display provenance remains explicit.

`jetkvm_power_control` exposes only `press_power`, `hold_power`, and `press_reset`. Wire timing is fixed at 200 ms, 5 s, and 200 ms respectively; callers cannot supply a duration. ATX extension state, serial availability, acknowledgement, and post-read evidence remain distinct. A definitive acknowledgement followed by an unavailable post-read returns `applied` with `device_ack_only`; it is never replayed. Cancellation or deadline expiry before the wire call releases the request reservation and reports `not_sent`.

## Frozen candidate and serialized hardware release

The live hardware gate runs only from a clean commit, an exact Node.js 22.23.1 executable, and a visible sandboxed Chromium executable. The focused handler gates produce deterministic request/response trace reports for every controlled live branch; generate controlled evidence from those execution-produced preimages before freezing so the candidate manifest can bind its exact file bytes:

Candidate freeze defaults to the `full` hardware-validation profile. `full` forbids an exception acknowledgement, requires the ATX reset preflight, and must execute every canonical live step with zero skips. If and only if the selected fixture has no usable JetKVM ATX motherboard leads, freeze a source-bound `atx_unavailable` candidate by setting both exact values before running `freeze-release-candidate.mjs`:

```sh
export JETKVM_RELEASE_HARDWARE_PROFILE='atx_unavailable'
export JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT='selected_fixture_has_no_usable_atx_motherboard_leads'
```

The acknowledgement is not a runtime bypass. It becomes an immutable candidate field with exception code `ATX_WIRING_UNAVAILABLE`; changing or omitting either value invalidates the candidate. Do not set the acknowledgement for `full`.

```sh
export RELEASE_ROOT='/absolute/private/release-root'
export JETKVM_RELEASE_BROWSER_EXECUTABLE_PATH='/absolute/path/to/Google Chrome'
export JETKVM_RELEASE_TARGET_URL='http://jetkvm.example'
export JETKVM_RELEASE_CONTROLLED_EVIDENCE="$RELEASE_ROOT/controlled-evidence.json"

npm run build
node scripts/build-controlled-release-evidence.mjs \
  --output "$JETKVM_RELEASE_CONTROLLED_EVIDENCE"
node scripts/freeze-release-candidate.mjs \
  --output "$RELEASE_ROOT/candidate"
```

The freeze fails on a dirty source tree. It rebuilds and binds the generated paste-harness runtime before packing. Its immutable output contains `candidate.json`, `candidate.sha256`, the package tarball, `controlled-evidence.json`, `consumer-package.json`, `consumer-package-lock.json`, and the generated `paste-harness/` runtime loaded by the live runner. The candidate binds the hardware-validation profile alongside the source commit/tree, source lock, paste-harness runtime, all story and schema files, generated reports, controlled evidence, exact Node/browser/target identity, package tarball and unpacked package tree, normalized production dependency resolution, and every regular file in the installed `node_modules` closure. Generated `node_modules/.bin` symlinks are excluded and never invoked. Freeze itself generates the portable consumer lock, proves its production resolution equals the reviewed source lock, and installs it with `npm ci --ignore-scripts --omit=dev`.

Install only with the shipped consumer lock; an unlocked `npm install` is not release evidence:

```sh
export CANDIDATE="$RELEASE_ROOT/candidate"
export INSTALL_ROOT="$RELEASE_ROOT/installed"
mkdir -m 700 "$INSTALL_ROOT"
cp "$CANDIDATE/consumer-package.json" "$INSTALL_ROOT/package.json"
cp "$CANDIDATE/consumer-package-lock.json" "$INSTALL_ROOT/package-lock.json"
cp "$CANDIDATE/"*.tgz "$INSTALL_ROOT/"
(cd "$INSTALL_ROOT" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund)
export JETKVM_RELEASE_INSTALLED_PACKAGE="$INSTALL_ROOT/node_modules/@wyrmkeep/jetkvm-mcp"
```

Build the device application and target-side Go tests on GitHub's native `linux/amd64` runner from the exact frozen commit. The workflow emits `jetkvm_app`, `device-tests.tar.gz`, and a strict provenance sidecar binding both artifacts' SHA-256 digests to `GITHUB_SHA`, the repository, workflow ref, run ID, and attempt. Select the run by both branch and commit; never use an artifact selected only by recency:

```sh
export RELEASE_COMMIT="$(git rev-parse HEAD)"
export RELEASE_BRANCH="$(git branch --show-current)"
gh workflow run build.yml --ref "$RELEASE_BRANCH"
export BUILD_RUN_ID="$(
  gh run list \
    --workflow build.yml \
    --branch "$RELEASE_BRANCH" \
    --commit "$RELEASE_COMMIT" \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"
test -n "$BUILD_RUN_ID"
gh run watch "$BUILD_RUN_ID" --compact --exit-status

export DEVICE_ARTIFACT="$RELEASE_ROOT/device-artifact"
mkdir -m 0700 "$DEVICE_ARTIFACT"
gh run download "$BUILD_RUN_ID" \
  --name jetkvm-app \
  --dir "$DEVICE_ARTIFACT"
chmod 0500 "$DEVICE_ARTIFACT/bin/jetkvm_app"
chmod 0400 "$DEVICE_ARTIFACT/device-tests.tar.gz"
chmod 0400 "$DEVICE_ARTIFACT/device-binary-provenance.json"
export JETKVM_RELEASE_DEVICE_BINARY="$DEVICE_ARTIFACT/bin/jetkvm_app"
export JETKVM_RELEASE_DEVICE_BINARY_SHA256="$(
  shasum -a 256 "$JETKVM_RELEASE_DEVICE_BINARY" | awk '{print $1}'
)"
export JETKVM_RELEASE_DEVICE_TESTS="$DEVICE_ARTIFACT/device-tests.tar.gz"
export JETKVM_RELEASE_DEVICE_TESTS_SHA256="$(
  shasum -a 256 "$JETKVM_RELEASE_DEVICE_TESTS" | awk '{print $1}'
)"
export JETKVM_RELEASE_DEVICE_PROVENANCE="$DEVICE_ARTIFACT/device-binary-provenance.json"
export JETKVM_RELEASE_DEVICE_PROVENANCE_SHA256="$(
  shasum -a 256 "$JETKVM_RELEASE_DEVICE_PROVENANCE" | awk '{print $1}'
)"
```

The target-side test archive is provenance-bound to the same CI run and executes directly on the JetKVM; the release path never cross-compiles it under host emulation. The reviewed digest is passed independently to the device, which verifies the uploaded archive immediately before extraction and execution. Upload and extraction use a preflighted owner-only workspace under `/userdata`, not the RAM-backed `/tmp`; every success, test failure, and upload failure removes that workspace before returning. Compiled source-contract regressions run from their original package-relative working directory against the exact referenced source fixtures carried in that same provenance-bound archive.

Before device contact, the live runner requires the same clean commit/tree, validates the inherited proof against the exact configured-device fingerprint, verifies the device artifact and provenance-sidecar checksums, requires the trusted `build.yml` run to name the frozen commit, independently checks the Go binary's embedded revision, re-hashes the reviewed source lock and generated paste-harness runtime, re-hashes both shipped consumer files, the installed package, every installed dependency, the candidate tarball, controlled evidence, and the executing runtime, and loads the MCP SDK only from that verified installed closure. Run the complete gate under one device-keyed lease. The evidence root must already be an owner-only directory, and the new output directory must resolve beneath it without symlink escape; the rig environment file must also be owner-only. `DEVICE_KEY` must exactly equal the production runtime's `jetkvm-`-prefixed SHA-256 fingerprint of the configured target URL; the installed MCP refuses any other inherited lease:

```sh
export DEVICE_KEY="$(
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    process.stdout.write(
      `jetkvm-${createHash("sha256").update(process.argv[1]).digest("hex")}`,
    );
  ' "$JETKVM_RELEASE_TARGET_URL"
)"
export JETKVM_RELEASE_CANDIDATE="$CANDIDATE/candidate.json"
export JETKVM_RELEASE_CANDIDATE_SHA256="$(
  awk '{print $1}' "$CANDIDATE/candidate.sha256"
)"
export JETKVM_RELEASE_CONTROLLED_EVIDENCE="$CANDIDATE/controlled-evidence.json"
export JETKVM_RELEASE_EVIDENCE_ROOT="$RELEASE_ROOT"
export JETKVM_RELEASE_EVIDENCE_DIR="$RELEASE_ROOT/hardware-evidence"
export JETKVM_RELEASE_RIG_ENV='/absolute/private/rig.env'

node "$JETKVM_RELEASE_INSTALLED_PACKAGE/dist/deviceLeaseRunner.js" \
  --device-key "$DEVICE_KEY" \
  --retain-on-exit-code 75 \
  -- \
  "$(command -v node)" scripts/run-live-hardware-release.mjs
```

The run validates the pre-deployment device-test artifact, every controlled branch's execution-produced request/response preimage, every canonical live story and restore, fresh session reconnects and image captures at baseline boundaries, a fresh-transport reconnect/release, the final producer-zero release, the original safe device/fixture baseline, the promoted device binary hash, and bounded MCP shutdown. Under `full`, it also requires the ATX preflight and every live step to pass. Under `atx_unavailable`, it derives the exact 17 ATX-wiring-dependent `(story_id, step_id)` pairs from the canonical validated plan, records those steps only as `excluded`, continues every mixed story and all non-ATX steps, and still requires every restore and baseline comparison to pass. The successful result is `pass_with_exception`, with the exact reason and excluded pairs sealed in `hardware-exception.json`; `atx_preflight_sha256` must be null. Any missing non-ATX step, extra skip, changed classification, failed restore, unknown result, profile mismatch, or exception-hash mismatch blocks release. SSH failure alone is never treated as proof that the host is off; automatic power restoration requires a fresh post-action physical ATX power-LED observation. Each live evidence record persists its scrubbed structured MCP preimages and exact image digests, so the validator recomputes every evidence hash instead of trusting an uncheckable digest. Its summary records the final verified profile, source, installation, runtime, device, deployment, and test identities. `finalization.json` is flushed before the evidence manifest. The validator enforces the profile-specific file inventory, requires an exact one-line checksum sidecar, and scans every raw manifested file for private material before tagging or publishing. Release notes for an `atx_unavailable` candidate must state that physical ATX switching was not validated on the selected fixture and must not translate controlled serial/acknowledgement evidence into a host-state claim.

```sh
node scripts/validate-hardware-release-evidence.mjs \
  "$JETKVM_RELEASE_EVIDENCE_DIR" \
  "$JETKVM_RELEASE_CANDIDATE"
```

If the final baseline is unproven, the child exits with code 75 and the outer wrapper intentionally retains the device lease; a retention-enabled run interrupted by `SIGHUP`, `SIGINT`, or `SIGTERM` also retains it. The wrapper itself reports failure because cleanup was refused. Inspect `finalization.json` `failure_stages`, manually restore and verify the physical host, display, UK layout, lock keys, held input, ATX state, browser fixture, running revision, and deployed binary, and ensure the failed holder has exited. Only then clear the retained lease through the safety-checked installed command:

```sh
npm --prefix "$JETKVM_RELEASE_INSTALLED_PACKAGE" \
  run device-lease:remove-stale -- \
  --device-key "$DEVICE_KEY" --confirm-recovered
```

Recovery refuses a different host, a live owner PID, a live supervisor process group, changed lease records, or an unsafe lease directory. Never delete lease files directly.

## Contract and protocol checks

From this directory:

```sh
npm ci
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm test
npm run stories:validate
npm run branch-matrix:check
npm run stories:e2e
npm run typecheck
npm run build
npm run schemas:check
npm run docs:check
npm run examples:check
npm run smoke:installed-contracts
npm run smoke:installed-stdio-protocol
npm run smoke:installed-sse-protocol
npm run smoke:installed-first-party
npm run package:check
```

The generated `reports/branch-matrix.json` resolves all 320 reviewed requirement/tool cells (193 applicable and 127 explicitly reviewed non-applicable) to exact passing focused-test identities. `reports/story-e2e.json` records 24 success scenarios plus 229 declared fault scenarios, all 253 passing, with 5,946 source-step and 1,450 mandatory restore-step executions. Both check commands regenerate evidence from fresh Vitest JSON and byte-compare it with the committed reports; source-name-only matching, skipped/todo tests, failures, duplicate assertion IDs, missing cells, and stale report files fail closed.

The installed smokes pack and install the tarball in a clean temporary directory. The stdio protocol E2E verifies the exact ten names and generated input/output schemas, invokes every valid handler, proves strict unknown-property rejection before handler execution, probes exception redaction, cancels an in-flight request, recovers after a malformed frame, accepts a near-limit legal frame, and confirms bounded EOF/no-reader closure. The first-party smoke launches the installed executable with a deterministic managed-browser/native fixture, verifies all ten production tools, calls session connect and display capture over real stdio, validates the returned image, and confirms bounded shutdown. Production output excludes `src/test-support`.

## Troubleshooting

| Symptom or code                                                                                                          | Meaning                                                                                                                                        | Action                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup emits `startup_failed` on stderr                                                                                 | Configuration, credential-file ownership/mode, browser selection, or target URL failed before MCP startup. Details are intentionally redacted. | Run `npm run examples:check`; verify Node 22.23.1, an HTTPS URL without query/fragment/embedded credentials, an absolute current-user-owned `0600` regular credential file, and a Chromium-family executable. |
| `DEVICE_LEASE_BUSY`                                                                                                      | Another process or cleanup transaction owns the same normalized target.                                                                        | Stop the existing server and wait for bounded cleanup. Never delete lease files manually. Use the administrative cleanup API only when owner death is independently proven.                                   |
| `AUTH_FAILED`, `AUTH_EXPIRED`, or `AUTH_RATE_LIMITED`                                                                    | JetKVM authentication failed or is throttled.                                                                                                  | Correct/rotate the credential or wait for the rate limit, then call `jetkvm_session_connect`. Do not log or paste the credential into a tool call.                                                            |
| `PERMISSION_DENIED` or `CAPABILITY_MISSING`                                                                              | The exact permission/capability in `error.details` is absent. No downstream device write occurred.                                             | Grant the reported permission or enable/update the reported capability; then retry only if `safe_to_retry` is true.                                                                                           |
| `SESSION_NOT_FOUND`, `STALE_SESSION_GENERATION`, `SESSION_DRAINED`, or `SESSION_TAKEN_OVER`                              | The application session/generation is no longer current. Transport reconnection alone does not repair it.                                      | Follow `required_next_step`; normally reconnect the application session and take a fresh capture before further input.                                                                                        |
| `STALE_OBSERVATION`, `OBSERVATION_CONSUMED`, or `DISPLAY_CHANGED`                                                        | The coordinate observation is old, already used, or belongs to prior display geometry.                                                         | Capture a fresh frame and use its new observation once. Never reuse or scale the old coordinates.                                                                                                             |
| `CONNECTION_LOST`, `MUTATION_OUTCOME_UNKNOWN`, `PASTE_FAILED`, `PASTE_CANCELLED`, or `EVENT_GAP` with `outcome: unknown` | A write may have reached the device; replay could duplicate input or power action.                                                             | Do not retry automatically. Inspect device state, release input, reconnect, and capture before deciding whether a new request is safe. Use a new request ID only for a genuinely new intended action.         |
| GUI client reports “command not found”                                                                                   | GUI clients often lack the interactive shell `PATH`.                                                                                           | Put the absolute `command -v jetkvm-mcp` result in the client configuration and restart the client.                                                                                                           |
| Stdio client hangs during shutdown                                                                                       | The client still owns stdin or is not reading stdout.                                                                                          | Close the client pipe and keep reading until EOF. The server bounds normal backpressure at 10 seconds; the installed no-reader smoke covers the forced-failure path.                                          |

## Device lease wrapper

Device-affecting commands and later live-hardware tests must run through the device-keyed lease wrapper:

```sh
npm run device-lease:run -- --device-key "$DEVICE_KEY" -- command arg...
```

The wrapper and detached supervisor hold the lease until the tracked command group has completed or bounded cleanup has been acknowledged. Descendants must remain in the inherited process group; deliberate `setsid` or double-fork escapes are outside the contract.

## License

GPL-2.0-only. See `LICENSE`.
