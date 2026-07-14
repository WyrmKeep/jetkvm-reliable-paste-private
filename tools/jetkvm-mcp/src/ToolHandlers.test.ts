import { describe, expect, it } from "vitest";

import { JETKVM_TOOL_NAMES } from "./domain.js";
import { createToolHandlerComposition } from "./ToolHandlers.js";
import { FakeDeviceRpcAdapter } from "./test-support/fakes/FakeDeviceRpcAdapter.js";
import { FakeBrowserPlane } from "./test-support/fakes/FakeBrowserPlane.js";
import { FakeNativeControlPlane } from "./test-support/fakes/FakeNativeControlPlane.js";

const binding = {
  sessionId: "bootstrap",
  sessionGeneration: 1,
  connectionEpoch: 1,
  browserChannelGeneration: 1,
} as const;

describe("production tool handler composition", () => {
  it("registers all and only the ten canonical real handlers over one adapter", () => {
    const adapter = new FakeDeviceRpcAdapter(binding);
    const browser = new FakeBrowserPlane(adapter);
    const native = new FakeNativeControlPlane(adapter);
    const composition = createToolHandlerComposition({
      browser,
      native,
      configuredDevice: "device-fingerprint",
      browserStatus: {
        observeSession: async () => ({
          deviceReachable: true,
          setupState: "complete",
          authMode: "password",
          lifecycleState: "ready",
          webRtc: "connected",
          hid: "ready",
          decodedVideo: "ready",
          dispatchGeneration: 1,
          activeMutation: false,
          blockedReason: null,
          uiContractVersion: "1",
          firmwareVersion: null,
        }),
      },
      capabilitiesForConnection: async () => ({
        session_status: true,
        display_capture: true,
        display_status: true,
        mouse: true,
        absolute_pointer: true,
        keyboard: true,
        reliable_paste: true,
        input_release: true,
        power_control: true,
        edid_read: true,
      }),
    });

    expect(Object.keys(composition.handlers).sort()).toEqual(
      [...JETKVM_TOOL_NAMES].sort(),
    );
    expect(
      Object.values(composition.handlers).every(
        (handler) => typeof handler === "function",
      ),
    ).toBe(true);
  });

  it("rejects split browser/native adapter ownership", () => {
    const browser = new FakeBrowserPlane(new FakeDeviceRpcAdapter(binding));
    const native = new FakeNativeControlPlane(
      new FakeDeviceRpcAdapter({ ...binding, connectionEpoch: 2 }),
    );
    expect(() =>
      createToolHandlerComposition({
        browser,
        native,
        configuredDevice: "device-fingerprint",
        browserStatus: { observeSession: async () => Promise.reject() },
        capabilitiesForConnection: async () => Promise.reject(),
      }),
    ).toThrow(/one Browser-owned DeviceRpcAdapter/);
  });
});
