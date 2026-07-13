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

function displayWireResult() {
  return {
    signal: {
      value: "present",
      observed_at: "2026-07-13T00:00:00.000Z",
      age_ms: 5,
      freshness: "fresh",
      source: "cached_snapshot",
    },
    resolution: {
      value: { width: 1920, height: 1080, refresh_hz: 60 },
      observed_at: "2026-07-13T00:00:00.000Z",
      age_ms: 5,
      freshness: "fresh",
      source: "cached_snapshot",
    },
    fps: {
      value: 60,
      observed_at: "2026-07-13T00:00:00.000Z",
      age_ms: 5,
      freshness: "fresh",
      source: "cached_snapshot",
    },
  };
}

function atxWireResult(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "request-a",
    action: "press_power",
    wire_action: "power-short",
    fixed_press_ms: 200,
    serial_sequence_completed: true,
    acknowledged_at: "2026-07-13T00:00:00.000Z",
    atx_led_observation: {
      power: null,
      hdd: null,
      observed_at: null,
      freshness: "unknown",
    },
    ...overrides,
  };
}
function edidWireResult() {
  return {
    status: "available",
    read_completed: true,
    reason: null,
    observed_at: "2026-07-13T00:00:00.000Z",
    data: {
      sha256: "a".repeat(64),
      manufacturer_id: null,
      product_code: 1,
      serial_number: "serial-a",
      display_name: null,
      preferred_resolution: {
        width: 1920,
        height: 1080,
        refresh_hz: 60,
      },
    },
  };
}

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
    const first = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
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
      .performAtx(
        BINDING,
        { requestId: "request-a", action: "press_power" },
        deadline(),
      )
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
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
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
      resolution: { value: { width: 1920, height: 1080, refreshHz: 60 } },
    });
  });

  it.each([
    [
      "source-none metadata with an observation timestamp",
      {
        value: "unknown",
        observed_at: "2026-06-10T10:00:00.000Z",
        age_ms: null,
        freshness: "unknown",
        source: "none",
      },
    ],
    [
      "source-none metadata with an observation age",
      {
        value: "unknown",
        observed_at: null,
        age_ms: 1,
        freshness: "unknown",
        source: "none",
      },
    ],
    [
      "source-none metadata marked fresh",
      {
        value: "unknown",
        observed_at: null,
        age_ms: null,
        freshness: "fresh",
        source: "none",
      },
    ],
    [
      "cached metadata without an observation timestamp",
      {
        value: "present",
        observed_at: null,
        age_ms: 1,
        freshness: "fresh",
        source: "cached_snapshot",
      },
    ],
    [
      "cached metadata without an observation age",
      {
        value: "present",
        observed_at: "2026-06-10T10:00:00.000Z",
        age_ms: null,
        freshness: "fresh",
        source: "cached_event",
      },
    ],
    [
      "cached metadata with unknown freshness",
      {
        value: "present",
        observed_at: "2026-06-10T10:00:00.000Z",
        age_ms: 1,
        freshness: "unknown",
        source: "cached_snapshot",
      },
    ],
  ] as const)("fails closed on %s", async (_label, signal) => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, { ...displayWireResult(), signal });

    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("maps every legal wire fact variant without weakening qualification", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, {
      signal: {
        value: "no_lock",
        observed_at: "2026-06-10T10:00:00.000Z",
        age_ms: 42,
        freshness: "stale",
        source: "cached_event",
      },
      resolution: {
        value: { width: 1920, height: 1080, refresh_hz: 60 },
        observed_at: "2026-06-10T10:00:01.000Z",
        age_ms: 0,
        freshness: "fresh",
        source: "cached_snapshot",
      },
      fps: {
        value: null,
        observed_at: null,
        age_ms: null,
        freshness: "unknown",
        source: "none",
      },
    });

    await expect(pending).resolves.toEqual({
      signal: {
        value: "no_lock",
        observedAt: "2026-06-10T10:00:00.000Z",
        ageMs: 42,
        freshness: "stale",
        source: "cached_event",
      },
      resolution: {
        value: { width: 1920, height: 1080, refreshHz: 60 },
        observedAt: "2026-06-10T10:00:01.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_snapshot",
      },
      fps: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
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
    oldChannel.respondToWrite(0, edidWireResult());
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

  it("rejects an invalid semantic power request before admission", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);

    const error = await adapter
      .performAtx(
        BINDING,
        { requestId: "request-a", action: "arbitrary_duration" as never },
        deadline(),
      )
      .catch((caught) => caught);

    expectDeviceError(error, {
      code: "INVALID_REQUEST",
      boundary: "admission",
      outcome: "not_sent",
    });
    expect(channel.writes()).toHaveLength(0);
  });

  it.each(["request id", "-request", `r${"a".repeat(128)}`])(
    "rejects a noncanonical opaque request ID %s",
    async (requestId) => {
      const channel = new FakeDeviceRpcChannel({ rejectWrite: true });
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

  it("accepts the 128-character opaque request ID boundary", async () => {
    const requestId = `r${"a".repeat(127)}`;
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId, action: "press_power" },
      deadline(),
    );
    await channel.waitForWrites(1);
    channel.respondToWrite(0, atxWireResult({ request_id: requestId }));

    await expect(pending).resolves.toMatchObject({ requestId });
  });

  it.each([
    [
      "fresh observation without a timestamp",
      { power: true, hdd: false, observed_at: null, freshness: "fresh" },
    ],
    [
      "unknown observation with a timestamp",
      {
        power: null,
        hdd: null,
        observed_at: "2026-07-13T00:00:00.000Z",
        freshness: "unknown",
      },
    ],
    [
      "unknown observation with an LED fact",
      { power: true, hdd: null, observed_at: null, freshness: "unknown" },
    ],
  ] as const)(
    "rejects an incoherent ATX %s",
    async (_label, atxLedObservation) => {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
      const pending = adapter.performAtx(
        BINDING,
        { requestId: "request-a", action: "press_power" },
        deadline(),
      );
      await channel.waitForWrites(1);
      channel.respondToWrite(
        0,
        atxWireResult({ atx_led_observation: atxLedObservation }),
      );

      const error = await pending.catch((caught) => caught);

      expectDeviceError(error, {
        code: "MALFORMED_RESPONSE",
        boundary: "ack",
        outcome: "unknown",
      });
    },
  );

  it("maps an observed ATX LED snapshot with qualified provenance", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
    await channel.waitForWrites(1);
    channel.respondToWrite(
      0,
      atxWireResult({
        atx_led_observation: {
          power: true,
          hdd: null,
          observed_at: "2026-07-13T00:00:00.000Z",
          freshness: "stale",
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      atxLedObservation: {
        power: true,
        hdd: null,
        observedAt: "2026-07-13T00:00:00.000Z",
        freshness: "stale",
      },
    });
  });

  it.each([
    [
      "fact age",
      {
        ...displayWireResult(),
        signal: {
          ...displayWireResult().signal,
          age_ms: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ],
    [
      "resolution width",
      {
        ...displayWireResult(),
        resolution: {
          ...displayWireResult().resolution,
          value: {
            ...displayWireResult().resolution.value,
            width: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      },
    ],
  ])("rejects an unsafe display integer in %s", async (_label, response) => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, response);

    await expect(pending).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      outcome: "unknown",
    });
  });

  it("rejects unsafe EDID and preferred-resolution integers", async () => {
    const base = edidWireResult();
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const responses = [
      { ...base, data: { ...base.data, product_code: unsafe } },
      {
        ...base,
        data: {
          ...base.data,
          preferred_resolution: {
            ...base.data.preferred_resolution,
            height: unsafe,
          },
        },
      },
    ];

    for (const response of responses) {
      const channel = new FakeDeviceRpcChannel();
      const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
      const pending = adapter.readEdid(BINDING, deadline());
      await channel.waitForWrites(1);
      channel.respondToWrite(0, response);
      await expect(pending).rejects.toMatchObject({
        code: "MALFORMED_RESPONSE",
        outcome: "unknown",
      });
    }
  });

  it("maps maximum-safe display and EDID integer boundaries", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const displayResult = displayWireResult();
    const displayPending = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    channel.respondToWrite(0, {
      ...displayResult,
      signal: {
        ...displayResult.signal,
        age_ms: Number.MAX_SAFE_INTEGER,
      },
      resolution: {
        ...displayResult.resolution,
        value: {
          ...displayResult.resolution.value,
          width: Number.MAX_SAFE_INTEGER,
        },
      },
    });
    await expect(displayPending).resolves.toMatchObject({
      signal: { ageMs: Number.MAX_SAFE_INTEGER },
      resolution: { value: { width: Number.MAX_SAFE_INTEGER } },
    });

    const edidResult = edidWireResult();
    const edidPending = adapter.readEdid(BINDING, deadline());
    await channel.waitForWrites(2);
    channel.respondToWrite(1, {
      ...edidResult,
      data: {
        ...edidResult.data,
        product_code: Number.MAX_SAFE_INTEGER,
        preferred_resolution: {
          ...edidResult.data.preferred_resolution,
          width: Number.MAX_SAFE_INTEGER,
          height: Number.MAX_SAFE_INTEGER,
        },
      },
    });
    await expect(edidPending).resolves.toMatchObject({
      data: {
        productCode: Number.MAX_SAFE_INTEGER,
        preferredResolution: {
          width: Number.MAX_SAFE_INTEGER,
          height: Number.MAX_SAFE_INTEGER,
        },
      },
    });
  });

  it("redacts malformed downstream payloads and classifies them after write as unknown", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
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

  it("rejects a duplicate correlated response instead of accepting ambiguous acknowledgement", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
    await channel.waitForWrites(1);

    channel.respondToWrite(0, atxWireResult(), { duplicate: true });
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "DUPLICATE_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("preserves a definitive acknowledgement when its post-read failed", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
    await channel.waitForWrites(1);

    channel.respondToWrite(
      0,
      atxWireResult({ post_read_error: { code: "LED_READ_UNAVAILABLE" } }),
    );

    await expect(pending).resolves.toMatchObject({
      requestId: "request-a",
      serialSequenceCompleted: true,
      verification: "device_ack_only",
      postRead: { status: "unavailable" },
    });
  });

  it("classifies mid-flight loss and close after mutation write as unknown", async () => {
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel);
    const pending = adapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(),
    );
    await channel.waitForWrites(1);

    channel.close();
    const error = await pending.catch((caught) => caught);

    expectDeviceError(error, {
      code: "CONNECTION_LOST",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("cancels before write as not_sent and after write as unknown", async () => {
    const before = new AbortController();
    before.abort();
    const beforeChannel = new FakeDeviceRpcChannel();
    const beforeAdapter = new GenerationFencedDeviceRpcAdapter(
      BINDING,
      beforeChannel,
    );
    const beforeError = await beforeAdapter
      .performAtx(
        BINDING,
        { requestId: "request-a", action: "press_power" },
        deadline(1_000, before.signal),
      )
      .catch((caught) => caught);
    expectDeviceError(beforeError, {
      code: "CANCELLED",
      boundary: "admission",
      outcome: "not_sent",
    });

    const after = new AbortController();
    const afterChannel = new FakeDeviceRpcChannel();
    const afterAdapter = new GenerationFencedDeviceRpcAdapter(
      BINDING,
      afterChannel,
    );
    const pending = afterAdapter.performAtx(
      BINDING,
      { requestId: "request-a", action: "press_power" },
      deadline(1_000, after.signal),
    );
    await afterChannel.waitForWrites(1);
    after.abort();
    const afterError = await pending.catch((caught) => caught);
    expectDeviceError(afterError, {
      code: "CANCELLED",
      boundary: "ack",
      outcome: "unknown",
    });
  });

  it("ages only observed cached facts and preserves source-none facts", async () => {
    let nowMs = 10_000;
    const channel = new FakeDeviceRpcChannel();
    const adapter = new GenerationFencedDeviceRpcAdapter(BINDING, channel, {
      now: () => nowMs,
    });
    const first = adapter.readDisplayState(BINDING, deadline());
    await channel.waitForWrites(1);
    const wireResult = displayWireResult();
    channel.respondToWrite(0, {
      ...wireResult,
      resolution: { ...wireResult.resolution, age_ms: 20 },
      fps: {
        ...wireResult.fps,
        value: null,
        observed_at: null,
        age_ms: null,
        freshness: "unknown",
        source: "none",
      },
    });
    await first;
    nowMs += 1_250;
    channel.close();

    const cached = await adapter.readDisplayState(BINDING, deadline());

    expect(cached).toMatchObject({
      signal: { ageMs: 1_255, freshness: "stale" },
      resolution: { ageMs: 1_270, freshness: "stale" },
      fps: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      qualification: "binding_lost_cached_only",
    });
    expect(channel.writes()).toHaveLength(1);
    await expect(adapter.readEdid(BINDING, deadline())).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
    });
  });
});
