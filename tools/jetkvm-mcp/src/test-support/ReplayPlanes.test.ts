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

function browserObservation(
  mimeType: "image/jpeg" | "image/png",
  byteLength: number,
  sessionGeneration = ref.sessionGeneration,
) {
  return {
    observationId: "observation-a",
    sessionId: ref.sessionId,
    sessionGeneration,
    connectionEpoch: 1,
    displayGeneration: 1,
    frameId: "frame-a",
    capturedAt: "2026-07-13T00:00:00.000Z",
    monotonicAgeMs: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    imageWidth: 1920,
    imageHeight: 1080,
    rotation: 0,
    geometry: {
      contentX: 0,
      contentY: 0,
      contentWidth: 1920,
      contentHeight: 1080,
    },
    format: mimeType === "image/jpeg" ? ("jpeg" as const) : ("png" as const),
    sha256: "a".repeat(64),
    byteLength,
  };
}

function browserConnection(sessionId = ref.sessionId) {
  return {
    state: "ready",
    ref: { sessionId, sessionGeneration: ref.sessionGeneration },
    binding: {
      sessionId,
      sessionGeneration: ref.sessionGeneration,
      connectionEpoch: 1,
      browserChannelGeneration: 1,
    },
    connectionEpoch: 1,
    browserChannelGeneration: 1,
    displayGeneration: 1,
  };
}

const browserMutationRequests = {
  mouse: {
    ref,
    request: {
      observationId: "observation-a",
      requestId: "mouse-request",
      actions: [
        { type: "move", x: 1, y: 2 },
        { type: "move", x: 3, y: 4 },
      ],
    },
  },
  keyboard: {
    ref,
    request: {
      observationId: "observation-a",
      requestId: "keyboard-request",
      actions: [
        { type: "key_press", key: "KeyA" },
        { type: "key_press", key: "KeyB" },
      ],
    },
  },
  paste: {
    ref,
    request: {
      observationId: "observation-a",
      requestId: "paste-request",
      originalByteCount: 4,
      originalSha256: "b".repeat(64),
      normalizedByteCount: 4,
      normalizedSha256: "b".repeat(64),
    },
  },
  release: {
    ref,
    request: { requestId: "release-request" },
  },
} as const;

function browserMutationReceipt(requestId: string) {
  return {
    requestId,
    outcome: "applied",
    verification: "device_ack_only",
    dispatchedCount: 1,
    completedCount: 1,
    acknowledgedAt: "2026-07-13T00:00:00.000Z",
  };
}

function browserPasteReceipt(requestId: string) {
  return {
    ...browserMutationReceipt(requestId),
    originalByteCount: 4,
    normalizedByteCount: 4,
    normalizedSha256: "b".repeat(64),
    acceptedAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:01.000Z",
    terminalState: "succeeded",
    measuredCharsPerSecond: 91,
  };
}

function browserReleaseReceipt(requestId: string) {
  return {
    ...browserMutationReceipt(requestId),
    mutationGateClosed: true,
    deferredProducersJoined: true,
    pasteTerminal: "inactive",
    ordinaryLeasesZero: true,
    keyboardZero: true,
    pointerZero: true,
    generationDrained: true,
    heldKeys: [],
  };
}

function replayRecovery(
  code: string,
  outcome: "not_sent" | "unknown" | "applied" | "already_applied",
) {
  if (code === "PARTIAL_VERIFICATION") {
    return { safeToRetry: false, requiredNextStep: "none" as const };
  }
  if (outcome !== "not_sent") {
    return {
      safeToRetry: false,
      requiredNextStep:
        code === "SESSION_TAKEN_OVER" || code === "EVENT_GAP"
          ? ("release_then_reconnect_then_capture" as const)
          : ("inspect_device_state_before_retry" as const),
    };
  }
  if (code === "CONNECTION_LOST" || code === "DEVICE_UNREACHABLE") {
    return {
      safeToRetry: true,
      requiredNextStep: "reconnect_then_capture" as const,
    };
  }
  if (code === "STALE_SESSION_GENERATION") {
    return {
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture" as const,
    };
  }
  if (code === "STALE_OBSERVATION") {
    return {
      safeToRetry: true,
      requiredNextStep: "capture_then_retry" as const,
    };
  }
  if (code === "PERMISSION_DENIED") {
    return {
      safeToRetry: false,
      requiredNextStep: "grant_permission" as const,
    };
  }
  if (code === "CAPABILITY_MISSING") {
    return {
      safeToRetry: false,
      requiredNextStep: "enable_capability" as const,
    };
  }
  if (code === "CONTROL_BUSY") {
    return {
      safeToRetry: true,
      requiredNextStep: "wait_or_request_takeover" as const,
    };
  }
  return {
    safeToRetry:
      code === "AUTH_RATE_LIMITED" ||
      code === "CANCELLED" ||
      code === "DEADLINE_EXCEEDED",
    requiredNextStep: "none" as const,
  };
}

