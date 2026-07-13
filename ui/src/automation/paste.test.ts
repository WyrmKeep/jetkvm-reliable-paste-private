import { afterEach, describe, expect, it, vi } from "vitest";

import { HID_RPC_MESSAGE_TYPES, KeyboardMacroStateMessage } from "@/hooks/hidRpc";
import type { KeyboardLayoutLike } from "@/utils/pasteMacro";

import { ProductReliablePasteTransport, type ProductPasteChannel } from "./paste";

class FakePasteChannel implements ProductPasteChannel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly writes: Uint8Array[] = [];
  private readonly listeners: Record<string, Set<(event: MessageEvent | Event) => void>> = {};

  send(data: ArrayBuffer): void {
    this.writes.push(new Uint8Array(data.slice(0)));
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    (this.listeners[type] ??= new Set()).add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners[type]?.delete(listener);
  }
  listenerCount(type: string): number {
    return this.listeners[type]?.size ?? 0;
  }

  emitBufferedLow(): void {
    for (const listener of this.listeners.bufferedamountlow ?? []) {
      listener(new Event("bufferedamountlow"));
    }
  }

  emitMacroState(state: boolean, failed = false): void {
    const bytes = new KeyboardMacroStateMessage(state, true, failed).marshal();
    const event = new MessageEvent("message", { data: bytes.buffer });
    for (const listener of this.listeners.message ?? []) listener(event);
  }

  close(): void {
    this.readyState = "closed";
    for (const listener of this.listeners.close ?? []) listener(new Event("close"));
  }
}

const keyboard: KeyboardLayoutLike = {
  chars: {
    a: { key: "KeyA" },
    A: { key: "KeyA", shift: true },
    b: { key: "KeyB" },
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ProductReliablePasteTransport", () => {
  it("uses the reliable modified-key hold profile and requires submitted-active-succeeded", async () => {
    let monotonicMs = 0;
    const channel = new FakePasteChannel();
    const transport = new ProductReliablePasteTransport(channel, keyboard, {
      monotonicNow: () => monotonicMs,
      nowIso: () => (monotonicMs === 0 ? "2026-07-13T00:00:00.000Z" : "2026-07-13T00:00:00.022Z"),
    });
    const accepted: string[] = [];
    const execution = transport.execute(
      "aA",
      new AbortController().signal,
      value => {
        accepted.push(value);
      },
      1000,
    );

    expect(channel.writes).toHaveLength(1);
    expect(channel.writes[0][0]).toBe(HID_RPC_MESSAGE_TYPES.KeyboardMacroReport);
    expect(channel.writes[0][1]).toBe(1);
    expect(channel.writes[0][2]).toBe(0);
    expect(channel.writes[0][3]).toBe(0);
    expect(channel.writes[0][4]).toBe(0);
    expect(channel.writes[0][5]).toBe(4);
    const delays = [
      (channel.writes[0][13] << 8) | channel.writes[0][14],
      (channel.writes[0][22] << 8) | channel.writes[0][23],
      (channel.writes[0][31] << 8) | channel.writes[0][32],
      (channel.writes[0][40] << 8) | channel.writes[0][41],
    ];
    expect(delays).toEqual([5, 6, 10, 6]);
    expect(accepted).toEqual(["2026-07-13T00:00:00.000Z"]);

    channel.emitMacroState(true);
    monotonicMs = 22;
    channel.emitMacroState(false);
    await expect(execution).resolves.toEqual({
      acceptedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:00.022Z",
      measuredSourceCps: 90.91,
    });
    expect(JSON.stringify(transport)).not.toContain("aA");
  });

  it.each([
    {
      label: "terminal before active",
      events: (channel: FakePasteChannel) => channel.emitMacroState(false),
    },
    {
      label: "duplicate active",
      events: (channel: FakePasteChannel) => {
        channel.emitMacroState(true);
        channel.emitMacroState(true);
      },
    },
    {
      label: "failed terminal",
      events: (channel: FakePasteChannel) => {
        channel.emitMacroState(true);
        channel.emitMacroState(false, true);
      },
    },
    {
      label: "duplicate terminal",
      events: (channel: FakePasteChannel) => {
        channel.emitMacroState(true);
        channel.emitMacroState(false);
        channel.emitMacroState(false);
      },
    },
  ])("rejects $label without retaining content", async ({ events }) => {
    const channel = new FakePasteChannel();
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const execution = transport.execute("ab", new AbortController().signal, () => undefined, 1000);
    events(channel);

    await expect(execution).rejects.toMatchObject({ code: "PASTE_LIFECYCLE" });
    expect(JSON.stringify(transport)).not.toContain("ab");
  });
  it("rejects an inactive terminal before every batch is submitted", async () => {
    const channel = new FakePasteChannel();
    channel.bufferedAmount = 300 * 1024;
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const execution = transport.execute(
      "a".repeat(129),
      new AbortController().signal,
      () => undefined,
      1000,
    );

    expect(channel.writes).toHaveLength(1);
    channel.emitMacroState(true);
    channel.emitMacroState(false);
    channel.bufferedAmount = 0;
    channel.emitBufferedLow();

    await expect(execution).rejects.toMatchObject({ code: "PASTE_LIFECYCLE" });
  });

  it("settles and removes a high-water drain listener at its deadline", async () => {
    vi.useFakeTimers();
    const channel = new FakePasteChannel();
    channel.bufferedAmount = 300 * 1024;
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const execution = transport.execute("ab", new AbortController().signal, () => undefined, 100);
    const observed = execution.catch(error => error);

    expect(channel.listenerCount("bufferedamountlow")).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(channel.listenerCount("bufferedamountlow")).toBe(0);
    expect(channel.writes.at(-1)?.[0]).toBe(HID_RPC_MESSAGE_TYPES.CancelKeyboardMacroReport);
    await expect(observed).resolves.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    transport.close();
    expect(channel.listenerCount("message")).toBe(0);
    expect(channel.listenerCount("close")).toBe(0);
  });

  it("cancels and joins an active paste only after the device terminal", async () => {
    const channel = new FakePasteChannel();
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const execution = transport.execute("ab", new AbortController().signal, () => undefined, 1000);
    const executionFailure = expect(execution).rejects.toMatchObject({ code: "CANCELLED" });
    channel.emitMacroState(true);

    const joined = transport.cancelAndJoin();
    let joinSettled = false;
    void joined.then(() => {
      joinSettled = true;
    });
    await Promise.resolve();
    expect(joinSettled).toBe(false);
    expect(channel.writes.at(-1)?.[0]).toBe(HID_RPC_MESSAGE_TYPES.CancelKeyboardMacroReport);
    channel.emitMacroState(false);
    await joined;
    await executionFailure;
  });

  it("rejects channel close and concurrent execution without a successful no-op", async () => {
    const channel = new FakePasteChannel();
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const first = transport.execute("ab", new AbortController().signal, () => undefined, 1000);
    const firstFailure = expect(first).rejects.toMatchObject({ code: "CHANNEL_LOST" });
    await expect(
      transport.execute("a", new AbortController().signal, () => undefined, 1000),
    ).rejects.toMatchObject({ code: "PASTE_LIFECYCLE" });
    channel.close();
    await firstFailure;
  });
});
