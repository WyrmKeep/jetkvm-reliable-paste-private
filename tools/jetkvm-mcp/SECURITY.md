# Security

Report suspected vulnerabilities privately through the repository owner's GitHub security-advisory channel. Do not include credentials, cookies, device URLs, lease proofs, screenshots, SDP/ICE data, paste text, or other target data in public issues or logs.

Device passwords and lease proof tokens are secrets. Except for the current-user-only `0600` proof file held for an active lease, keep them out of child environments, command output, persisted artifacts, shell tracing, crash reports, and source control. Restrict access to the account and host running the MCP package. A stale device lease must be removed only after its exact ownership proof and dead owner have both been independently established; never guess or steal a lease.

The package supports Node.js `>=22.23.1 <23`. Use a supported security-patched Node 22 release and preserve the browser sandbox when browser support is added.
