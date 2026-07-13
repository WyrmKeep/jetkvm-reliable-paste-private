import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  AtxWireReceipt,
  CachedDisplayState,
  Deadline,
  DeviceRpcAdapter,
  DeviceRpcBinding,
  QualifiedEdidRead,
} from "../device/DeviceRpcAdapter.js";
import { BrowserPlaneReplay } from "./replay/BrowserPlaneReplay.js";
import { NativeControlPlaneReplay } from "./replay/NativeControlPlaneReplay.js";
import {
  ReplayMismatchError,
  validateSanitizedReplayTape,
  type JsonValue,
  type SanitizedReplayTape,
} from "./replay/SanitizedReplayTape.js";

const binding: DeviceRpcBinding = {
  sessionId: "session-a",
  sessionGeneration: 1,
  connectionEpoch: 2,
  browserChannelGeneration: 3,
};
const ref = { sessionId: "session-a", sessionGeneration: 1 };
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

class ReplayAdapter implements DeviceRpcAdapter {
  public readonly binding = binding;
  public readonly calls: string[] = [];

  public async readDisplayState(): Promise<CachedDisplayState> {
    this.calls.push("readDisplayState");
    return display;
  }

  public async readEdid(): Promise<QualifiedEdidRead> {
    this.calls.push("readEdid");
    return edid;
  }

  public async performAtx(): Promise<AtxWireReceipt> {
    this.calls.push("performAtx");
    return atx;
  }
}

function browserTape(
  exchanges: SanitizedReplayTape["exchanges"],
): SanitizedReplayTape {
  return { version: 1, plane: "browser", exchanges };
}

describe("sanitized versioned replay tapes", () => {
  it.each([
    ["url", "https://device.invalid"],
    ["credential", "private"],
    ["cookie", "private"],
    ["authorization", "Bearer private"],
    ["sdp", "v=0"],
    ["ice_candidate", "candidate:1"],
    ["frame_bytes", "aGVsbG8="],
    ["media_payload", "aGVsbG8="],
    ["paste_text", "private paste"],
    ["text", "private paste"],
  ])("rejects forbidden %s fields", (key, value) => {
    const tape = {
      version: 1,
      plane: "browser",
      exchanges: [
        {
          operation: "mouse",
          request: { [key]: value },
          response: { outcome: "applied" },
        },
      ],
    };

    expect(() => validateSanitizedReplayTape(tape)).toThrow(
      /forbidden replay tape content/i,
    );
  });

  it("rejects secret/topology values even under an innocuous key", () => {
    expect(() =>
      validateSanitizedReplayTape({
        version: 1,
        plane: "browser",
        exchanges: [
          {
            operation: "mouse",
            request: { note: "https://device.invalid/private" },
            response: {},
          },
        ],
      }),
    ).toThrow(/forbidden replay tape content/i);
  });

  it("rejects unknown versions and extra tape shape", () => {
    expect(() =>
      validateSanitizedReplayTape({
        version: 2,
        plane: "browser",
        exchanges: [],
      }),
    ).toThrow(/invalid sanitized replay tape/i);
    expect(() =>
      validateSanitizedReplayTape({
        version: 1,
        plane: "browser",
        exchanges: [],
        extra: true,
      }),
    ).toThrow(/invalid sanitized replay tape/i);
  });
});

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe("BrowserPlaneReplay", () => {
  it("consumes calls in exact order and rejects an unexpected operation", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        {
          operation: "mouse",
          request: {
            ref,
            request: {
              observationId: "observation-a",
              requestId: "request-a",
              actions: [{ type: "move", x: 1, y: 2 }],
            },
          },
          response: {
            requestId: "request-a",
            outcome: "applied",
            verification: "device_ack_only",
            dispatchedCount: 1,
            completedCount: 1,
            acknowledgedAt: "2026-07-13T00:00:00.000Z",
          },
        },
      ]),
    );

    await expect(replay.close(ref, deadline)).rejects.toMatchObject({
      name: "ReplayMismatchError",
      index: 0,
    });
    expect(() => replay.assertExhausted()).toThrow(/1 replay exchange/i);
  });

  it("rejects request shape drift rather than loosely matching", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        {
          operation: "mouse",
          request: {
            ref,
            request: {
              observationId: "observation-a",
              requestId: "request-a",
              actions: [{ type: "move", x: 1, y: 2 }],
            },
          },
          response: {},
        },
      ]),
    );

    await expect(
      replay.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 99, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toBeInstanceOf(ReplayMismatchError);
  });

  it("hashes paste text for matching without storing it in the tape", async () => {
    const text = "private paste";
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        {
          operation: "paste",
          request: {
            ref,
            request: {
              observationId: "observation-a",
              requestId: "request-a",
              textByteLength: Buffer.byteLength(text),
              textSha256: createHash("sha256").update(text).digest("hex"),
            },
          },
          response: {
            requestId: "request-a",
            outcome: "applied",
            verification: "device_ack_only",
            dispatchedCount: 1,
            completedCount: 1,
            acknowledgedAt: "2026-07-13T00:00:00.000Z",
            originalByteCount: Buffer.byteLength(text),
            normalizedByteCount: Buffer.byteLength(text),
            normalizedSha256: createHash("sha256").update(text).digest("hex"),
            acceptedAt: "2026-07-13T00:00:00.000Z",
            completedAt: "2026-07-13T00:00:01.000Z",
            terminalState: "succeeded",
            measuredCharsPerSecond: 91,
          },
        },
      ]),
    );

    await expect(
      replay.paste(
        ref,
        { observationId: "observation-a", requestId: "request-a", text },
        deadline,
      ),
    ).resolves.toMatchObject({ requestId: "request-a", outcome: "applied" });
    expect(() => replay.assertExhausted()).not.toThrow();
  });
});

describe("NativeControlPlaneReplay", () => {
  it("validates the plane tape while consuming the exact shared adapter contract", async () => {
    const adapter = new ReplayAdapter();
    const tape: SanitizedReplayTape = {
      version: 1,
      plane: "native",
      exchanges: [
        {
          operation: "displayStatus",
          request: { ref },
          response: jsonValue({ ...display, edid }),
        },
        {
          operation: "powerControl",
          request: {
            ref,
            request: { requestId: "power-a", action: "press_power" },
          },
          response: jsonValue(atx),
        },
      ],
    };
    const replay = new NativeControlPlaneReplay(adapter, tape);

    await expect(replay.displayStatus(ref, deadline)).resolves.toEqual({
      ...display,
      edid,
    });
    await expect(
      replay.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).resolves.toEqual(atx);
    expect(adapter.calls).toEqual([
      "readDisplayState",
      "readEdid",
      "performAtx",
    ]);
    expect(replay.deviceRpc).toBe(adapter);
    expect(() => replay.assertExhausted()).not.toThrow();
  });

  it("fails closed if the adapter result differs from the proven tape", async () => {
    const adapter = new ReplayAdapter();
    const tape: SanitizedReplayTape = {
      version: 1,
      plane: "native",
      exchanges: [
        {
          operation: "displayStatus",
          request: { ref },
          response: jsonValue({
            ...display,
            qualification: "binding_lost_cached_only",
            edid,
          }),
        },
      ],
    };
    const replay = new NativeControlPlaneReplay(adapter, tape);

    await expect(replay.displayStatus(ref, deadline)).rejects.toBeInstanceOf(
      ReplayMismatchError,
    );
  });
});
