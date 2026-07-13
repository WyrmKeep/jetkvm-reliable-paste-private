# `@wyrmkeep/jetkvm-mcp`

Production package boundary for the JetKVM computer-use MCP server.

This package currently defines the shared computer-use domain, failure, runtime-policy, and exclusive device-lease contracts. The public MCP executable and its ten-tool catalogue are implemented in later reviewed phases.

## Runtime

Node.js `>=22.23.1 <23` is supported. Repository development and release evidence use Node.js 22.23.1 exactly.

## Device lease wrapper

Run a device-affecting command under one device-keyed process lease:

```sh
npm run device-lease:run -- --device-key "$DEVICE_KEY" -- command arg...
```

The wrapper creates a detached external POSIX supervisor and a distinct detached command-group leader before acquisition, records the supervisor PID, command PGID, and private liveness identity in the initial lease record, and proves the command group is empty before release. Both shutdown paths escalate from `SIGTERM` to `SIGKILL` after a bounded grace period and wait for the command PGID to reach `ESRCH`. Abrupt wrapper or supervisor death therefore cannot release the lease over a live command group, and stale cleanup remains fail-closed while that group exists. Descendants must remain in the inherited process group: deliberate `setsid` or double-fork escapes are outside this contract and must not be used for device-affecting commands. Non-POSIX control hosts fail closed. A nested child receives only the path of the current-user-only `0600` proof file; the raw proof token is never added to its environment or output.

## License

GPL-2.0-only. See `LICENSE`.
