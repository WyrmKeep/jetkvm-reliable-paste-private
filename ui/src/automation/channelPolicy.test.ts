import { describe, expect, it } from "vitest";

import { shouldPublishAutomationChannels } from "./channelPolicy";

const state = {
  connected: true,
  rpcOpen: true,
  hidOpen: true,
  hidDisabled: false,
  hidProtocolVersion: 1,
  forceUnavailable: false,
} as const;

describe("automation channel publication policy", () => {
  it.each([
    ["a transient peer connection", { connected: false }],
    ["an RPC channel still opening", { rpcOpen: false }],
    ["an HID channel still opening", { hidOpen: false }],
    ["an HID handshake still pending", { hidProtocolVersion: null }],
  ])("retains the incumbent during %s", (_label, change) => {
    expect(shouldPublishAutomationChannels({ ...state, ...change })).toBe(false);
  });

  it("publishes one fully negotiated successor or an explicit terminal state", () => {
    expect(shouldPublishAutomationChannels(state)).toBe(true);
    expect(
      shouldPublishAutomationChannels({
        ...state,
        hidOpen: false,
        hidDisabled: true,
        hidProtocolVersion: null,
      }),
    ).toBe(true);
    expect(
      shouldPublishAutomationChannels({
        ...state,
        connected: false,
        rpcOpen: false,
        hidOpen: false,
        hidProtocolVersion: null,
        forceUnavailable: true,
      }),
    ).toBe(true);
  });
});