describe("sanitized versioned replay tapes", () => {
  it("enforces MIME-specific capture limits and definitive response correlation", () => {
    const captureCases = [
      ["jpeg", "image/jpeg", 2 * 1024 * 1024],
      ["png", "image/png", 8 * 1024 * 1024],
    ] as const;

    for (const [format, mimeType, maximum] of captureCases) {
      const request = {
        ref,
        request: { format, maxWidth: 1920, maxHeight: 1080 },
      };
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([
            {
              operation: "capture",
              request,
              response: browserObservation(mimeType, maximum),
            },
          ]),
        ),
      ).not.toThrow();
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation: "capture",
              request,
              response: browserObservation(mimeType, maximum + 1),
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);

      const otherMimeType =
        mimeType === "image/jpeg" ? "image/png" : "image/jpeg";
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation: "capture",
              request,
              response: browserObservation(otherMimeType, 1),
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation: "capture",
              request,
              response: browserObservation(
                mimeType,
                maximum,
                ref.sessionGeneration + 1,
              ),
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    for (const operation of ["connect", "reconnect"] as const) {
      const valid = {
        operation,
        request: { ref },
        response: browserConnection(),
      };
      expect(() =>
        validateSanitizedReplayTape(browserTape([valid])),
      ).not.toThrow();
      for (const response of [
        browserConnection("session-b"),
        {
          ...browserConnection(),
          binding: {
            ...browserConnection().binding,
            connectionEpoch: 2,
          },
        },
        {
          ...browserConnection(),
          browserChannelGeneration: 2,
        },
      ]) {
        expect(() =>
          validateSanitizedReplayTape({
            version: 1,
            plane: "browser",
            exchanges: [{ ...valid, response }],
          }),
        ).toThrow(/invalid sanitized replay tape/i);
      }
    }
  });

  it("correlates capture scaling, containment, no-upscale, and aspect ratio", () => {
    const request = {
      ref,
      request: { format: "jpeg" as const, maxWidth: 1280, maxHeight: 720 },
    };
    const base = {
      ...browserObservation("image/jpeg", 1),
      imageWidth: 1280,
      imageHeight: 720,
      geometry: {
        contentX: 0,
        contentY: 0,
        contentWidth: 1280,
        contentHeight: 720,
      },
    };

    expect(() =>
      validateSanitizedReplayTape(
        browserTape([{ operation: "capture", request, response: base }]),
      ),
    ).not.toThrow();
    for (const response of [
      { ...base, imageWidth: 1281 },
      { ...base, imageWidth: 1200 },
      {
        ...base,
        sourceWidth: 1000,
        sourceHeight: 500,
        imageWidth: 1100,
        imageHeight: 550,
      },
      {
        ...base,
        geometry: { ...base.geometry, contentX: 1, contentWidth: 1280 },
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([{ operation: "capture", request, response }]),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("accepts only nonzero integer vertical scroll within HID bounds and horizontal zero", () => {
    const makeExchange = (action: Record<string, unknown>) => ({
      operation: "mouse",
      request: {
        ref,
        request: {
          observationId: "observation-a",
          requestId: "scroll-request",
          actions: [action],
        },
      },
      response: browserMutationReceipt("scroll-request"),
    });

    for (const delta_y of [-127, -1, 1, 127]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [makeExchange({ type: "scroll", x: 0, y: 0, delta_y })],
        }),
      ).not.toThrow();
    }
    expect(() =>
      validateSanitizedReplayTape({
        version: 1,
        plane: "browser",
        exchanges: [
          makeExchange({
            type: "scroll",
            x: 0,
            y: 0,
            delta_y: 1,
            delta_x: 0,
          }),
        ],
      }),
    ).not.toThrow();

    for (const action of [
      { type: "scroll", x: 0, y: 0, delta_y: -128 },
      { type: "scroll", x: 0, y: 0, delta_y: 0 },
      { type: "scroll", x: 0, y: 0, delta_y: 128 },
      { type: "scroll", x: 0, y: 0, delta_y: 1.5 },
      { type: "scroll", x: 0, y: 0, delta_y: 1, delta_x: 1 },
      { type: "scroll", x: 0, y: 0, delta_y: 1, extra: true },
    ]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [makeExchange(action)],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("enforces exact action, nested chord, and drag bounds", () => {
    const exchange = (
      operation: "mouse" | "keyboard",
      actions: readonly JsonValue[],
    ) => ({
      operation,
      request: {
        ref,
        request: {
          observationId: "observation-a",
          requestId: `${operation}-bounds`,
          actions,
        },
      },
      response: {
        ...browserMutationReceipt(`${operation}-bounds`),
        dispatchedCount: actions.length,
        completedCount: actions.length,
      },
    });
    const key = { type: "key_press", key: "KeyA" };
    const point = { x: 1, y: 1 };

    for (const candidate of [
      exchange("keyboard", []),
      exchange(
        "keyboard",
        Array.from({ length: 65 }, () => key),
      ),
      exchange("keyboard", [{ type: "chord", keys: [] }]),
      exchange("keyboard", [
        { type: "chord", keys: Array.from({ length: 9 }, () => "KeyA") },
      ]),
      exchange("mouse", []),
      exchange(
        "mouse",
        Array.from({ length: 17 }, () => ({ type: "move", x: 1, y: 1 })),
      ),
      exchange("mouse", [{ type: "drag", button: "left", path: [point] }]),
      exchange("mouse", [
        {
          type: "drag",
          button: "left",
          path: Array.from({ length: 65 }, () => point),
        },
      ]),
    ]) {
      expect(() =>
        validateSanitizedReplayTape(browserTape([candidate])),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("enforces canonical opaque IDs and safe integers in replay mirrors", () => {
    for (const sessionId of [
      " invalid",
      `a${"b".repeat(128)}`,
      "invalid/slash",
    ]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([
            {
              operation: "connect",
              request: { ref: { ...ref, sessionId } },
              response: browserConnection(sessionId),
            },
          ]),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "connect",
            request: { ref },
            response: {
              ...browserConnection(),
              binding: {
                ...browserConnection().binding,
                connectionEpoch: Number.MAX_SAFE_INTEGER + 1,
              },
              connectionEpoch: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ]),
      ),
    ).toThrow(/invalid sanitized replay tape/i);
  });

  it("requires every browser mutation receipt to match its nested request ID", () => {
    const responses = {
      mouse: browserMutationReceipt("mouse-response"),
      keyboard: browserMutationReceipt("keyboard-response"),
      paste: browserPasteReceipt("paste-response"),
      release: browserReleaseReceipt("release-response"),
    } as const;

    for (const operation of [
      "mouse",
      "keyboard",
      "paste",
      "release",
    ] as const) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation,
              request: browserMutationRequests[operation],
              response: responses[operation],
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("accepts generation zero while preserving the other connection and capture fences", () => {
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "connect",
            request: { ref },
            response: { ...browserConnection(), displayGeneration: 0 },
          },
          {
            operation: "capture",
            request: {
              ref,
              request: { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
            },
            response: {
              ...browserObservation("image/jpeg", 1),
              displayGeneration: 0,
            },
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("requires a safe nonnegative monotonic observation age and one root artifact representation", () => {
    const valid = browserObservation("image/jpeg", 1);
    const { monotonicAgeMs: _age, ...missingAge } = valid;
    for (const response of [
      missingAge,
      { ...valid, monotonicAgeMs: -1 },
      { ...valid, monotonicAgeMs: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...valid,
        artifact: {
          mimeType: "image/jpeg",
          sha256: valid.sha256,
          byteLength: valid.byteLength,
        },
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([
            {
              operation: "capture",
              request: {
                ref,
                request: { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
              },
              response,
            },
          ]),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("requires strict cached-versus-unobserved fact metadata and qualified binding-loss freshness", () => {
    const nativeStatusTape = (candidate: CachedDisplayState) => ({
      version: 1 as const,
      plane: "native" as const,
      exchanges: [
        {
          operation: "sessionStatus",
          request: { ref },
          response: {
            rpcReachability:
              candidate.qualification === "binding_lost_cached_only"
                ? "unreachable"
                : "reachable",
            nativeProcess:
              candidate.qualification === "binding_lost_cached_only"
                ? "unknown"
                : "available",
            display: candidate,
          },
        },
      ],
    });
    const unknownSignal = {
      value: "unknown" as const,
      observedAt: null,
      ageMs: null,
      freshness: "unknown" as const,
      source: "none" as const,
    };

    expect(() =>
      validateSanitizedReplayTape(
        nativeStatusTape({ ...display, signal: unknownSignal }),
      ),
    ).not.toThrow();
    for (const signal of [
      { ...display.signal, source: "none" },
      { ...display.signal, freshness: "unknown" },
      { ...unknownSignal, source: "cached_event" },
      {
        ...unknownSignal,
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(
          nativeStatusTape({ ...display, signal } as CachedDisplayState),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    for (const candidate of [
      { ...display, signal: { ...unknownSignal, value: "present" as const } },
      {
        ...display,
        resolution: {
          value: { width: 1, height: 1, refreshHz: null },
          observedAt: null,
          ageMs: null,
          freshness: "unknown" as const,
          source: "none" as const,
        },
      },
      {
        ...display,
        fps: {
          value: 60,
          observedAt: null,
          ageMs: null,
          freshness: "unknown" as const,
          source: "none" as const,
        },
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(nativeStatusTape(candidate)),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    const lostBinding = {
      ...display,
      qualification: "binding_lost_cached_only" as const,
    };
    expect(() =>
      validateSanitizedReplayTape(nativeStatusTape(lostBinding)),
    ).toThrow(/invalid sanitized replay tape/i);
    expect(() =>
      validateSanitizedReplayTape(
        nativeStatusTape({
          ...lostBinding,
          signal: { ...display.signal, freshness: "stale" },
          resolution: { ...display.resolution, freshness: "stale" },
          fps: { ...display.fps, freshness: "stale" },
        }),
      ),
    ).not.toThrow();
  });

  it("records only public plane errors and preserves their exact recovery tuple", () => {
    const malformed = {
      code: "DOWNSTREAM_MALFORMED_RESPONSE",
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
    } as const;
    const malformedBeforeWrite = {
      code: "DOWNSTREAM_MALFORMED_RESPONSE",
      boundary: "send",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    } as const;
    const stale = {
      code: "STALE_SESSION_GENERATION",
      boundary: "admission",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    } as const;

    for (const error of [malformed, malformedBeforeWrite, stale]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([{ operation: "connect", request: { ref }, error }]),
        ),
      ).not.toThrow();
      const cursor = new SanitizedReplayCursor(
        browserTape([{ operation: "connect", request: { ref }, error }]),
        "browser",
      );
      expect(() => cursor.consume("connect", { ref })).toThrow(
        expect.objectContaining({
          code: error.code,
          outcome: error.outcome,
          safeToRetry: error.safeToRetry,
          requiredNextStep: error.requiredNextStep,
        }),
      );
    }

    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "mouse",
            request: browserMutationRequests.mouse,
            error: {
              ...malformedBeforeWrite,
              dispatchedCount: 0,
              completedCount: 0,
            },
          },
        ]),
      ),
    ).not.toThrow();

    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "connect",
            request: { ref },
            error: {
              ...malformed,
              code: "MALFORMED_RESPONSE",
            },
          },
        ]),
      ),
    ).toThrow(/invalid sanitized replay tape/i);
  });

  it("correlates every success and error count with the operation request", () => {
    const mouseExchange = {
      operation: "mouse",
      request: browserMutationRequests.mouse,
      response: browserMutationReceipt("mouse-request"),
    };
    expect(() =>
      validateSanitizedReplayTape(browserTape([mouseExchange])),
    ).toThrow(/invalid sanitized replay tape/i);
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            ...mouseExchange,
            response: {
              ...mouseExchange.response,
              dispatchedCount: 2,
              completedCount: 2,
            },
          },
        ]),
      ),
    ).not.toThrow();

    const unicodePaste = {
      ...browserMutationRequests.paste,
      request: {
        ...browserMutationRequests.paste.request,
        originalByteCount: 7,
        normalizedByteCount: 7,
      },
    };
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "paste",
            request: unicodePaste,
            response: browserPasteReceipt("paste-request"),
          },
        ]),
      ),
    ).toThrow(/invalid sanitized replay tape/i);
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "paste",
            request: unicodePaste,
            response: {
              ...browserPasteReceipt("paste-request"),
              dispatchedCount: 7,
              completedCount: 7,
              originalByteCount: 7,
              normalizedByteCount: 7,
            },
          },
        ]),
      ),
    ).not.toThrow();

    const partial = {
      code: "MUTATION_OUTCOME_UNKNOWN",
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
      requestedCount: 2,
      dispatchedCount: 2,
      completedCount: 1,
      failedIndex: 1,
    } as const;
    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "mouse",
            request: browserMutationRequests.mouse,
            error: partial,
          },
        ]),
      ),
    ).not.toThrow();
    for (const error of [
      { ...partial, requestedCount: 1 },
      { ...partial, failedIndex: 0 },
      { ...partial, dispatchedCount: 3 },
      { ...partial, dispatchedCount: 1 },
    ]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([
            {
              operation: "mouse",
              request: browserMutationRequests.mouse,
              error,
            },
          ]),
        ),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    for (const dispatchedCount of [1, 2]) {
      expect(() =>
        validateSanitizedReplayTape(
          browserTape([
            {
              operation: "paste",
              request: unicodePaste,
              error: {
                ...partial,
                requestedCount: 7,
                dispatchedCount,
              },
            },
          ]),
        ),
      ).not.toThrow();
    }

    expect(() =>
      validateSanitizedReplayTape(
        browserTape([
          {
            operation: "mouse",
            request: browserMutationRequests.mouse,
            error: {
              code: "PARTIAL_DISPATCH",
              boundary: "ack",
              outcome: "unknown",
              writeBegan: true,
              acknowledged: false,
              verification: "none",
              requestedCount: 2,
              dispatchedCount: 1,
              completedCount: 1,
            },
          },
        ]),
      ),
    ).toThrow(/invalid sanitized replay tape/i);
  });

  it("accepts every exact connect tuple and rejects substitutions and capability classification", () => {
    const notSent = (
      code: string,
      boundary: "admission" | "send" = "admission",
    ) => ({
      code,
      boundary,
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      ...replayRecovery(code, "not_sent"),
    });
    const unknown = (code: string) => ({
      code,
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
      ...replayRecovery(code, "unknown"),
    });
    const legal = [
      notSent("DEADLINE_EXCEEDED"),
      notSent("CANCELLED"),
      notSent("CONNECTION_LOST", "send"),
      unknown("CONNECTION_LOST"),
      unknown("DOWNSTREAM_MALFORMED_RESPONSE"),
      notSent("PERMISSION_DENIED"),
      unknown("SESSION_TAKEN_OVER"),
      notSent("STALE_SESSION_GENERATION"),
      notSent("CONTROL_BUSY"),
      notSent("AUTH_FAILED"),
      notSent("AUTH_RATE_LIMITED"),
      notSent("AUTH_EXPIRED"),
      notSent("UNSUPPORTED_UI_VERSION"),
      notSent("FIRMWARE_INCOMPATIBLE"),
      notSent("BROWSER_UNSUPPORTED"),
      notSent("DEVICE_UNREACHABLE"),
    ] as const;

    for (const operation of ["connect", "reconnect"] as const) {
      for (const error of legal) {
        const exchange = { operation, request: { ref }, error };
        expect(() =>
          validateSanitizedReplayTape({
            version: 1,
            plane: "browser",
            exchanges: [exchange],
          }),
        ).not.toThrow();
        expect(() =>
          validateSanitizedReplayTape({
            version: 1,
            plane: "browser",
            exchanges: [
              {
                ...exchange,
                error: {
                  ...error,
                  boundary:
                    error.boundary === "admission" ? "ack" : "admission",
                },
              },
            ],
          }),
        ).toThrow(/invalid sanitized replay tape/i);
        expect(() =>
          validateSanitizedReplayTape({
            version: 1,
            plane: "browser",
            exchanges: [{ ...exchange, error: { ...error, unexpected: true } }],
          }),
        ).toThrow(/invalid sanitized replay tape/i);
      }

      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation,
              request: { ref },
              error: notSent("CAPABILITY_MISSING"),
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }
  });

  it("enforces exact per-operation browser mutation error tuples", () => {
    const zeroCounts = { dispatchedCount: 0, completedCount: 0 };
    const partialCounts = { dispatchedCount: 2, completedCount: 1 };
    const completeCounts = { dispatchedCount: 1, completedCount: 1 };
    const notSent = (
      code: string,
      boundary: "admission" | "send" = "admission",
    ) => ({
      code,
      boundary,
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      ...replayRecovery(code, "not_sent"),
      ...zeroCounts,
    });
    const unknown = (code: string, boundary: "ack" | "post_ack" = "ack") => ({
      code,
      boundary,
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
      verification: "none",
      ...replayRecovery(code, "unknown"),
      ...partialCounts,
    });
    const applied = (code: string, boundary: "post_ack") => ({
      code,
      boundary,
      outcome: "applied" as const,
      writeBegan: true,
      acknowledged: true,
      verification: "device_ack_only" as const,
      ...completeCounts,
      ...replayRecovery(code, "applied"),
    });
    const partialDispatch = {
      ...unknown("MUTATION_OUTCOME_UNKNOWN"),
      requestedCount: 2,
      dispatchedCount: 2,
      completedCount: 1,
      failedIndex: 1,
    };
    const tuples = [
      ["deadline", notSent("DEADLINE_EXCEEDED")],
      ["cancelled", notSent("CANCELLED")],
      ["connection-before-write", notSent("CONNECTION_LOST", "send")],
      ["connection-after-write", unknown("CONNECTION_LOST")],
      ["malformed", unknown("DOWNSTREAM_MALFORMED_RESPONSE")],
      ["permission", notSent("PERMISSION_DENIED")],
      ["capability", notSent("CAPABILITY_MISSING")],
      ["taken-over", unknown("SESSION_TAKEN_OVER")],
      ["stale-generation", notSent("STALE_SESSION_GENERATION")],
      ["post-ack-read", applied("PARTIAL_VERIFICATION", "post_ack")],
      ["partial-dispatch", partialDispatch],
      ["cleanup", unknown("MUTATION_OUTCOME_UNKNOWN", "post_ack")],
      ["event-gap", unknown("EVENT_GAP")],
      ["fresh-capture", notSent("STALE_OBSERVATION")],
    ] as const;
    const rejectedByOperation: Record<
      keyof typeof browserMutationRequests,
      readonly (typeof tuples)[number][0][]
    > = {
      mouse: ["event-gap"],
      keyboard: ["event-gap"],
      paste: [],
      release: ["partial-dispatch", "event-gap", "fresh-capture"],
    };

    for (const operation of [
      "mouse",
      "keyboard",
      "paste",
      "release",
    ] as const) {
      for (const [name, error] of tuples) {
        const expectedCount =
          operation === "release" ? 1 : operation === "paste" ? 4 : 2;
        const correlatedError =
          error.outcome === "applied"
            ? {
                ...error,
                dispatchedCount: expectedCount,
                completedCount: expectedCount,
              }
            : error.outcome === "unknown" && !("requestedCount" in error)
              ? {
                  ...error,
                  dispatchedCount: expectedCount,
                  completedCount: expectedCount - 1,
                }
              : error;
        const requestCorrelatedError =
          operation === "paste" && name === "partial-dispatch"
            ? { ...correlatedError, requestedCount: expectedCount }
            : correlatedError;
        const validate = () =>
          validateSanitizedReplayTape({
            version: 1,
            plane: "browser",
            exchanges: [
              {
                operation,
                request: browserMutationRequests[operation],
                error: requestCorrelatedError,
              },
            ],
          });
        if (!rejectedByOperation[operation].includes(name)) {
          expect(validate).not.toThrow();
        } else {
          expect(validate).toThrow(/invalid sanitized replay tape/i);
        }
      }
    }

    for (const error of [
      unknown("MUTATION_OUTCOME_UNKNOWN"),
      { ...partialDispatch, requestedCount: 1 },
      { ...partialDispatch, requestedCount: 3 },
      { ...partialDispatch, completedCount: 2 },
      { ...partialDispatch, dispatchedCount: 1 },
      { ...partialDispatch, dispatchedCount: 3 },
    ]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation: "mouse",
              request: browserMutationRequests.mouse,
              error,
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    for (const request of [
      {
        ref,
        request: {
          observationId: "observation-a",
          requestId: "paste-request",
          textByteLength: 4,
          textSha256: "b".repeat(64),
        },
      },
      {
        ref,
        request: {
          ...browserMutationRequests.paste.request,
          sourceCharacterCount: 3,
        },
      },
    ]) {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "browser",
          exchanges: [
            {
              operation: "paste",
              request,
              error: partialDispatch,
            },
          ],
        }),
      ).toThrow(/invalid sanitized replay tape/i);
    }

    expect(() =>
      validateSanitizedReplayTape({
        version: 1,
        plane: "browser",
        exchanges: [
          {
            operation: "paste",
            request: browserMutationRequests.paste,
            error: {
              ...unknown("EVENT_GAP"),
              completedCount: 2,
            },
          },
        ],
      }),
    ).toThrow(/invalid sanitized replay tape/i);
  });
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
      ...replayRecovery("CONNECTION_LOST", "not_sent"),
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
      ...replayRecovery("CONNECTION_LOST", "unknown"),
      dispatchedCount: 1,
      completedCount: 0,
    } as const;
    const acknowledgedFailure = {
      code: "PARTIAL_VERIFICATION",
      boundary: "post_ack",
      outcome: "applied",
      writeBegan: true,
      acknowledged: true,
      verification: "device_ack_only",
      ...replayRecovery("PARTIAL_VERIFICATION", "applied"),
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
      [
        "readEdid",
        readRequest,
        notSent("DOWNSTREAM_MALFORMED_RESPONSE", "send"),
      ],
      ["readEdid", readRequest, unknown("DOWNSTREAM_MALFORMED_RESPONSE")],
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
          ...replayRecovery("CONTROL_BUSY", "not_sent"),
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
            actions: [
              { type: "move", x: 1, y: 2 },
              { type: "move", x: 3, y: 4 },
            ],
          },
        },
        error: {
          code: "MUTATION_OUTCOME_UNKNOWN",
          boundary: "ack",
          outcome: "unknown",
          writeBegan: true,
          acknowledged: false,
          verification: "none",
          ...replayRecovery("MUTATION_OUTCOME_UNKNOWN", "unknown"),
          requestedCount: 2,
          dispatchedCount: 2,
          completedCount: 1,
          failedIndex: 1,
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
          code: "PARTIAL_VERIFICATION",
          boundary: "post_ack",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
          ...replayRecovery("PARTIAL_VERIFICATION", "applied"),
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
          code: "MUTATION_OUTCOME_UNKNOWN",
          boundary: "ack",
          outcome: "unknown",
          writeBegan: true,
          acknowledged: false,
          verification: "none",
          ...replayRecovery("MUTATION_OUTCOME_UNKNOWN", "unknown"),
        },
      },
      {
        accepted: false,
        plane: "browser",
        operation: "release",
        request: { ref, request: { requestId: "release-a" } },
        error: {
          code: "STALE_OBSERVATION",
          boundary: "admission",
          outcome: "not_sent",
          writeBegan: false,
          acknowledged: false,
          verification: "none",
          ...replayRecovery("STALE_OBSERVATION", "not_sent"),
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
          code: "PARTIAL_VERIFICATION",
          boundary: "post_ack",
          outcome: "applied",
          writeBegan: true,
          acknowledged: true,
          verification: "device_ack_only",
          ...replayRecovery("PARTIAL_VERIFICATION", "applied"),
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
        ...replayRecovery("CONNECTION_LOST", "not_sent"),
        dispatchedCount: 1,
        completedCount: 0,
      },
      {
        code: "MUTATION_OUTCOME_UNKNOWN",
        boundary: "ack",
        outcome: "unknown",
        writeBegan: true,
        acknowledged: false,
        verification: "none",
        ...replayRecovery("MUTATION_OUTCOME_UNKNOWN", "unknown"),
        dispatchedCount: 1,
        completedCount: 1,
      },
      {
        code: "PARTIAL_VERIFICATION",
        boundary: "post_ack",
        outcome: "applied",
        writeBegan: true,
        acknowledged: true,
        verification: "device_ack_only",
        ...replayRecovery("PARTIAL_VERIFICATION", "applied"),
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

  it("enforces the exact ATX provenance union on native and device RPC tapes", () => {
    const exchanges = [
      {
        plane: "device_rpc",
        operation: "performAtx",
        request: jsonValue({
          ref: binding,
          request: { requestId: "power-a", action: "press_power" },
        }),
      },
      {
        plane: "native",
        operation: "powerControl",
        request: jsonValue({
          ref,
          request: { requestId: "power-a", action: "press_power" },
        }),
      },
    ] as const;
    const invalidObservations = [
      { power: true, hdd: false, observedAt: null, freshness: "fresh" },
      {
        power: null,
        hdd: null,
        observedAt: "2026-07-13T00:00:00.000Z",
        freshness: "unknown",
      },
      { power: null, hdd: false, observedAt: null, freshness: "unknown" },
    ] as const;

    for (const replayCase of exchanges) {
      for (const atxLedObservation of invalidObservations) {
        expect(() =>
          validateSanitizedReplayTape({
            version: 1,
            plane: replayCase.plane,
            exchanges: [
              {
                operation: replayCase.operation,
                request: replayCase.request,
                response: jsonValue({ ...atx, atxLedObservation }),
              },
            ],
          }),
        ).toThrow(/invalid sanitized replay tape/i);
      }
    }
  });

  it.each(["fresh", "stale"] as const)(
    "accepts an observed ATX tape with %s provenance",
    (freshness) => {
      expect(() =>
        validateSanitizedReplayTape({
          version: 1,
          plane: "device_rpc",
          exchanges: [
            {
              operation: "performAtx",
              request: {
                ref: binding,
                request: { requestId: "power-a", action: "press_power" },
              },
              response: {
                ...atx,
                atxLedObservation: {
                  power: true,
                  hdd: null,
                  observedAt: "2026-07-13T00:00:00.000Z",
                  freshness,
                },
              },
            },
          ],
        }),
      ).not.toThrow();
    },
  );

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

function runtimeBrowserPrelude(
  observationOverrides: Readonly<Record<string, JsonValue>> = {},
): SanitizedReplayTape["exchanges"] {
  return [
    {
      operation: "connect",
      request: { ref },
      response: jsonValue({
        state: "ready",
        ref,
        binding,
        connectionEpoch: binding.connectionEpoch,
        browserChannelGeneration: binding.browserChannelGeneration,
        displayGeneration: 1,
      }),
    },
    {
      operation: "capture",
      request: {
        ref,
        request: { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
      },
      response: jsonValue({
        ...browserObservation("image/jpeg", 1),
        sessionId: ref.sessionId,
        connectionEpoch: binding.connectionEpoch,
        displayGeneration: 1,
        ...observationOverrides,
      }),
    },
  ];
}

async function publishReplayObservation(
  replay: BrowserPlaneReplay,
): Promise<void> {
  await replay.connect(ref, deadline);
  await replay.capture(
    ref,
    { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
    deadline,
  );
}

describe("BrowserPlaneReplay", () => {
  it("consumes calls in exact order and rejects an unexpected operation", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude(),
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

    await publishReplayObservation(replay);
    await expect(replay.close(ref, deadline)).rejects.toMatchObject({
      name: "ReplayMismatchError",
      index: 2,
    });
    expect(() => replay.assertExhausted()).toThrow(/1 replay exchange/i);
  });

  it("accepts any positive safe internal deadline", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude(),
        { operation: "close", request: { ref }, response: null },
      ]),
    );

    await publishReplayObservation(replay);
    await expect(
      replay.close(ref, {
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["connectionEpoch", "displayGeneration"] as const)(
    "rejects capture evidence from a non-published %s",
    async (field) => {
      const published = {
        state: "ready" as const,
        ref,
        binding,
        connectionEpoch: binding.connectionEpoch,
        browserChannelGeneration: binding.browserChannelGeneration,
        displayGeneration: 0,
      };
      const response = {
        ...browserObservation("image/jpeg", 1),
        connectionEpoch: binding.connectionEpoch,
        displayGeneration: 0,
        [field]: field === "connectionEpoch" ? binding.connectionEpoch + 1 : 1,
      };
      const replay = new BrowserPlaneReplay(
        new ReplayAdapter(),
        browserTape([
          {
            operation: "connect",
            request: { ref },
            response: jsonValue(published),
          },
          {
            operation: "capture",
            request: {
              ref,
              request: { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
            },
            response: jsonValue(response),
          },
        ]),
      );
      await replay.connect(ref, deadline);

      await expect(
        replay.capture(
          ref,
          { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
          deadline,
        ),
      ).rejects.toThrow(/published connection/i);
    },
  );

  it("rejects request shape drift rather than loosely matching", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude(),
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

    await publishReplayObservation(replay);
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
    const text = "\uFEFFA\r\ne\u0301\r";
    const normalized = "A\né\n";
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude(),
        {
          operation: "paste",
          request: {
            ref,
            request: {
              observationId: "observation-a",
              requestId: "request-a",
              originalByteCount: Buffer.byteLength(text),
              originalSha256: createHash("sha256").update(text).digest("hex"),
              normalizedByteCount: Buffer.byteLength(normalized),
              normalizedSha256: createHash("sha256")
                .update(normalized)
                .digest("hex"),
            },
          },
          response: {
            requestId: "request-a",
            outcome: "applied",
            verification: "device_ack_only",
            dispatchedCount: Buffer.byteLength(normalized),
            completedCount: Buffer.byteLength(normalized),
            acknowledgedAt: "2026-07-13T00:00:00.000Z",
            originalByteCount: Buffer.byteLength(text),
            normalizedByteCount: Buffer.byteLength(normalized),
            normalizedSha256: createHash("sha256")
              .update(normalized)
              .digest("hex"),
            acceptedAt: "2026-07-13T00:00:00.000Z",
            completedAt: "2026-07-13T00:00:01.000Z",
            terminalState: "succeeded",
            measuredCharsPerSecond: 91,
          },
        },
      ]),
    );

    await publishReplayObservation(replay);
    await expect(
      replay.paste(
        ref,
        { observationId: "observation-a", requestId: "request-a", text },
        deadline,
      ),
    ).resolves.toMatchObject({ requestId: "request-a", outcome: "applied" });
    expect(() => replay.assertExhausted()).not.toThrow();
  });

  it("enforces boundary observation age and one-shot consumption before replay dispatch", async () => {
    const mouseExchange = (requestId: string) => ({
      operation: "mouse",
      request: {
        ref,
        request: {
          observationId: "observation-a",
          requestId,
          actions: [{ type: "move", x: 1, y: 2 }],
        },
      },
      response: {
        ...browserMutationReceipt(requestId),
        dispatchedCount: 1,
        completedCount: 1,
      },
    });
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude({ monotonicAgeMs: 30_000 }),
        mouseExchange("request-a"),
        mouseExchange("request-b"),
      ]),
    );
    await publishReplayObservation(replay);
    await expect(
      replay.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ requestId: "request-a" });
    await expect(
      replay.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-b",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => replay.assertExhausted()).toThrow(/1 replay exchange/i);

    const stale = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude({ monotonicAgeMs: 30_001 }),
        mouseExchange("request-a"),
      ]),
    );
    await publishReplayObservation(stale);
    await expect(
      stale.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => stale.assertExhausted()).toThrow(/1 replay exchange/i);
  });

  it("invalidates observations and publication before close returns", async () => {
    const replay = new BrowserPlaneReplay(
      new ReplayAdapter(),
      browserTape([
        ...runtimeBrowserPrelude(),
        { operation: "close", request: { ref }, response: null },
        {
          operation: "capture",
          request: {
            ref,
            request: { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
          },
          response: jsonValue(browserObservation("image/jpeg", 1)),
        },
      ]),
    );
    await publishReplayObservation(replay);
    await replay.close(ref, deadline);
    await expect(
      replay.capture(
        ref,
        { format: "jpeg", maxWidth: 1920, maxHeight: 1080 },
        deadline,
      ),
    ).rejects.toThrow(/published connection/i);
    expect(() => replay.assertExhausted()).toThrow(/1 replay exchange/i);
  });

  it("replaces the Browser-owned adapter across a recorded reconnect", async () => {
    class BoundReplayAdapter extends ReplayAdapter {
      public invalidated = false;

      public constructor(public override readonly binding: DeviceRpcBinding) {
        super();
      }
    }
    const invalidated = Promise.withResolvers<void>();
    const lifecycleCalls: string[] = [];

    const initial = new BoundReplayAdapter(binding);
    const nextBinding = {
      ...binding,
      connectionEpoch: binding.connectionEpoch + 1,
      browserChannelGeneration: binding.browserChannelGeneration + 1,
    };
    const next = new BoundReplayAdapter(nextBinding);
    const connection = (
      actual: DeviceRpcBinding,
      displayGeneration: number,
    ) => ({
      state: "ready" as const,
      ref,
      binding: actual,
      connectionEpoch: actual.connectionEpoch,
      browserChannelGeneration: actual.browserChannelGeneration,
      displayGeneration,
    });
    const replay = new BrowserPlaneReplay(
      initial,
      browserTape([
        {
          operation: "connect",
          request: { ref },
          response: jsonValue(connection(binding, 0)),
        },
        {
          operation: "reconnect",
          request: { ref },
          response: jsonValue(connection(nextBinding, 0)),
        },
      ]),
      {
        invalidate: async (previous) => {
          expect(previous).toBe(initial);
          lifecycleCalls.push("invalidate");
          await invalidated.promise;
          initial.invalidated = true;
        },
        createReplacement: async (recordedBinding) => {
          expect(recordedBinding).toEqual(nextBinding);
          lifecycleCalls.push("create");
          return next;
        },
      },
    );

    const connected = await replay.connect(ref, deadline);
    expect(connected.deviceRpc).toBe(initial);
    expect(replay.deviceRpc).toBe(initial);

    const reconnecting = replay.reconnect(ref, deadline);
    await Promise.resolve();
    expect(replay.deviceRpc).toBe(initial);
    expect(lifecycleCalls).toEqual(["invalidate"]);
    invalidated.resolve();

    const reconnected = await reconnecting;
    expect(initial.invalidated).toBe(true);
    expect(lifecycleCalls).toEqual(["invalidate", "create"]);
    expect(reconnected.deviceRpc).toBe(next);
    expect(replay.deviceRpc).toBe(next);
    expect(() => replay.assertExhausted()).not.toThrow();
  });

  it.each(["connectionEpoch", "browserChannelGeneration"] as const)(
    "requires reconnect to strictly increase %s before invalidation",
    async (field) => {
      class BoundReplayAdapter extends ReplayAdapter {
        public constructor(public override readonly binding: DeviceRpcBinding) {
          super();
        }
      }
      const nextBinding = {
        ...binding,
        connectionEpoch: binding.connectionEpoch + 1,
        browserChannelGeneration: binding.browserChannelGeneration + 1,
        [field]: binding[field],
      };
      const invalidations: DeviceRpcAdapter[] = [];
      const replay = new BrowserPlaneReplay(
        new BoundReplayAdapter(binding),
        browserTape([
          {
            operation: "connect",
            request: { ref },
            response: jsonValue({
              state: "ready",
              ref,
              binding,
              connectionEpoch: binding.connectionEpoch,
              browserChannelGeneration: binding.browserChannelGeneration,
              displayGeneration: 0,
            }),
          },
          {
            operation: "reconnect",
            request: { ref },
            response: jsonValue({
              state: "ready",
              ref,
              binding: nextBinding,
              connectionEpoch: nextBinding.connectionEpoch,
              browserChannelGeneration: nextBinding.browserChannelGeneration,
              displayGeneration: 0,
            }),
          },
        ]),
        {
          invalidate: async (previous) => {
            invalidations.push(previous);
          },
          createReplacement: async (recordedBinding) =>
            new BoundReplayAdapter(recordedBinding),
        },
      );
      await replay.connect(ref, deadline);

      await expect(replay.reconnect(ref, deadline)).rejects.toThrow(
        /strictly increase/i,
      );
      expect(invalidations).toEqual([]);
    },
  );
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

  it("records reachability and native process state independently for a lost binding", async () => {
    const lostDisplay: CachedDisplayState = {
      ...display,
      signal: { ...display.signal, freshness: "stale" },
      resolution: { ...display.resolution, freshness: "stale" },
      fps: { ...display.fps, freshness: "stale" },
      qualification: "binding_lost_cached_only",
    };
    class LostBindingReplayAdapter extends ReplayAdapter {
      public override async readDisplayState(): Promise<CachedDisplayState> {
        this.calls.push("readDisplayState");
        return lostDisplay;
      }
    }
    const replay = new NativeControlPlaneReplay(
      new LostBindingReplayAdapter(),
      {
        version: 1,
        plane: "native",
        exchanges: [
          {
            operation: "sessionStatus",
            request: { ref },
            response: jsonValue({
              rpcReachability: "unreachable",
              nativeProcess: "restarting",
              display: lostDisplay,
            }),
          },
        ],
      },
    );

    await expect(replay.sessionStatus(ref, deadline)).resolves.toEqual({
      rpcReachability: "unreachable",
      nativeProcess: "restarting",
      display: lostDisplay,
    });
  });

  it("rejects incoherent adapter ATX provenance before native result mapping", async () => {
    const invalidAtx = {
      ...atx,
      atxLedObservation: {
        power: true,
        hdd: null,
        observedAt: null,
        freshness: "unknown",
      },
    } as unknown as AtxWireReceipt;
    class InvalidAtxReplayAdapter extends ReplayAdapter {
      public override async performAtx(): Promise<AtxWireReceipt> {
        this.calls.push("performAtx");
        return invalidAtx;
      }
    }
    const replay = new NativeControlPlaneReplay(new InvalidAtxReplayAdapter(), {
      version: 1,
      plane: "native",
      exchanges: [
        {
          operation: "powerControl",
          request: {
            ref,
            request: { requestId: "power-a", action: "press_power" },
          },
          response: jsonValue(atx),
        },
      ],
    });

    await expect(
      replay.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).rejects.toThrow(/ATX receipt shape is invalid/i);
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
            signal: { ...display.signal, freshness: "stale" },
            resolution: { ...display.resolution, freshness: "stale" },
            fps: { ...display.fps, freshness: "stale" },
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
