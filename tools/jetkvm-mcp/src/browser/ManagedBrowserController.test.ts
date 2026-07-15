import { describe, expect, it } from "vitest";

import type { Deadline } from "../device/DeviceRpcAdapter.js";
import type { AutomationSnapshot } from "./bridgeProtocol.js";
import type { BrowserControllerPort } from "./BrowserController.js";
import {
  ManagedBrowserController,
  type BrowserControllerFactory,
} from "./ManagedBrowserController.js";

const deadline: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

function snapshot(generation: number): AutomationSnapshot {
  return {
    version: 1,
    state: "ready",
    lifecycle_generation: generation,
    channel_generation: generation,
    display_generation: generation,
    dispatch_generation: generation,
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
}

function controller(
  generation: number,
  closed: number[],
): BrowserControllerPort {
  const identity = Object.freeze({ generation });
  return {
    connectionIdentity: () => identity,
    snapshot: async () => snapshot(generation),
    stableReadySnapshot: async () => snapshot(generation),
    close: async () => {
      closed.push(generation);
    },
  } as unknown as BrowserControllerPort;
}

function factory() {
  const opened: number[] = [];
  const closed: number[] = [];
  let disposed = 0;
  const value: BrowserControllerFactory = {
    async open() {
      const generation = opened.length + 1;
      opened.push(generation);
      return controller(generation, closed);
    },
    async dispose() {
      disposed += 1;
    },
  };
  return { value, opened, closed, disposed: () => disposed };
}

describe("ManagedBrowserController", () => {
  it("opens once for concurrent first use and recreates after close", async () => {
    const setup = factory();
    const managed = new ManagedBrowserController(setup.value);

    const [first, duplicate] = await Promise.all([
      managed.snapshot(deadline),
      managed.snapshot(deadline),
    ]);
    expect(first.channel_generation).toBe(1);
    expect(duplicate.channel_generation).toBe(1);
    expect(setup.opened).toEqual([1]);
    const firstIdentity = managed.connectionIdentity();

    await managed.close(deadline);
    expect(setup.closed).toEqual([1]);
    const second = await managed.snapshot(deadline);
    expect(second.channel_generation).toBe(2);
    expect(managed.connectionIdentity()).not.toBe(firstIdentity);
  });

  it("reconnects through a fresh controller and disposes idempotently", async () => {
    const setup = factory();
    const managed = new ManagedBrowserController(setup.value);
    await managed.snapshot(deadline);

    expect((await managed.reconnect(deadline)).channel_generation).toBe(2);
    expect(setup.opened).toEqual([1, 2]);
    expect(setup.closed).toEqual([1]);
    expect((await managed.snapshot(deadline)).channel_generation).toBe(2);

    await managed.dispose(deadline);
    await managed.dispose(deadline);
    expect(setup.closed).toEqual([1, 2]);
    expect(setup.disposed()).toBe(1);
    await expect(managed.snapshot(deadline)).rejects.toThrow(/disposed/i);
  });
});
