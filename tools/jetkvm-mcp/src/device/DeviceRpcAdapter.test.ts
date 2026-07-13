import { describe, expect, it, vi } from "vitest";

import {
  DeviceRpcError,
  GenerationFencedDeviceRpcAdapter,
  mapDeviceRpcBindingToWire,
  type DeviceRpcBinding,
} from "./DeviceRpcAdapter.js";
import { FakeDeviceRpcChannel } from "../test-support/fakes/FakeDeviceRpcChannel.js";

const BINDING: DeviceRpcBinding = Object.freeze({
  sessionId: "session-a",
  sessionGeneration: 7,
  connectionEpoch: 11,
  browserChannelGeneration: 13,
});

function deadline(timeoutMs = 1_000, signal = new AbortController().signal) {
  return { timeoutMs, signal };
}

function displayWireResult(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    streaming: 1,
    width: 1920,
    height: 1080,
    fps: 60,
    ...overrides,
  };
}

const RAW_EDID =
  "00ffffffffffff0052620188008888881c150103800000780a0dc9a05747982712484c00000001010101010101010101010101010101023a801871382d40582c4500c48e2100001e011d007251d01e206e285500c48e2100001e000000fc00543734392d6648443732300a20000000fd00147801ff1d000a202020202020017b";

function expectDeviceError(error: unknown, expected: Partial<DeviceRpcError>) {
  expect(error).toBeInstanceOf(DeviceRpcError);
  expect(error).toMatchObject(expected);
}

describe("DeviceRpcAdapter binding and wire contract", () => {
  it("maps the sole camelCase binding tuple to snake_case only at the wire boundary", () => {
    expect(mapDeviceRpcBindingToWire(BINDING)).toEqual({
      session_id: "session-a",
      session_generation: 7,
      connection_epoch: 11,
      browser_channel_generation: 13,
    });
  });

  it.each([
    ["sessionId", "session-b"],
    ["sessionGeneration", 8],
    ["connectionEpoch", 12],
    ["browserChannelGeneration", 14],
  ] as const)(
    "rejects a stale %s at admission without a write",
    async (field, value) => {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
      const stale = { ...BINDING, [field]: value } as DeviceRpcBinding;

      const error = await adapter
        .readDisplayState(stale, deadline())
        .catch((caught) => caught);

      expectDeviceError(error, {
        code: "STALE_BINDING",
        boundary: "admission",
        outcome: "not_sent",
      });
      expect(channel.writes()).toHaveLength(0);
    },
  );

  it("fences an epoch-only replacement even when session and channel generations are unchanged", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const next = { ...BINDING, connectionEpoch: BINDING.connectionEpoch + 1 };

    adapter.replaceBinding(next, nextChannel);
    const error = await adapter
      .readEdid(BINDING, deadline())
      .catch((caught) => caught);

    expectDeviceError(error, {
      code: "STALE_BINDING",
      boundary: "admission",
      outcome: "not_sent",
    });
    expect(oldChannel.writes()).toHaveLength(0);
    expect(nextChannel.writes()).toHaveLength(0);
  });

  it("invalidates the old binding before publishing a takeover", async () => {
    const events: string[] = [];
    const oldChannel = new FakeDeviceRpcChannel({
      onClose: () => events.push("old-invalidated"),
    });
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const takeover = {
      sessionId: "session-b",
      sessionGeneration: 1,
      connectionEpoch: 1,
      browserChannelGeneration: 1,
    };

    adapter.replaceBinding(takeover, nextChannel, () =>
      events.push("new-published"),
    );

    expect(events).toEqual(["old-invalidated", "new-published"]);
    expect(adapter.binding).toEqual(takeover);
  });

  it.each([["session id"], ["-session"], ["s".repeat(129)]])(
    "rejects a noncanonical opaque session ID %s",
    (sessionId) => {
      expect(() =>
        mapDeviceRpcBindingToWire({ ...BINDING, sessionId }),
      ).toThrow(/invalid device RPC binding/i);
    },
  );

  it("accepts the 128-character opaque session ID boundary", () => {
    const sessionId = `s${"a".repeat(127)}`;
    expect(
      mapDeviceRpcBindingToWire({ ...BINDING, sessionId }).session_id,
    ).toBe(sessionId);
  });

  it("rejects malformed binding values before changing the active binding", () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    expect(() =>
      adapter.replaceBinding(
        { ...BINDING, connectionEpoch: 0 },
        new FakeDeviceRpcChannel(),
      ),
    ).toThrow(/invalid device RPC binding/i);
    expect(adapter.binding).toEqual(BINDING);
    expect(channel.isClosed()).toBe(false);
  });
  it("rejects an already-closed replacement before invalidating the old binding", () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    nextChannel.close();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    let published = false;

    expect(() =>
      adapter.replaceBinding(
        { ...BINDING, browserChannelGeneration: 14 },
        nextChannel,
        () => {
          published = true;
        },
      ),
    ).toThrow(/replacement channel is closed/i);

    expect(adapter.binding).toEqual(BINDING);
    expect(oldChannel.isClosed()).toBe(false);
    expect(published).toBe(false);
  });

  it("rechecks replacement readiness after old invalidation and before publish", () => {
    const nextChannel = new FakeDeviceRpcChannel();
    const oldChannel = new FakeDeviceRpcChannel({
      onClose: () => nextChannel.close(),
    });
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    let published = false;

    expect(() =>
      adapter.replaceBinding(
        { ...BINDING, browserChannelGeneration: 14 },
        nextChannel,
        () => {
          published = true;
        },
      ),
    ).toThrow(/replacement channel closed during takeover/i);

    expect(adapter.binding).toEqual(BINDING);
    expect(published).toBe(false);
  });

  it("detaches the old event source during replacement", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const nextBinding = { ...BINDING, browserChannelGeneration: 14 };
    adapter.replaceBinding(nextBinding, nextChannel);

    oldChannel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "videoInputState",
        params: displayWireResult(),
      }),
    );
    nextChannel.close();

    await expect(
      adapter.readDisplayState(nextBinding, deadline()),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
    });
  });
});

