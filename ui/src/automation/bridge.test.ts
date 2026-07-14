import { describe, expect, it, vi } from "vitest";

import { createAutomationFacadeRegistry, type AutomationOwner } from "./bridge";
import type {
  AtxBridgeRequest,
  AutomationSnapshot,
  CaptureBridgeRequest,
  CaptureBridgeResult,
  KeyboardBridgeReceipt,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  MutationBridgeReceipt,
  PasteBridgeReceipt,
  PasteBridgeRequest,
  ReadBridgeRequest,
  ReadBridgeResult,
  ReleaseBridgeReceipt,
  ReleaseBridgeRequest,
} from "./protocol";

const snapshot = (state: AutomationSnapshot["state"], lifecycle = 1): AutomationSnapshot => ({
  version: 1,
  state,
  lifecycle_generation: lifecycle,
  channel_generation: lifecycle,
  display_generation: lifecycle,
  dispatch_generation: lifecycle,
  rpc_ready: state === "ready",
  hid_ready: state === "ready",
  video_ready: state === "ready",
  absolute_pointer: state === "ready",
  scroll_throttling_disabled: state === "ready",
  keyboard_layout: state === "ready" ? "en-US" : null,
  reliable_paste: state === "ready",
  source_width: state === "ready" ? 1920 : null,
  source_height: state === "ready" ? 1080 : null,
});

function owner(
  name: string,
  events: string[],
  state: AutomationSnapshot["state"] = "ready",
): AutomationOwner {
  const notImplemented = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    snapshot: () => {
      events.push(`${name}:snapshot`);
      return snapshot(state);
    },
    cancel: operationId => {
      events.push(`${name}:cancel:${operationId}`);
      return true;
    },
    capture: notImplemented as (request: CaptureBridgeRequest) => Promise<CaptureBridgeResult>,
    mouse: notImplemented as (request: MouseBridgeRequest) => Promise<MutationBridgeReceipt>,
    keyboard: notImplemented as (request: KeyboardBridgeRequest) => Promise<KeyboardBridgeReceipt>,
    paste: notImplemented as (request: PasteBridgeRequest) => Promise<PasteBridgeReceipt>,
    release: notImplemented as (request: ReleaseBridgeRequest) => Promise<ReleaseBridgeReceipt>,
    readVideoState: notImplemented as (request: ReadBridgeRequest) => Promise<ReadBridgeResult>,
    readEdid: notImplemented as (request: ReadBridgeRequest) => Promise<ReadBridgeResult>,
    performAtx: notImplemented as (request: AtxBridgeRequest) => Promise<ReadBridgeResult>,
    invalidate: reason => events.push(`${name}:invalidate:${reason}`),
  };
}

describe("stable automation facade", () => {
  it("routes exact operation cancellation only to the currently bound owner", () => {
    const events: string[] = [];
    const registry = createAutomationFacadeRegistry({});
    const token = registry.bind(owner("current", events));
    events.length = 0;

    expect(registry.facade.cancel("operation-1")).toBe(true);
    expect(events).toEqual(["current:cancel:operation-1"]);
    token.unbind();
    expect(registry.facade.cancel("operation-1")).toBe(false);
  });

  it("keeps one facade across rerenders and invalidates the old owner before replacement", () => {
    const events: string[] = [];
    const target: Record<string, unknown> = {};
    const firstRegistry = createAutomationFacadeRegistry(target);
    const firstToken = firstRegistry.bind(owner("first", events));
    const facade = target.__JETKVM_AUTOMATION__;
    events.length = 0;

    const secondRegistry = createAutomationFacadeRegistry(target);
    expect(secondRegistry.facade).toBe(facade);
    const secondToken = secondRegistry.bind(owner("second", events));

    expect(events).toEqual(["first:snapshot", "first:invalidate:replaced", "second:snapshot"]);
    expect(secondRegistry.facade.snapshot().state).toBe("ready");
    expect(events.at(-1)).toBe("second:snapshot");

    firstToken.unbind();
    expect(secondRegistry.facade.snapshot().state).toBe("ready");
    expect(events.at(-1)).toBe("second:snapshot");

    secondToken.unbind();
    expect(secondRegistry.facade.snapshot().state).toBe("unmounted");
    const unmountIndex = events.indexOf("second:invalidate:unmounted");
    expect(unmountIndex).toBeGreaterThan(-1);
    expect(unmountIndex).toBeLessThan(events.length - 1);
  });

  it("rejects every operation when there is no ready owner instead of succeeding as a no-op", async () => {
    const registry = createAutomationFacadeRegistry({});
    const request = {
      operation_id: "op-1",
      expected_lifecycle_generation: 1,
      expected_channel_generation: 1,
      timeout_ms: 100,
    } satisfies ReadBridgeRequest;

    await expect(registry.facade.readVideoState(request)).rejects.toMatchObject({
      version: 1,
      name: "JetKvmAutomationError",
      code: "UNMOUNTED",
      stage: "admission",
      outcome: "not_sent",
      write_began: false,
      acknowledged: false,
      dispatched_count: 0,
      completed_count: 0,
    });
  });

  it("delegates only to a ready current owner", async () => {
    const registry = createAutomationFacadeRegistry({});
    const events: string[] = [];
    const notReady = owner("waiting", events, "not_ready");
    notReady.readEdid = vi.fn(async () => ({
      operation_id: "op-2",
      lifecycle_generation: 1,
      channel_generation: 1,
      acknowledged_at: "2026-07-13T00:00:00.000Z",
      result: null,
    }));
    registry.bind(notReady);

    const request = {
      operation_id: "op-2",
      expected_lifecycle_generation: 1,
      expected_channel_generation: 1,
      timeout_ms: 100,
    } satisfies ReadBridgeRequest;
    await expect(registry.facade.readEdid(request)).rejects.toMatchObject({
      code: "NOT_READY",
      outcome: "not_sent",
    });
    expect(notReady.readEdid).not.toHaveBeenCalled();
  });
});
