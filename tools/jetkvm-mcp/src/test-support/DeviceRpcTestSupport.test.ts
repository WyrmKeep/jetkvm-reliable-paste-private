import { describe, expect, it } from "vitest";

import type {
  AtxWireReceipt,
  CachedDisplayState,
  Deadline,
  DeviceRpcBinding,
  QualifiedEdidRead,
} from "../device/DeviceRpcAdapter.js";
import { FakeDeviceRpcAdapter } from "./fakes/FakeDeviceRpcAdapter.js";
import { ReplayDeviceRpcAdapter } from "./replay/ReplayDeviceRpcAdapter.js";
import type { SanitizedReplayTape } from "./replay/SanitizedReplayTape.js";

const binding: DeviceRpcBinding = {
  sessionId: "session-a",
  sessionGeneration: 1,
  connectionEpoch: 2,
  browserChannelGeneration: 3,
};
const deadline: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const display: CachedDisplayState = {
  signal: {
    value: "present",
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  resolution: {
    value: { width: 1920, height: 1080, refreshHz: 60 },
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  fps: {
    value: 60,
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  qualification: "current_binding",
};
const edid: QualifiedEdidRead = {
  status: "unsupported",
  readCompleted: false,
  reason: "edid_read_capability_absent",
  observedAt: null,
  data: null,
};
const atx: AtxWireReceipt = {
  requestId: "power-a",
  action: "press_power",
  wireAction: "power-short",
  fixedPressMs: 200,
  serialSequenceCompleted: true,
  acknowledgedAt: "2026-07-13T00:00:00.000Z",
  atxLedObservation: {
    power: null,
    hdd: null,
    observedAt: null,
    freshness: "unknown",
  },
  verification: "device_ack_only",
  postRead: { status: "unavailable" },
};

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as never;
}

describe("FakeDeviceRpcAdapter", () => {
  it("implements the same typed calls and replacement contract as the real adapter", async () => {
    const fake = new FakeDeviceRpcAdapter(binding);
    fake.loadScenario({
      version: 1,
      steps: [
        { operation: "readDisplayState", result: display },
        { operation: "readEdid", result: edid },
        { operation: "performAtx", result: atx },
      ],
    });

    await expect(fake.readDisplayState(binding, deadline)).resolves.toEqual(
      display,
    );
    await expect(fake.readEdid(binding, deadline)).resolves.toEqual(edid);
    await expect(
      fake.performAtx(
        binding,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).resolves.toEqual(atx);
    expect(fake.events()).toHaveLength(3);
    expect(() => fake.assertExhausted()).not.toThrow();

    const next = { ...binding, connectionEpoch: 4 };
    fake.replaceBinding(next);
    await expect(fake.readEdid(binding, deadline)).rejects.toMatchObject({
      fault: "stale_generation",
      outcome: "not_sent",
    });
    expect(fake.binding).toEqual(next);
  });
});

describe("ReplayDeviceRpcAdapter", () => {
  it("strictly replays typed adapter calls and rejects changed binding shape", async () => {
    const tape: SanitizedReplayTape = {
      version: 1,
      plane: "device_rpc",
      exchanges: [
        {
          operation: "readDisplayState",
          request: json({ ref: binding }),
          response: json(display),
        },
        {
          operation: "readEdid",
          request: json({ ref: binding }),
          response: json(edid),
        },
        {
          operation: "performAtx",
          request: json({
            ref: binding,
            request: { requestId: "power-a", action: "press_power" },
          }),
          response: json(atx),
        },
      ],
    };
    const replay = new ReplayDeviceRpcAdapter(binding, tape);

    await expect(replay.readDisplayState(binding, deadline)).resolves.toEqual(
      display,
    );
    await expect(replay.readEdid(binding, deadline)).resolves.toEqual(edid);
    await expect(
      replay.performAtx(
        binding,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).resolves.toEqual(atx);
    expect(() => replay.assertExhausted()).not.toThrow();
  });

  it("rejects an unexpected epoch without consuming the tape", async () => {
    const tape: SanitizedReplayTape = {
      version: 1,
      plane: "device_rpc",
      exchanges: [
        {
          operation: "readDisplayState",
          request: json({ ref: binding }),
          response: json(display),
        },
      ],
    };
    const replay = new ReplayDeviceRpcAdapter(binding, tape);

    await expect(
      replay.readDisplayState({ ...binding, connectionEpoch: 99 }, deadline),
    ).rejects.toMatchObject({ name: "ReplayMismatchError", index: 0 });
    expect(() => replay.assertExhausted()).toThrow(/1 replay exchange/i);
  });
});
