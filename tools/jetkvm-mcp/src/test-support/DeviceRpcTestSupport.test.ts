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
      name: "DeviceRpcError",
      code: "STALE_BINDING",
      boundary: "admission",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
    });
    expect(fake.binding).toEqual(next);
  });

  it.each(["connectionEpoch", "browserChannelGeneration"] as const)(
    "classifies a stale %s without pretending the session generation changed",
    async (field) => {
      const fake = new FakeDeviceRpcAdapter(binding);
      fake.replaceBinding({ ...binding, [field]: binding[field] + 1 });

      await expect(fake.readDisplayState(binding, deadline)).rejects.toEqual(
        expect.objectContaining({
          name: "DeviceRpcError",
          code: "STALE_BINDING",
          boundary: "admission",
          outcome: "not_sent",
          writeBegan: false,
          acknowledged: false,
        }),
      );
    },
  );

  it("keeps a genuinely stale session discriminated from an epoch/channel binding loss", async () => {
    const fake = new FakeDeviceRpcAdapter(binding);

    await expect(
      fake.readDisplayState(
        { ...binding, sessionGeneration: binding.sessionGeneration + 1 },
        deadline,
      ),
    ).rejects.toMatchObject({
      fault: "stale_generation",
      code: "STALE_SESSION_GENERATION",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    });
  });
  it("rejects an incoherent ATX result instead of letting the fake weaken provenance", async () => {
    const fake = new FakeDeviceRpcAdapter(binding);
    fake.loadScenario({
      version: 1,
      steps: [
        {
          operation: "performAtx",
          result: {
            ...atx,
            atxLedObservation: {
              power: true,
              hdd: false,
              observedAt: null,
              freshness: "fresh",
            },
          },
        },
      ],
    });

    await expect(
      fake.performAtx(
        binding,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).rejects.toThrow(/ATX result shape is invalid/i);
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

  it("rejects incoherent ATX provenance before constructing a replay adapter", () => {
    expect(
      () =>
        new ReplayDeviceRpcAdapter(binding, {
          version: 1,
          plane: "device_rpc",
          exchanges: [
            {
              operation: "performAtx",
              request: json({
                ref: binding,
                request: { requestId: "power-a", action: "press_power" },
              }),
              response: json({
                ...atx,
                atxLedObservation: {
                  power: true,
                  hdd: null,
                  observedAt: null,
                  freshness: "unknown",
                },
              }),
            },
          ],
        }),
    ).toThrow(/invalid sanitized replay tape/i);
  });

  it.each([
    ["sessionId", "session-b"],
    ["sessionGeneration", 99],
    ["connectionEpoch", 99],
    ["browserChannelGeneration", 99],
    ["extra", true],
  ] as const)(
    "rejects a stale %s without consuming the tape",
    async (field, value) => {
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
        replay.readDisplayState({ ...binding, [field]: value }, deadline),
      ).rejects.toMatchObject({ name: "ReplayMismatchError", index: 0 });
      await expect(replay.readDisplayState(binding, deadline)).resolves.toEqual(
        display,
      );
      expect(() => replay.assertExhausted()).not.toThrow();
    },
  );

  it.each([
    [{ ...binding, sessionId: "" }, "session id"],
    [{ ...binding, sessionGeneration: 0 }, "session generation"],
    [{ ...binding, connectionEpoch: 0 }, "connection epoch"],
    [{ ...binding, browserChannelGeneration: 0 }, "channel generation"],
    [{ ...binding, extra: true }, "extra constructor field"],
  ] as const)(
    "rejects an invalid constructor binding: %s",
    (candidate, _description) => {
      const tape: SanitizedReplayTape = {
        version: 1,
        plane: "device_rpc",
        exchanges: [],
      };

      expect(
        () => new ReplayDeviceRpcAdapter(candidate as DeviceRpcBinding, tape),
      ).toThrow(/binding is invalid/i);
    },
  );

  it("snapshots its constructor binding and never migrates to a replacement", async () => {
    const mutableBinding = { ...binding };
    const tape: SanitizedReplayTape = {
      version: 1,
      plane: "device_rpc",
      exchanges: [
        {
          operation: "readEdid",
          request: json({ ref: binding }),
          response: json(edid),
        },
      ],
    };
    const replay = new ReplayDeviceRpcAdapter(mutableBinding, tape);
    mutableBinding.connectionEpoch = 99;
    mutableBinding.browserChannelGeneration = 99;

    expect(replay.binding).toEqual(binding);
    await expect(
      replay.readEdid(mutableBinding, deadline),
    ).rejects.toMatchObject({ name: "ReplayMismatchError", index: 0 });
    await expect(replay.readEdid(binding, deadline)).resolves.toEqual(edid);
    expect(() => replay.assertExhausted()).not.toThrow();
  });
});
