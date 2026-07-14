import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BrowserControllerPort } from "./browser/BrowserController.js";
import type { AutomationSnapshot } from "./browser/bridgeProtocol.js";
import { parseOperatorConfig } from "./config.js";
import { JETKVM_TOOL_NAMES } from "./domain.js";
import {
  DeviceRpcError,
  type Deadline,
  type DeviceRpcAdapter,
} from "./device/DeviceRpcAdapter.js";
import type { BrowserConnection } from "./planes/BrowserPlane.js";
import {
  createProductionRuntime,
  qualifyConnectionCapabilities,
} from "./runtime.js";

async function withCredentialFile<T>(operation: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-runtime-test-"));
  const path = join(directory, "credential");
  try {
    await writeFile(path, "test-only-password\n", { mode: 0o600 });
    await chmod(directory, 0o700);
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const DEADLINE: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const SNAPSHOT: AutomationSnapshot = {
  version: 1,
  state: "ready",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  dispatch_generation: 5,
  rpc_ready: true,
  hid_ready: true,
  video_ready: true,
  absolute_pointer: true,
  scroll_throttling_disabled: true,
  keyboard_layout: "en-US",
  reliable_paste: true,
  source_width: 1920,
  source_height: 1080,
};

describe("production runtime", () => {
  it("assembles all handlers over one browser-owned device adapter without launching", async () => {
    await withCredentialFile(async (credentialFile) => {
      const config = parseOperatorConfig({
        targetUrl: "https://jetkvm.test",
        credentialFile,
      });
      const runtime = createProductionRuntime(config);
      expect(Object.keys(runtime.handlers).sort()).toEqual(
        [...JETKVM_TOOL_NAMES].sort(),
      );
      expect(runtime.browser.deviceRpc).toBe(runtime.native.deviceRpc);
      await runtime.close();
      await runtime.close();
    });
  });

  it("qualifies a healthy browser snapshot through the current device adapter", async () => {
    const binding = {
      sessionId: "session-1",
      sessionGeneration: 1,
      connectionEpoch: 2,
      browserChannelGeneration: 3,
    } as const;
    const readDisplayState = vi.fn(async () => ({
      signal: {
        value: "unknown" as const,
        observedAt: null,
        ageMs: null,
        freshness: "unknown" as const,
        source: "none" as const,
      },
      resolution: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown" as const,
        source: "none" as const,
      },
      fps: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown" as const,
        source: "none" as const,
      },
      qualification: "current_binding" as const,
    }));
    const connection = {
      state: "ready",
      ref: { sessionId: binding.sessionId, sessionGeneration: 1 },
      binding,
      connectionEpoch: 2,
      browserChannelGeneration: 3,
      displayGeneration: 4,
      deviceRpc: { readDisplayState } as unknown as DeviceRpcAdapter,
    } satisfies BrowserConnection;
    const controller = {
      snapshot: async () => SNAPSHOT,
    } as unknown as BrowserControllerPort;

    await expect(
      qualifyConnectionCapabilities(controller, connection, DEADLINE),
    ).resolves.toMatchObject({
      session_status: true,
      display_status: true,
      power_control: true,
      edid_read: true,
    });
    expect(readDisplayState).toHaveBeenCalledWith(binding, DEADLINE);
  });

  it("rejects snapshot-only qualification when the device adapter read fails", async () => {
    const binding = {
      sessionId: "session-1",
      sessionGeneration: 1,
      connectionEpoch: 2,
      browserChannelGeneration: 3,
    } as const;
    const connection = {
      state: "ready",
      ref: { sessionId: binding.sessionId, sessionGeneration: 1 },
      binding,
      connectionEpoch: 2,
      browserChannelGeneration: 3,
      displayGeneration: 4,
      deviceRpc: {
        readDisplayState: async () => {
          throw new DeviceRpcError(
            "CONNECTION_LOST",
            "admission",
            "not_sent",
            false,
            false,
          );
        },
      } as unknown as DeviceRpcAdapter,
    } satisfies BrowserConnection;
    const controller = {
      snapshot: async () => SNAPSHOT,
    } as unknown as BrowserControllerPort;

    await expect(
      qualifyConnectionCapabilities(controller, connection, DEADLINE),
    ).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });
});
