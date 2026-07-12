# `@wyrmkeep/jetkvm-mcp`

Production package boundary for the JetKVM computer-use MCP server.

This package currently defines the shared computer-use domain, failure, runtime-policy, and exclusive device-lease contracts. The public MCP executable and its five tool registrations are not included in this scaffold.

## Runtime

Node.js `>=22.23.1 <23` is supported. Repository development and release evidence use Node.js 22.23.1 exactly.

## Device lease wrapper

Run a device-affecting command under one device-keyed process lease:

```sh
npm run device-lease:run -- --device-key "$DEVICE_KEY" -- command arg...
```

The wrapper holds the lease until the child exits and forwards termination signals. A nested child receives only the path of the current-user-only `0600` proof file; the raw proof token is never added to its environment or output.

## License

GPL-2.0-only. See `LICENSE`.
