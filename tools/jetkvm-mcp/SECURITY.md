# Security

Report suspected vulnerabilities privately through the repository owner's GitHub security-advisory channel. Do not include credentials, cookies, device URLs, lease proofs, screenshots, SDP/ICE data, paste text, or other target data in public issues or logs.

Device passwords and lease proof tokens are secrets. Except for the current-user-only `0600` proof file held for an active lease, keep them out of child environments, command output, persisted artifacts, shell tracing, crash reports, and source control. Restrict access to the account and host running the MCP package. A stale device lease must be removed only after its exact ownership proof and dead owner have both been independently established; never guess or steal a lease.

An orphaned device-keyed `.admin.lock.cleanup.claim` intentionally blocks acquisition after a cleaner crash. Never remove it automatically: inspect its `0600` owner/run/host/PID/time record, independently prove that cleaner dead, and remove only that exact claim file before retrying administrative cleanup.

The package supports Node.js `>=22.23.1 <23`. Use a supported security-patched Node 22 release and preserve the browser sandbox for the managed product page. Do not disable Chromium sandboxing to make local or CI tests pass.

## Phase 3 browser and payload privacy

Capture bytes may appear only in the authorized MCP image content block returned to the authorized caller. The structured observation, request ledger, fake and sanitized replay tapes, logs, errors, traces, release evidence, and retained Playwright fixture state may contain only allowlisted metadata such as opaque IDs, dimensions, byte counts, hashes, timings, outcomes, and verification. Playwright tracing, video, and screenshots remain disabled for the acceptance fixture. Never persist target pixels, base64 image data, page contents, cookies, authorization headers, SDP/ICE, device URLs, or serial-like EDID values.

Reliable paste text is ephemeral: normalize, hash, count, and transmit it only through the existing product paste path, then release references. Do not place paste text or normalized text in request-ledger terminals, lifecycle events, fake/replay tapes, structured diagnostics, exception messages, traces, screenshots, or release evidence. A paste terminal proves correlated producer completion, not target-application acceptance.

Mouse and keyboard input require a fresh generation-bound observation. On uncertain dispatch, do not replay automatically; inspect state, run generation-correlated release, reconnect, and capture again. Release must stop and join active producers and prove zero keyboard and pointer state before a new generation may mutate.