describe("DeviceRpcAdapter timing and replacement fences", () => {
  it("removes a queued call cancelled before write", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const first = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    const cancellation = new AbortController();
    const second = adapter.readEdid(
      BINDING,
      deadline(1_000, cancellation.signal),
    );
    cancellation.abort();

    const error = await second.catch((caught) => caught);
    expectDeviceError(error, {
      code: "CANCELLED",
      boundary: "queue",
      outcome: "not_sent",
    });
    expect(channel.writes()).toHaveLength(1);

    channel.respondToWrite(0, displayWireResult());
    await first;
  });

  it("times out in the queue before write", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
      const first = adapter.readDisplayState(BINDING, deadline(1_000));
      await vi.advanceTimersByTimeAsync(0);
      const second = adapter.readEdid(BINDING, deadline(100));
      const secondError = second.catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(101);

      const error = await secondError;
      expectDeviceError(error, {
        code: "DEADLINE_EXCEEDED",
        boundary: "queue",
        outcome: "not_sent",
      });
      expect(channel.writes()).toHaveLength(1);

      channel.respondToWrite(0, displayWireResult());
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences replacement while queued with zero second write", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const first = adapter.readDisplayState(BINDING, deadline());
    await oldChannel.waitForWrites(1);
    const queued = adapter.readEdid(BINDING, deadline());

    adapter.replaceBinding(
      { ...BINDING, browserChannelGeneration: 14 },
      nextChannel,
    );

    const firstError = await first.catch((caught) => caught);
    const queuedError = await queued.catch((caught) => caught);
    expectDeviceError(firstError, {
      code: "BINDING_REPLACED",
      boundary: "ack",
      outcome: "unknown",
    });
    expectDeviceError(queuedError, {
      code: "BINDING_REPLACED",
      boundary: "queue",
      outcome: "not_sent",
    });
    expect(oldChannel.writes()).toHaveLength(1);
    expect(nextChannel.writes()).toHaveLength(0);
  });

  it("classifies replacement during a rejected send as not_sent", async () => {
    const nextChannel = new FakeDeviceRpcChannel();
    let adapter!: GenerationFencedDeviceRpcAdapter;
    const oldChannel = new FakeDeviceRpcChannel({
      beforeWrite: () =>
        adapter.replaceBinding(
          { ...BINDING, connectionEpoch: 12 },
          nextChannel,
        ),
      rejectWrite: true,
    });
    adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);

    const error = await adapter
      .readDisplayState(BINDING, deadline())
      .catch((caught) => caught);

    expectDeviceError(error, {
      code: "BINDING_REPLACED",
      boundary: "send",
      outcome: "not_sent",
    });
    expect(oldChannel.acceptedWrites()).toHaveLength(0);
  });

  it("classifies replacement after write and before acknowledgement as unknown", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await oldChannel.waitForWrites(1);

    adapter.replaceBinding({ ...BINDING, sessionGeneration: 8 }, nextChannel);
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "BINDING_REPLACED",
      boundary: "ack",
      outcome: "unknown",
    });
    expect(error).toMatchObject({ writeBegan: true, acknowledged: false });
  });

  it("does not migrate a pending call or accept its old-channel response after replacement", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const oldPending = adapter.readDisplayState(BINDING, deadline());
    await oldChannel.waitForWrites(1);
    const nextBinding = { ...BINDING, browserChannelGeneration: 14 };

    adapter.replaceBinding(nextBinding, nextChannel);
    oldChannel.respondToWrite(0, displayWireResult());
    const oldError = await oldPending.catch((caught) => caught);
    expectDeviceError(oldError, { code: "BINDING_REPLACED", boundary: "ack" });

    const current = adapter.readDisplayState(nextBinding, deadline());
    await nextChannel.waitForWrites(1);
    expect(nextChannel.writes()).toHaveLength(1);
    nextChannel.respondToWrite(0, displayWireResult());
    await expect(current).resolves.toMatchObject({
      signal: { value: "present" },
    });
  });
});

