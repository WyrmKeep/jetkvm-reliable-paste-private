# `@wyrmkeep/jetkvm-mcp`

Computer-use MCP server for one operator-configured JetKVM per process.

## Implementation status

The current `0.1.0` source tree contains the reviewed Phase 1 safety foundation and Phase 2 public contracts:

- the exact ten-tool catalogue and generated JSON Schemas;
- transport-independent application sessions, request-id ledger, and a generation-fenced `DeviceRpcAdapter`;
- capability-shaped browser/native interfaces plus deterministic test-only fake and replay seams;
- MCP SDK 1.29 stdio and opt-in legacy HTTP/SSE protocol adapters; and
- a strict 24-story acceptance manifest.

Production tool handlers are intentionally inactive: `createMcpServer({})` lists no tools, and a registry must be either empty or contain all ten complete handlers. Device control arrives in the later input/display and power/session phases. This package is therefore not yet a standalone usable release, and it has no public CLI entry point.

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

## Operator configuration

The JetKVM URL and credentials are process configuration. They never occur in a tool input or result, so a model cannot select a target or authenticate.

`parseOperatorConfig` accepts an explicit HTTPS URL supplied as `targetUrl` or `JETKVM_TARGET_URL`. LAN hostnames, LAN IPv4/IPv6 addresses, public names, and Tailscale-routed DNS names are treated equally; the package does not discover, require, or trust a particular network product. Plain HTTP is rejected unless `allowInsecureHttp` or `JETKVM_ALLOW_INSECURE_HTTP=true` is explicitly set; non-loopback HTTP additionally requires `allowDangerousTargetHttp` or `JETKVM_ALLOW_DANGEROUS_TARGET_HTTP=true`. System TLS validation remains mandatory for HTTPS. Embedded URL credentials, fragments, queries, malformed URLs, and non-HTTP schemes fail closed.

Supply the JetKVM credential through a current-user protected file (`credentialFile` or `JETKVM_CREDENTIAL_FILE`) or through the secret environment variable selected by `credentialEnvironmentVariable`/`JETKVM_CREDENTIAL_ENV` (default `JETKVM_CREDENTIAL`). The secret itself must not be placed in command-line arguments. Conflicting file and populated environment sources fail closed. File reads reject symlinks, non-regular files, wrong ownership, and group/other permissions; in-memory secret buffers are disposable and redacted.

Configuration is parsed before a browser, listener, transport output, or device contact. Structured diagnostics go to stderr and recursively redact URLs, credentials, bearer/cookie material, proofs, SDP/ICE, image/frame data, and paste/text payloads.

## MCP transports

Stdio is the default protocol boundary. `startStdioServer(handlerRegistry)` uses the SDK 1.29 stdio implementation; stdout is MCP frames only, while redacted diagnostics use stderr. The adapter accepts at most 2 MiB per newline-delimited input frame, bounds the aggregate accepted stdout queue to 16 MiB, and closes after 10 seconds of output backpressure. Normal EOF and explicit close perform idempotent cleanup and never exit the process or destroy stdin/stdout; injected or shared streams likewise never force exit or destroy their underlying streams. Output queue overflow or write timeout forces `exit(1)` only when the streams are exactly `process.stdin` and `process.stdout`, after idempotent close and a bounded stderr diagnostic flush, because Node pipe `WriteWrap` operations cannot be cancelled. MCP transport identities never own hardware or substitute for application `session_id` plus `session_generation`.

Legacy HTTP/SSE is a separate, explicit adapter, not a JetKVM endpoint. `LegacySseAdapter` serves `GET /sse` and `POST /messages`; the generated `sessionId` is a principal-bound routing key only. The security policy defaults to disabled, HTTPS, loopback binding, and exact loopback Host validation. Construct listeners only with `adapter.createHttpServer()` or `adapter.createHttpsServer(tlsOptions)`: these project-owned constructors set the header-check interval, freeze a 16 KiB strict HTTP-parser header cap, and install an absolute TLS handshake deadline no later than the header deadline; `attachServer` fails closed for an unproven server. Plaintext requires `allowPlaintextHttp`, non-loopback plaintext also requires `allowDangerousNetworkPlaintext`, and each enabled plaintext listener emits exactly one fixed redacted stderr warning: `legacy SSE plaintext transport enabled`. Every non-loopback listener requires explicit exposure, an independent bearer credential, exact Host and Origin allowlists, anti-CSRF protection, and one raw Host, Origin, Authorization, and anti-CSRF header. Duplicate protected/framing headers and simultaneous Content-Length/Transfer-Encoding fail before routing or authentication. A global route-attempt ceiling runs first; authenticated stream and POST buckets remain in force, and stable handler admission cannot be multiplied across streams. Every pre-body rejection sends `Connection: close` and destroys after flush. POST bodies are capped at 2 MiB, decoded with fatal UTF-8, grown geometrically, and reserved atomically under fixed 64 MiB adapter, 16 MiB principal, and 4 MiB SSE-session limits. The default and minimum configured per-message response ceiling is 14 MiB; queued responses are reserved atomically under fixed 64 MiB adapter, 16 MiB principal, and 16 MiB stream limits and released on callback, drain, close, or error. Adapter close destroys active POST sockets, aborts body reads and stream handlers, and awaits reservation cleanup.

V0.1 deliberately supports stdio plus legacy SSE only. Project-owned Streamable HTTP is out of scope pending a separate design and security review.

## Contract and protocol checks

From this directory:

```sh
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

The installed smokes pack and install the tarball in a clean temporary directory. They use external deterministic handlers only; production output excludes `src/test-support`.

## Device lease wrapper

Device-affecting commands and later live-hardware tests must run through the device-keyed lease wrapper:

```sh
npm run device-lease:run -- --device-key "$DEVICE_KEY" -- command arg...
```

The wrapper and detached supervisor hold the lease until the tracked command group has completed or bounded cleanup has been acknowledged. Descendants must remain in the inherited process group; deliberate `setsid` or double-fork escapes are outside the contract.

## License

GPL-2.0-only. See `LICENSE`.
