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
  SanitizedReplayCursor,
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
    ["targetUrl", "https://device.invalid"],
    ["device_url_suffix", "https://device.invalid"],
    ["credential", "private"],
    ["clientCredentials", "private"],
    ["credential_backup", "private"],
    ["cookie", "private"],
    ["authorization", "Bearer private"],
    ["authHeader", "private"],
    ["deviceAuthConfig", "private"],
    ["requestHeaders", "private"],
    ["headers", "private"],
    ["raw_request_headers_copy", "private"],
    ["sdp", "v=0"],
    ["localSdpOffer", "v=0"],
    ["ice_candidate", "candidate:1"],
    ["remoteIceCandidates", "candidate:1"],
    ["prefixedIceServers", "private"],
    ["frame_bytes", "aGVsbG8="],
    ["capturedFrameData", "aGVsbG8="],
    ["screenshotBase64", "aGVsbG8="],
    ["encodedMediaPayload", "aGVsbG8="],
    ["media_payload", "aGVsbG8="],
    ["paste_text", "private paste"],
    ["normalizedPasteText", "private paste"],
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

  it("enforces plane-specific operations and strict request and response allowlists", () => {
    const validExchange = {
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
    } as const;

    expect(() =>
      validateSanitizedReplayTape(browserTape([validExchange])),
    ).not.toThrow();
    for (const exchange of [
      { ...validExchange, operation: "readEdid" },
      {
        ...validExchange,
        request: { ...validExchange.request, harmlessMetadata: true },
      },
      {
        ...validExchange,
        response: { ...validExchange.response, harmlessMetadata: true },
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(browserTape([exchange])),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("preserves recorded mutation boundaries and rejects collapsed outcomes", () => {
    const request = {
      ref,
      request: {
        observationId: "observation-a",
        requestId: "request-a",
        actions: [{ type: "move", x: 1, y: 2 }],
      },
    };
    const beforeWrite = {
      code: "CONNECTION_LOST",
      boundary: "send",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      dispatchedCount: 0,
      completedCount: 0,
    } as const;
    const afterWrite = {
      code: "CONNECTION_LOST",
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
      dispatchedCount: 1,
      completedCount: 0,
    } as const;
    const acknowledgedFailure = {
      code: "POST_ACK_READ_FAILED",
      boundary: "post_ack",
      outcome: "applied",
      writeBegan: true,
      acknowledged: true,
      verification: "device_ack_only",
      dispatchedCount: 1,
      completedCount: 1,
    } as const;

    for (const error of [beforeWrite, afterWrite, acknowledgedFailure]) {
      const cursor = new SanitizedReplayCursor(
        browserTape([{ operation: "mouse", request, error }]),
        "browser",
      );
      expect(() => cursor.consume("mouse", request)).toThrowError(
        expect.objectContaining(error),
      );
      expect(() => cursor.assertExhausted()).not.toThrow();
    }

    expect(() =>
      validateSanitizedReplayTape({
        version: 1,
        plane: "browser",
        exchanges: [
          {
            operation: "mouse",
            request,
            error: { ...beforeWrite, code: "UNRECOGNIZED_ERROR_CODE" },
          },
        ],
      }),
    ).toThrow(/invalid sanitized replay tape/i);

    for (const error of [
      { ...beforeWrite, outcome: "unknown" },
      { ...afterWrite, outcome: "not_sent" },
      { ...afterWrite, acknowledged: true },
      { ...afterWrite, verification: "device_ack_only" },
      { ...afterWrite, completedCount: 2 },
      { ...afterWrite, completedCount: undefined },
    ]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [{ operation: "mouse", request, error }],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("accepts every production DeviceRpc error discriminant and rejects code-boundary substitutions", () => {
    const notSent = (
      code: string,
      boundary: "admission" | "queue" | "send",
    ) => ({
      code,
      boundary,
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
    });
    const unknown = (code: string) => ({
      code,
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
    });
    const readRequest = { ref: binding };
    const atxRequest = {
      ref: binding,
      request: { requestId: "power-a", action: "press_power" },
    };
    const legal = [
      ["readEdid", readRequest, notSent("INVALID_BINDING", "admission")],
      ["readEdid", readRequest, notSent("INVALID_DEADLINE", "admission")],
      ["readEdid", readRequest, notSent("STALE_BINDING", "admission")],
      ["performAtx", atxRequest, notSent("INVALID_REQUEST", "admission")],
      ["readEdid", readRequest, notSent("BINDING_REPLACED", "queue")],
      ["readEdid", readRequest, notSent("BINDING_REPLACED", "send")],
      ["readEdid", readRequest, unknown("BINDING_REPLACED")],
      ["readEdid", readRequest, notSent("CANCELLED", "admission")],
      ["readEdid", readRequest, notSent("CANCELLED", "queue")],
      ["readEdid", readRequest, notSent("CANCELLED", "send")],
      ["readEdid", readRequest, unknown("CANCELLED")],
      ["readEdid", readRequest, notSent("DEADLINE_EXCEEDED", "queue")],
      ["readEdid", readRequest, notSent("DEADLINE_EXCEEDED", "send")],
      ["readEdid", readRequest, unknown("DEADLINE_EXCEEDED")],
      ["readEdid", readRequest, notSent("CONNECTION_LOST", "admission")],
      ["readEdid", readRequest, notSent("CONNECTION_LOST", "queue")],
      ["readEdid", readRequest, notSent("CONNECTION_LOST", "send")],
      ["readEdid", readRequest, unknown("CONNECTION_LOST")],
      ["readEdid", readRequest, notSent("WRITE_REJECTED", "send")],
      ["readEdid", readRequest, notSent("MALFORMED_RESPONSE", "send")],
      ["readEdid", readRequest, unknown("MALFORMED_RESPONSE")],
      ["readEdid", readRequest, unknown("DUPLICATE_RESPONSE")],
      ["readEdid", readRequest, unknown("DOWNSTREAM_ERROR")],
    ] as const;

    for (const [operation, request, error] of legal) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "device_rpc",
          exchanges: [{ operation, request, error }],
        }),
      ).not.toThrow();
    }

    const illegal = [
      ["readEdid", readRequest, unknown("STALE_BINDING")],
      ["readEdid", readRequest, notSent("INVALID_BINDING", "queue")],
      ["readEdid", readRequest, unknown("INVALID_DEADLINE")],
      ["readEdid", readRequest, notSent("INVALID_REQUEST", "admission")],
      ["readEdid", readRequest, notSent("BINDING_REPLACED", "admission")],
      ["readEdid", readRequest, notSent("DEADLINE_EXCEEDED", "admission")],
      [
        "readEdid",
        readRequest,
        {
          code: "CONNECTION_LOST",
          boundary: "persisted",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
        },
      ],
      ["readEdid", readRequest, unknown("WRITE_REJECTED")],
      [
        "readEdid",
        readRequest,
        {
          code: "MALFORMED_RESPONSE",
          boundary: "post_ack",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
        },
      ],
      ["readEdid", readRequest, notSent("DUPLICATE_RESPONSE", "send")],
      ["readEdid", readRequest, notSent("DOWNSTREAM_ERROR", "send")],
    ] as const;

    for (const [operation, request, error] of illegal) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "device_rpc",
          exchanges: [{ operation, request, error }],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("constrains high-level replay errors by plane, operation, and exact counts", () => {
    const cases = [
      {
        accepted: true,
        plane: "browser",
        operation: "connect",
        request: { ref },
        error: {
          code: "CONTROL_BUSY",
          boundary: "admission",
          outcome: "not_sent",
          writeBegan: false,
          acknowledged: false,
          verification: "none",
        },
      },
      {
        accepted: true,
        plane: "browser",
        operation: "mouse",
        request: {
          ref,
          request: {
            observationId: "observation-a",
            requestId: "request-a",
            actions: [{ type: "move", x: 1, y: 2 }],
          },
        },
        error: {
          code: "PARTIAL_DISPATCH",
          boundary: "ack",
          outcome: "unknown",
          writeBegan: true,
          acknowledged: false,
          verification: "none",
          dispatchedCount: 2,
          completedCount: 1,
        },
      },
      {
        accepted: true,
        plane: "native",
        operation: "powerControl",
        request: {
          ref,
          request: { requestId: "power-a", action: "press_power" },
        },
        error: {
          code: "POST_ACK_READ_FAILED",
          boundary: "post_ack",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
        },
      },
      {
        accepted: false,
        plane: "browser",
        operation: "capture",
        request: {
          ref,
          request: { requestId: "capture-a", format: "jpeg", quality: 80 },
        },
        error: {
          code: "PARTIAL_DISPATCH",
          boundary: "ack",
          outcome: "unknown",
          writeBegan: true,
          acknowledged: false,
          verification: "none",
        },
      },
      {
        accepted: false,
        plane: "browser",
        operation: "release",
        request: { ref, request: { requestId: "release-a" } },
        error: {
          code: "FRESH_CAPTURE_REQUIRED",
          boundary: "admission",
          outcome: "not_sent",
          writeBegan: false,
          acknowledged: false,
          verification: "none",
          dispatchedCount: 0,
          completedCount: 0,
        },
      },
      {
        accepted: false,
        plane: "native",
        operation: "displayStatus",
        request: { ref },
        error: {
          code: "POST_ACK_READ_FAILED",
          boundary: "post_ack",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const validate = () =>
        validateSanitizedReplayTape({
          version: 1,
          plane: testCase.plane,
          exchanges: [
            {
              operation: testCase.operation,
              request: testCase.request,
              error: testCase.error,
            },
          ],
        });
      if (testCase.accepted) expect(validate).not.toThrow();
      else expect(validate).toThrow(/invalid sanitized replay tape/i);
    }

    const mouseRequest = {
      ref,
      request: {
        observationId: "observation-a",
        requestId: "request-a",
        actions: [{ type: "move", x: 1, y: 2 }],
      },
    };
    const impossibleCounts = [
      {
        code: "CONNECTION_LOST",
        boundary: "send",
        outcome: "not_sent",
        writeBegan: false,
        acknowledged: false,
        verification: "none",
        dispatchedCount: 1,
        completedCount: 0,
      },
      {
        code: "PARTIAL_DISPATCH",
        boundary: "ack",
        outcome: "unknown",
        writeBegan: true,
        acknowledged: false,
        verification: "none",
        dispatchedCount: 1,
        completedCount: 1,
      },
      {
        code: "POST_ACK_READ_FAILED",
        boundary: "post_ack",
        outcome: "applied",
        writeBegan: true,
        acknowledged: true,
        verification: "device_ack_only",
        dispatchedCount: 2,
        completedCount: 1,
      },
    ] as const;

    for (const error of impossibleCounts) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([{ operation: "mouse", request: mouseRequest, error }]),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("requires every replayed ATX receipt to correlate and use the exact semantic wire mapping", () => {
    const semantics = [
      ["press_power", "power-short", 200],
      ["hold_power", "power-long", 5000],
      ["press_reset", "reset", 200],
    ] as const;

    for (const [action, wireAction, fixedPressMs] of semantics) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "device_rpc",
          exchanges: [
            {
              operation: "performAtx",
              request: {
                ref: binding,
                request: { requestId: `request-${action}`, action },
              },
              response: {
                ...atx,
                requestId: `request-${action}`,
                action,
                wireAction,
                fixedPressMs,
              },
            },
          ],
        }),
      ).not.toThrow();
    }

    const request = {
      ref: binding,
      request: { requestId: "power-a", action: "press_power" },
    };
    for (const response of [
      { ...atx, requestId: "power-b" },
      { ...atx, action: "hold_power" },
      { ...atx, wireAction: "reset" },
      { ...atx, fixedPressMs: 5000 },
    ]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "device_rpc",
          exchanges: [{ operation: "performAtx", request, response }],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
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