describe("DeviceRpcAdapter correlation, validation, and boundaries", () => {
  it("sends a bounded typed request with an exact correlated id", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      idNamespace: "adapter-a",
    });
    const pending = adapter.readDisplayState(BINDING, deadline(30_000));
    await channel.waitForWrites(1);

    expect(channel.decodedWrite(0)).toEqual({
      jsonrpc: "2.0",
      id: "device-rpc:adapter-a:1:1",
      method: "getVideoState",
      params: { binding: mapDeviceRpcBindingToWire(BINDING) },
    });
    channel.respondToWrite(0, displayWireResult());

    await expect(pending).resolves.toMatchObject({
      signal: { value: "present", source: "cached_snapshot" },
      resolution: { value: { width: 1920, height: 1080, refreshHz: null } },
    });
  });

  it("adapts the actual flat native.VideoState snapshot and omits proxy streaming", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(
      0,
      displayWireResult({
        ready: false,
        streaming: 2,
        error: "no_lock",
      }),
    );

    await expect(pending).resolves.toEqual({
      signal: {
        value: "no_lock",
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_snapshot",
      },
      resolution: {
        value: { width: 1920, height: 1080, refreshHz: null },
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_snapshot",
      },
      fps: {
        value: 60,
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_snapshot",
      },
      qualification: "current_binding",
    });
  });

  it("accepts an idle videoInputState event as cached_event without an RPC call", async () => {
    let nowMs = 10_000;
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      now: () => nowMs,
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    channel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "videoInputState",
        params: displayWireResult({
          ready: false,
          streaming: 0,
          error: "no_signal",
          width: 0,
          height: 0,
          fps: 0,
        }),
      }),
    );
    nowMs += 250;
    channel.close();

    await expect(
      adapter.readDisplayState(BINDING, deadline()),
    ).resolves.toMatchObject({
      signal: {
        value: "no_signal",
        source: "cached_event",
        ageMs: 250,
        freshness: "stale",
      },
      resolution: {
        value: null,
        source: "cached_event",
        ageMs: 250,
        freshness: "stale",
      },
      fps: {
        value: null,
        source: "cached_event",
        ageMs: 250,
        freshness: "stale",
      },
      qualification: "binding_lost_cached_only",
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it("routes an interleaved videoInputState event without failing the correlated response", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "videoInputState",
        params: displayWireResult({
          ready: false,
          error: "out_of_range",
        }),
      }),
    );
    channel.respondToWrite(0, displayWireResult());

    await expect(pending).resolves.toMatchObject({
      signal: { value: "present", source: "cached_snapshot" },
      qualification: "current_binding",
    });
  });

  it("ignores a delayed retired response while awaiting the current correlation id", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      idNamespace: "adapter-a",
    });
    const first = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, displayWireResult());
    await first;

    const second = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(2);
    const secondResult = expect(second).resolves.toMatchObject({
      signal: { value: "present" },
    });
    channel.respondToWrite(0, displayWireResult());
    channel.respondToWrite(1, displayWireResult());

    await secondResult;
  });

  it("ignores an issued response delayed by more than 256 later calls", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const first = adapter.readDisplayState(BINDING, deadline(30_000));
    await channel.waitForWrites(1);
    channel.respondToWrite(0, displayWireResult());
    await first;

    for (let index = 1; index <= 256; index += 1) {
      const completed = adapter.readDisplayState(BINDING, deadline(30_000));
      await channel.waitForWrites(index + 1);
      channel.respondToWrite(index, displayWireResult());
      await completed;
    }

    const currentIndex = 257;
    const current = adapter.readDisplayState(BINDING, deadline(30_000));
    await channel.waitForWrites(currentIndex + 1);
    channel.respondToWrite(0, displayWireResult());
    channel.respondToWrite(currentIndex, displayWireResult());

    await expect(current).resolves.toMatchObject({
      signal: { value: "present" },
    });
  });

  it("fails closed on a well-formed response with a foreign correlation id", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);

    channel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "foreign-rpc:1",
        result: displayWireResult(),
      }),
    );
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("fails closed on an unissued future sequence in the current namespace", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      idNamespace: "adapter-a",
    });
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);

    channel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "device-rpc:adapter-a:1:2",
        result: displayWireResult(),
      }),
    );
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("fails closed on an issued id from the adapter's prior binding revision", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel, {
      idNamespace: "adapter-a",
    });
    const oldCall = adapter.readDisplayState(BINDING, deadline());
    await oldChannel.waitForWrites(1);
    oldChannel.respondToWrite(0, displayWireResult());
    await oldCall;

    const nextBinding = { ...BINDING, browserChannelGeneration: 14 };
    adapter.replaceBinding(nextBinding, nextChannel);
    const current = adapter.readDisplayState(nextBinding, deadline());
    await nextChannel.waitForWrites(1);
    nextChannel.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "device-rpc:adapter-a:1:1",
        result: displayWireResult(),
      }),
    );
    const error = await current.catch((caught) => caught);

    expectDeviceError(error, {
      code: "MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("rejects a display read continuation from repopulating cache after binding replacement", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await oldChannel.waitForWrites(1);
    oldChannel.respondToWrite(0, displayWireResult());
    await Promise.resolve();
    const nextBinding = { ...BINDING, browserChannelGeneration: 14 };
    adapter.replaceBinding(nextBinding, nextChannel);

    await expect(pending).rejects.toMatchObject({
      code: "BINDING_REPLACED",
      boundary: "ack",
      outcome: "unknown",
    });
    nextChannel.close();
    await expect(
      adapter.readDisplayState(nextBinding, deadline()),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
    });
  });

  it("rejects an EDID read continuation after binding replacement", async () => {
    const oldChannel = new FakeDeviceRpcChannel();
    const nextChannel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, oldChannel);
    const pending = adapter.readEdid(BINDING, deadline());
    await oldChannel.waitForWrites(1);
    oldChannel.respondToWrite(0, RAW_EDID);
    await Promise.resolve();
    adapter.replaceBinding(
      { ...BINDING, browserChannelGeneration: 14 },
      nextChannel,
    );

    await expect(pending).rejects.toMatchObject({
      code: "BINDING_REPLACED",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("rejects an out-of-range deadline before admission", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    const error = await adapter
      .readDisplayState(BINDING, deadline(30_001))
      .catch((caught) => caught);

    expectDeviceError(error, {
      code: "INVALID_DEADLINE",
      boundary: "admission",
      outcome: "not_sent",
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it("admits a positive one-millisecond internal deadline", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline(1));
    const admission = await Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      channel.waitForWrites(1).then(() => "written"),
    ]);

    expect(admission).toBe("written");
    channel.respondToWrite(0, displayWireResult());
    await expect(pending).resolves.toMatchObject({
      qualification: "current_binding",
    });
  });

  it("rejects an exhausted zero-millisecond internal deadline", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    await expect(
      adapter.readDisplayState(BINDING, deadline(0)),
    ).rejects.toMatchObject({
      code: "INVALID_DEADLINE",
      outcome: "not_sent",
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it("rejects an invalid semantic power request without a write", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    await expect(
      adapter.performAtx(
        BINDING,
        { requestId: "request-a", action: "arbitrary_duration" as never },
        deadline(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      boundary: "admission",
      outcome: "not_sent",
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it.each(["request id", "-request", `r${"a".repeat(128)}`])(
    "rejects a noncanonical opaque power request ID %s without a write",
    async (requestId) => {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

      await expect(
        adapter.performAtx(
          BINDING,
          { requestId, action: "press_power" },
          deadline(),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        outcome: "not_sent",
      });
      expect(channel.writes()).toHaveLength(0);
    },
  );

  it("fails a current compatible-looking ATX request closed without calling the best-effort router", async () => {
    const requestId = `r${"a".repeat(127)}`;
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    await expect(
      adapter.performAtx(
        BINDING,
        { requestId, action: "press_power" },
        deadline(),
      ),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_DOWNSTREAM",
      boundary: "admission",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it("rejects unsafe flat native.VideoState dimensions", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(
      0,
      displayWireResult({ width: Number.MAX_SAFE_INTEGER + 1 }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      outcome: "unknown",
    });
  });

  it("maps the maximum-safe flat native.VideoState dimension", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(
      0,
      displayWireResult({ width: Number.MAX_SAFE_INTEGER }),
    );

    await expect(pending).resolves.toMatchObject({
      resolution: { value: { width: Number.MAX_SAFE_INTEGER } },
    });
  });

  it("adapts the actual raw getEDID string result", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    const pending = adapter.readEdid(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, RAW_EDID);

    await expect(pending).resolves.toMatchObject({
      status: "available",
      readCompleted: true,
      reason: null,
      observedAt: "2026-07-13T00:00:00.000Z",
      data: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        manufacturerId: "TSB",
        productCode: 34_817,
        displayName: "T749-fHD720",
        preferredResolution: {
          width: 1920,
          height: 1080,
        },
      },
    });
  });

  it.each(["", null])(
    "maps a successful empty getEDID result %p only to unavailable",
    async (result) => {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
        observedAt: () => "2026-07-13T00:00:00.000Z",
      });
      const pending = adapter.readEdid(BINDING, deadline());
      await channel.waitForWrites(1);
      channel.respondToWrite(0, result);

      await expect(pending).resolves.toEqual({
        status: "unavailable",
        readCompleted: true,
        reason: "successful_read_reported_no_edid",
        observedAt: "2026-07-13T00:00:00.000Z",
        data: null,
      });
    },
  );

  it("preserves a getEDID router error instead of fabricating unavailable", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readEdid(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondWithError(0);

    await expect(pending).rejects.toMatchObject({
      code: "DOWNSTREAM_ERROR",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("redacts malformed downstream payloads on the read path", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.emitRaw('{"credential":"super-secret","id":');
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
    expect(String((error as Error).message)).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("super-secret");
  });

  it("rejects a duplicate correlated read response", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, displayWireResult(), { duplicate: true });

    await expect(pending).rejects.toMatchObject({
      code: "DUPLICATE_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("classifies channel loss after a read write as unknown", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.close();

    await expect(pending).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("ages every observed native.VideoState fact from the local observation time", async () => {
    let nowMs = 10_000;
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      now: () => nowMs,
      observedAt: () => "2026-07-13T00:00:00.000Z",
    });
    const first = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, displayWireResult());
    await first;
    nowMs += 1_250;
    channel.close();

    const cached = await adapter.readDisplayState(BINDING, deadline());

    expect(cached).toMatchObject({
      signal: { ageMs: 1_250, freshness: "stale" },
      resolution: { ageMs: 1_250, freshness: "stale" },
      fps: { ageMs: 1_250, freshness: "stale" },
      qualification: "binding_lost_cached_only",
    });
    expect(channel.writes()).toHaveLength(1);
    await expect(adapter.readEdid(BINDING, deadline())).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
    });
  });
});
