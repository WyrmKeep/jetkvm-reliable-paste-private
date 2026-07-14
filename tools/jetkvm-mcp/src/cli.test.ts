import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { JETKVM_TOOL_NAMES } from "./domain.js";
import type { HandlerRegistry } from "./mcp/server.js";
import type { ProductionRuntime } from "./runtime.js";
import {
  runJetKvmMcpCli,
  type CliDependencies,
} from "./cli.js";

function handlers(): HandlerRegistry {
  return Object.fromEntries(
    JETKVM_TOOL_NAMES.map((name) => [
      name,
      async () => ({ content: [{ type: "text" as const, text: name }] }),
    ]),
  ) as unknown as HandlerRegistry;
}

function runtime(close = vi.fn(async () => undefined)): ProductionRuntime {
  return {
    handlers: handlers(),
    close,
    activateLegacySseBearer: () => {
      throw new Error("Loopback SSE must not activate a bearer.");
    },
  } as unknown as ProductionRuntime;
}

describe("production CLI", () => {
  it("acquires a device-keyed lease before constructing the runtime", async () => {
    const calls: string[][] = [];
    const createRuntime = vi.fn(() => runtime());
    const result = await runJetKvmMcpCli(
      ["--target-url", "https://jetkvm.test"],
      {},
      {
        entryPath: "/installed/dist/bin.js",
        createRuntime,
        runLease: async (args) => {
          if (args === undefined) throw new Error("Missing lease arguments.");
          calls.push([...args]);
          return 23;
        },
      },
    );

    expect(result).toBe(23);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--device-key",
      expect.stringMatching(/^jetkvm-[a-f0-9]{64}$/),
      "--",
      process.execPath,
      "/installed/dist/bin.js",
      "--leased",
      "--target-url",
      "https://jetkvm.test",
    ]);
  });

  it("starts the first-party stdio server only after inherited proof validation", async () => {
    const closeRuntime = vi.fn(async () => undefined);
    const closeStdio = vi.fn(async () => undefined);
    const createRuntime = vi.fn(() => runtime(closeRuntime));
    const loadLeaseProof = vi.fn(async () => ({}) as never);
    const startStdioMock = vi.fn(async (registered: HandlerRegistry) => ({
      server: {},
      transport: {},
      closed: Promise.resolve(),
      close: closeStdio,
      isClosed: () => true,
      registered,
    }));
    const startStdio =
      startStdioMock as unknown as NonNullable<CliDependencies["startStdio"]>;

    const result = await runJetKvmMcpCli(
      ["--leased", "--target-url", "https://jetkvm.test"],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: "/secure/proof" },
      {
        createRuntime,
        loadLeaseProof,
        startStdio,
        waitForSignal: async () => "SIGTERM",
      },
    );

    expect(result).toBe(0);
    expect(loadLeaseProof).toHaveBeenCalledWith(
      "/secure/proof",
      expect.stringMatching(/^jetkvm-[a-f0-9]{64}$/),
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(startStdioMock).toHaveBeenCalledOnce();
    const registered = startStdioMock.mock.calls[0]?.[0] as HandlerRegistry;
    expect(Object.keys(registered).sort()).toEqual([...JETKVM_TOOL_NAMES].sort());
    expect(closeStdio).toHaveBeenCalled();
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("rejects an ambient lease proof unless the internal leased mode is explicit", async () => {
    const createRuntime = vi.fn(() => runtime());
    const loadLeaseProof = vi.fn(async () => ({}) as never);

    const result = await runJetKvmMcpCli(
      ["--target-url", "https://jetkvm.test"],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: "/secure/unrelated-proof" },
      { createRuntime, loadLeaseProof },
    );

    expect(result).toBe(1);
    expect(loadLeaseProof).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("starts explicit opt-in loopback SSE and closes every owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jetkvm-cli-test-"));
    const configPath = join(directory, "config.json");
    const closeRuntime = vi.fn(async () => undefined);
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          targetUrl: "https://jetkvm.test",
          legacySse: {
            enabled: true,
            scheme: "http",
            bindHost: "127.0.0.1",
            hostAuthorities: ["127.0.0.1"],
            allowPlaintextHttp: true,
          },
        }),
      );
      const result = await runJetKvmMcpCli(
        [
          "--leased",
          "--config",
          configPath,
          "--transport",
          "sse",
          "--port",
          "0",
        ],
        { JETKVM_DEVICE_LEASE_PROOF_PATH: "/secure/proof" },
        {
          createRuntime: () => runtime(closeRuntime),
          loadLeaseProof: async () => ({}) as never,
          waitForSignal: async () => "SIGTERM",
        },
      );
      expect(result).toBe(0);
      expect(closeRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
