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
import { validateSessionPlaneBundle } from "../planes/SessionPlaneBundle.js";
import { FakeBrowserPlane } from "./fakes/FakeBrowserPlane.js";
import { FakeNativeControlPlane } from "./fakes/FakeNativeControlPlane.js";
import {
  PlaneFaultError,
  type PlaneFault,
  type PlaneOperation,
} from "./fakes/PlaneScenario.js";

const binding: DeviceRpcBinding = {
  sessionId: "session-a",
  sessionGeneration: 1,
  connectionEpoch: 2,
  browserChannelGeneration: 3,
};
const ref = {
  sessionId: binding.sessionId,
  sessionGeneration: binding.sessionGeneration,
};
const deadline: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const receipt = {
  requestId: "request-a",
  outcome: "applied" as const,
  verification: "device_ack_only" as const,
  dispatchedCount: 1,
  completedCount: 1,
  acknowledgedAt: "2026-07-13T00:00:00.000Z",
};

const imageBytes = new Uint8Array([1, 2, 3]);
const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
const observation = {
  observationId: "observation-a",
  sessionId: ref.sessionId,
  sessionGeneration: ref.sessionGeneration,
  connectionEpoch: binding.connectionEpoch,
  displayGeneration: 0,
  frameId: "frame-a",
  capturedAt: "2026-07-13T00:00:00.000Z",
  monotonicAgeMs: 0,
  sourceWidth: 1920,
  sourceHeight: 1080,
  imageWidth: 1280,
  imageHeight: 720,
  rotation: 0 as const,
  geometry: {
    contentX: 0,
    contentY: 0,
    contentWidth: 1280,
    contentHeight: 720,
  },
  format: "png" as const,
  sha256: imageSha256,
  byteLength: imageBytes.byteLength,
};
const pasteText = "private paste";
const normalizedPasteText = pasteText.normalize("NFC");
const pasteReceipt = {
  ...receipt,
  dispatchedCount: Buffer.byteLength(normalizedPasteText),
  completedCount: Buffer.byteLength(normalizedPasteText),
  originalByteCount: Buffer.byteLength(pasteText),
  normalizedByteCount: Buffer.byteLength(normalizedPasteText),
  normalizedSha256: createHash("sha256")
    .update(normalizedPasteText)
    .digest("hex"),
  acceptedAt: "2026-07-13T00:00:00.000Z",
  completedAt: "2026-07-13T00:00:01.000Z",
  terminalState: "succeeded" as const,
  measuredCharsPerSecond: 91,
};
const releaseReceipt = {
  ...receipt,
  mutationGateClosed: true,
  deferredProducersJoined: true,
  pasteTerminal: "inactive" as const,
  ordinaryLeasesZero: true,
  keyboardZero: true,
  pointerZero: true,
  generationDrained: true,
  heldKeys: [],
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

class RecordingAdapter implements DeviceRpcAdapter {
  public readonly calls: string[] = [];
  public binding: DeviceRpcBinding = binding;

  public async readDisplayState(
    actual: DeviceRpcBinding,
    _deadline: Deadline,
  ): Promise<CachedDisplayState> {
    expect(actual).toEqual(binding);
    this.calls.push("readDisplayState");
    return display;
  }

  public async readEdid(
    actual: DeviceRpcBinding,
    _deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    expect(actual).toEqual(binding);
    this.calls.push("readEdid");
    return edid;
  }

  public async performAtx(
    actual: DeviceRpcBinding,
    request: {
      requestId: string;
      action: "press_power" | "hold_power" | "press_reset";
    },
    _deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    expect(actual).toEqual(binding);
    expect(request).toEqual({ requestId: "power-a", action: "press_power" });
    this.calls.push("performAtx");
    return atx;
  }
}

async function publishFakeObservation(
  plane: FakeBrowserPlane,
  monotonicAgeMs = 0,
): Promise<void> {
  plane.loadScenario({
    version: 1,
    steps: [
      {
        operation: "connect",
        result: {
          state: "ready",
          ref,
          binding,
          connectionEpoch: binding.connectionEpoch,
          browserChannelGeneration: binding.browserChannelGeneration,
          displayGeneration: observation.displayGeneration,
        },
      },
      {
        operation: "capture",
        result: { ...observation, monotonicAgeMs },
      },
    ],
  });
  await plane.connect(ref, deadline);
  await plane.capture(
    ref,
    { format: "png", maxWidth: 1280, maxHeight: 720 },
    deadline,
  );
}

type ThrowingPlaneFault = Exclude<
  PlaneFault,
  "disconnect_after_persisted_terminal"
>;
const THROWING_FAULTS: readonly ThrowingPlaneFault[] = [
  "deadline_before_admission",
  "cancellation_before_admission",
  "disconnect_before_write",
  "disconnect_after_write_before_ack",
  "disconnect_after_ack_before_post_read",
  "malformed_response",
  "permission_denied",
  "capability_missing",
  "control_busy",
  "takeover",
  "malformed_response_before_write",
  "stale_generation",
  "partial_multi_event",
  "partial_verification",
  "cleanup_failure",
  "post_reconnect_without_capture",
  "event_gap",
  "duplicate_request_id",
];

const FAULT_FAILURES = {
  deadline_before_admission: {
    code: "DEADLINE_EXCEEDED",
    outcome: "not_sent",
    safeToRetry: true,
    requiredNextStep: "none",
  },
  cancellation_before_admission: {
    code: "CANCELLED",
    outcome: "not_sent",
    safeToRetry: true,
    requiredNextStep: "none",
  },
  disconnect_before_write: {
    code: "CONNECTION_LOST",
    outcome: "not_sent",
    safeToRetry: true,
    requiredNextStep: "reconnect_then_capture",
  },
  disconnect_after_write_before_ack: {
    code: "CONNECTION_LOST",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
  },
  disconnect_after_ack_before_post_read: {
    code: "PARTIAL_VERIFICATION",
    outcome: "applied",
    safeToRetry: false,
    requiredNextStep: "none",
  },
  malformed_response: {
    code: "DOWNSTREAM_MALFORMED_RESPONSE",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
  },
  malformed_response_before_write: {
    code: "DOWNSTREAM_MALFORMED_RESPONSE",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
  },
  permission_denied: {
    code: "PERMISSION_DENIED",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "grant_permission",
  },
  capability_missing: {
    code: "CAPABILITY_MISSING",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "enable_capability",
  },
  control_busy: {
    code: "CONTROL_BUSY",
    outcome: "not_sent",
    safeToRetry: true,
    requiredNextStep: "wait_or_request_takeover",
  },
  takeover: {
    code: "SESSION_TAKEN_OVER",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "release_then_reconnect_then_capture",
  },
  stale_generation: {
    code: "STALE_SESSION_GENERATION",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
  },
  partial_multi_event: {
    code: "MUTATION_OUTCOME_UNKNOWN",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
  },
  partial_verification: {
    code: "PARTIAL_VERIFICATION",
    outcome: "applied",
    safeToRetry: false,
    requiredNextStep: "none",
  },
  cleanup_failure: {
    code: "MUTATION_OUTCOME_UNKNOWN",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
  },
  post_reconnect_without_capture: {
    code: "STALE_OBSERVATION",
    outcome: "not_sent",
    safeToRetry: true,
    requiredNextStep: "capture_then_retry",
  },
  event_gap: {
    code: "EVENT_GAP",
    outcome: "unknown",
    safeToRetry: false,
    requiredNextStep: "release_then_reconnect_then_capture",
  },
  duplicate_request_id: {
    code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "none",
  },
} as const satisfies Record<ThrowingPlaneFault, object>;

describe("SessionPlaneBundle", () => {
  it("accepts only one exact Browser-owned adapter object in both planes", () => {
    const adapter = new RecordingAdapter();
    const browser = new FakeBrowserPlane(adapter);
    const native = new FakeNativeControlPlane(adapter);

    const bundle = validateSessionPlaneBundle({
      browser,
      native,
      deviceRpc: adapter,
    });

    expect(bundle.browser.deviceRpc).toBe(adapter);
    expect(bundle.native.deviceRpc).toBe(adapter);
    expect(bundle.deviceRpc).toBe(adapter);
  });

  it("rejects every A/B adapter mix but permits a later synchronized bundle", () => {
    const first = new RecordingAdapter();
    const second = new RecordingAdapter();
    const firstBrowser = new FakeBrowserPlane(first);
    const firstNative = new FakeNativeControlPlane(first);

    expect(() =>
      validateSessionPlaneBundle({
        browser: firstBrowser,
        native: new FakeNativeControlPlane(second),
        deviceRpc: first,
      }),
    ).toThrow(/same DeviceRpcAdapter/i);
    expect(() =>
      validateSessionPlaneBundle({
        browser: firstBrowser,
        native: firstNative,
        deviceRpc: second,
      }),
    ).toThrow(/same DeviceRpcAdapter/i);

    const replacement = validateSessionPlaneBundle({
      browser: new FakeBrowserPlane(second),
      native: new FakeNativeControlPlane(second),
      deviceRpc: second,
    });
    expect(replacement.deviceRpc).toBe(second);
  });
});

describe("FakeBrowserPlane", () => {
  it("publishes only its injected adapter in the BrowserConnection", async () => {
    const adapter = new RecordingAdapter();
    const plane = new FakeBrowserPlane(adapter);
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding,
            connectionEpoch: binding.connectionEpoch,
            browserChannelGeneration: binding.browserChannelGeneration,
            displayGeneration: 1,
          },
        },
      ],
    });

    const connection = await plane.connect(ref, deadline);

    expect(connection.deviceRpc).toBe(adapter);
  });

  it("strictly validates and correlates every fake browser result", async () => {
    const validConnection = {
      state: "ready" as const,
      ref,
      binding,
      connectionEpoch: binding.connectionEpoch,
      browserChannelGeneration: binding.browserChannelGeneration,
      displayGeneration: 0,
    };
    const cases: readonly [
      operation: PlaneOperation,
      result: unknown,
      invoke: (plane: FakeBrowserPlane) => Promise<unknown>,
    ][] = [
      [
        "connect",
        { ...validConnection, ref: { ...ref, sessionId: "session-b" } },
        (plane) => plane.connect(ref, deadline),
      ],
      [
        "reconnect",
        {
          ...validConnection,
          binding: { ...binding, connectionEpoch: binding.connectionEpoch + 1 },
        },
        (plane) => plane.reconnect(ref, deadline),
      ],
      [
        "capture",
        {
          ...observation,
          geometry: { ...observation.geometry, contentWidth: 1281 },
        },
        (plane) =>
          plane.capture(
            ref,
            { format: "png", maxWidth: 1280, maxHeight: 720 },
            deadline,
          ),
      ],
      [
        "mouse",
        { ...receipt, requestId: "wrong-request" },
        (plane) =>
          plane.mouse(
            ref,
            {
              observationId: "observation-a",
              requestId: "request-a",
              actions: [{ type: "move", x: 1, y: 2 }],
            },
            deadline,
          ),
      ],
      [
        "keyboard",
        { ...receipt, dispatchedCount: 0, completedCount: 0 },
        (plane) =>
          plane.keyboard(
            ref,
            {
              observationId: "observation-a",
              requestId: "request-a",
              actions: [{ type: "key_press", key: "KeyA" }],
            },
            deadline,
          ),
      ],
      [
        "paste",
        { ...pasteReceipt, originalByteCount: 1 },
        (plane) =>
          plane.paste(
            ref,
            {
              observationId: "observation-a",
              requestId: "request-a",
              text: pasteText,
            },
            deadline,
          ),
      ],
      [
        "release",
        { ...releaseReceipt, generationDrained: false },
        (plane) => plane.release(ref, { requestId: "request-a" }, deadline),
      ],
      ["close", { unexpected: true }, (plane) => plane.close(ref, deadline)],
    ];

    for (const [operation, result, invoke] of cases) {
      const plane = new FakeBrowserPlane(new RecordingAdapter());
      if (operation !== "connect") {
        await publishFakeObservation(plane);
      }
      plane.loadScenario({ version: 1, steps: [{ operation, result }] });
      await expect(invoke(plane), operation).rejects.toThrow(
        /result|response|receipt|published connection/i,
      );
    }
  });

  it("rejects incoherent fault boundaries and operation-specific partial counts at load", () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    for (const step of [
      {
        operation: "mouse",
        fault: "deadline_before_admission",
        dispatchedCount: 1,
        completedCount: 0,
      },
      {
        operation: "mouse",
        fault: "disconnect_after_write_before_ack",
        dispatchedCount: 0,
        completedCount: 0,
      },
      {
        operation: "mouse",
        fault: "partial_multi_event",
        requestedCount: 2,
        dispatchedCount: 1,
        completedCount: 1,
        failedIndex: 1,
      },
      {
        operation: "paste",
        fault: "partial_multi_event",
        requestedCount: 2,
        dispatchedCount: 3,
        completedCount: 1,
        failedIndex: 1,
      },
      {
        operation: "keyboard",
        fault: "partial_multi_event",
        requestedCount: 2,
        dispatchedCount: 2,
        completedCount: 1,
        failedIndex: 0,
      },
    ] as const) {
      expect(() => plane.loadScenario({ version: 1, steps: [step] })).toThrow(
        /invalid fake plane scenario/i,
      );
    }

    expect(() =>
      plane.loadScenario({
        version: 1,
        steps: [
          {
            operation: "keyboard",
            fault: "partial_multi_event",
            requestedCount: 2,
            dispatchedCount: 2,
            completedCount: 1,
            failedIndex: 1,
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each(THROWING_FAULTS)(
    "forces the %s boundary and consumes it once",
    async (fault) => {
      const plane = new FakeBrowserPlane(new RecordingAdapter());
      await publishFakeObservation(plane);
      const outcome = FAULT_FAILURES[fault].outcome;
      const counts =
        outcome === "not_sent"
          ? {}
          : outcome === "applied"
            ? { dispatchedCount: 1, completedCount: 1 }
            : { dispatchedCount: 2, completedCount: 1 };
      const partial =
        fault === "partial_multi_event"
          ? { requestedCount: 2, failedIndex: 1 }
          : {};
      plane.loadScenario({
        version: 1,
        steps: [{ operation: "mouse", fault, ...counts, ...partial }],
      });

      const error = await plane
        .mouse(
          ref,
          {
            observationId: "observation-a",
            requestId: "request-a",
            actions: [
              { type: "move", x: 1, y: 2 },
              { type: "move", x: 3, y: 4 },
            ],
          },
          deadline,
        )
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(PlaneFaultError);
      expect(error).toMatchObject({
        fault,
        ...FAULT_FAILURES[fault],
      });
      if (fault === "partial_multi_event") {
        expect(error).toMatchObject({
          dispatchedCount: 2,
          completedCount: 1,
          suffixSuppressed: true,
        });
      }
      expect(() => plane.assertExhausted()).not.toThrow();
      await expect(
        plane.mouse(
          ref,
          {
            observationId: "observation-a",
            requestId: "request-a",
            actions: [{ type: "move", x: 1, y: 2 }],
          },
          deadline,
        ),
      ).rejects.toThrow(/unexpected fake plane call|observation/i);
    },
  );

  it("returns a persisted terminal result despite a later disconnect", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    await publishFakeObservation(plane);
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "mouse",
          fault: "disconnect_after_persisted_terminal",
          result: receipt,
        },
      ],
    });

    await expect(
      plane.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).resolves.toEqual(receipt);
    expect(plane.events()).toContainEqual(
      expect.objectContaining({
        fault: "disconnect_after_persisted_terminal",
        terminalPersisted: true,
      }),
    );
  });

  it("does not retain paste text or frame bytes in events", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    await publishFakeObservation(plane);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "paste", result: pasteReceipt }],
    });

    await plane.paste(
      ref,
      {
        observationId: "observation-a",
        requestId: "request-a",
        text: pasteText,
      },
      deadline,
    );

    const serialized = JSON.stringify(plane.events());
    expect(serialized).not.toContain(pasteText);
    expect(serialized).toContain("normalizedSha256");
  });

  it("enforces actual deadline cancellation before consuming a scenario step", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    await publishFakeObservation(plane);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      plane.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        { timeoutMs: 1_000, signal: cancellation.signal },
      ),
    ).rejects.toMatchObject({
      fault: "cancellation_before_admission",
      outcome: "not_sent",
    });
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);
  });

  it("accepts any positive safe internal deadline", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    await publishFakeObservation(plane);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });

    await expect(
      plane.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        { timeoutMs: 1, signal: new AbortController().signal },
      ),
    ).resolves.toEqual(receipt);
  });

  it("binds one-shot observations to session identity and monotonic age", async () => {
    const adapter = new RecordingAdapter();
    const plane = new FakeBrowserPlane(adapter);
    const canonicalObservation = {
      ...observation,
      sessionId: ref.sessionId,
      monotonicAgeMs: 30_000,
      format: "png" as const,
      sha256: imageSha256,
      byteLength: imageBytes.byteLength,
    };
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding,
            connectionEpoch: binding.connectionEpoch,
            browserChannelGeneration: binding.browserChannelGeneration,
            displayGeneration: 0,
          },
        },
        { operation: "capture", result: canonicalObservation },
        { operation: "mouse", result: receipt },
      ],
    });
    await plane.connect(ref, deadline);
    const captured = await plane.capture(
      ref,
      { format: "png", maxWidth: 1280, maxHeight: 720 },
      deadline,
    );
    expect(captured).toMatchObject({
      sessionId: ref.sessionId,
      monotonicAgeMs: 30_000,
      format: "png",
      sha256: imageSha256,
      byteLength: 3,
    });
    await expect(
      plane.mouse(
        ref,
        {
          observationId: captured.observationId,
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).resolves.toEqual(receipt);

    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    await expect(
      plane.mouse(
        ref,
        {
          observationId: captured.observationId,
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);
  });

  it("rejects observations older than the operator maximum before consuming a step", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding,
            connectionEpoch: binding.connectionEpoch,
            browserChannelGeneration: binding.browserChannelGeneration,
            displayGeneration: 0,
          },
        },
        {
          operation: "capture",
          result: {
            ...observation,
            sessionId: ref.sessionId,
            monotonicAgeMs: 30_001,
            format: "png",
            sha256: imageSha256,
            byteLength: imageBytes.byteLength,
          },
        },
      ],
    });
    await plane.connect(ref, deadline);
    const captured = await plane.capture(
      ref,
      { format: "png", maxWidth: 1280, maxHeight: 720 },
      deadline,
    );
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    await expect(
      plane.mouse(
        ref,
        {
          observationId: captured.observationId,
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);
  });

  it("rejects a foreign observation even when session generations and epochs collide", async () => {
    const adapter = new RecordingAdapter();
    const plane = new FakeBrowserPlane(adapter);
    await publishFakeObservation(plane);
    const foreignBinding = { ...binding, sessionId: "session-b" };
    const foreignRef = {
      sessionId: foreignBinding.sessionId,
      sessionGeneration: foreignBinding.sessionGeneration,
    };
    adapter.binding = foreignBinding;
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref: foreignRef,
            binding: foreignBinding,
            connectionEpoch: foreignBinding.connectionEpoch,
            browserChannelGeneration: foreignBinding.browserChannelGeneration,
            displayGeneration: 0,
          },
        },
      ],
    });
    await plane.connect(foreignRef, deadline);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    await expect(
      plane.mouse(
        foreignRef,
        {
          observationId: observation.observationId,
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);
  });

  it("invalidates observations across reconnect and close before consuming later steps", async () => {
    const adapter = new RecordingAdapter();
    const plane = new FakeBrowserPlane(adapter);
    await publishFakeObservation(plane);
    const nextBinding = {
      ...binding,
      connectionEpoch: binding.connectionEpoch + 1,
      browserChannelGeneration: binding.browserChannelGeneration + 1,
    };
    adapter.binding = nextBinding;
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "reconnect",
          result: {
            state: "ready",
            ref,
            binding: nextBinding,
            connectionEpoch: nextBinding.connectionEpoch,
            browserChannelGeneration: nextBinding.browserChannelGeneration,
            displayGeneration: 0,
          },
        },
      ],
    });
    await plane.reconnect(ref, deadline);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    await expect(
      plane.mouse(
        ref,
        {
          observationId: observation.observationId,
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).rejects.toThrow(/observation/i);
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);

    plane.loadScenario({
      version: 1,
      steps: [{ operation: "close" }],
    });
    await plane.close(ref, deadline);
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "capture", result: observation }],
    });
    await expect(
      plane.capture(
        ref,
        { format: "png", maxWidth: 1280, maxHeight: 720 },
        deadline,
      ),
    ).rejects.toThrow(/published connection/i);
    await expect(plane.close(ref, deadline)).rejects.toThrow(
      /published connection/i,
    );
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);

    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding: nextBinding,
            connectionEpoch: nextBinding.connectionEpoch,
            browserChannelGeneration: nextBinding.browserChannelGeneration,
            displayGeneration: 0,
          },
        },
      ],
    });
    await expect(plane.connect(ref, deadline)).resolves.toMatchObject({
      ref,
      binding: nextBinding,
    });
  });
});

describe("FakeNativeControlPlane", () => {
  it("uses the exact injected DeviceRpcAdapter for display and power without opening a transport", async () => {
    const adapter = new RecordingAdapter();
    const native = new FakeNativeControlPlane(adapter);
    native.loadScenario({
      version: 1,
      steps: [{ operation: "displayStatus" }, { operation: "powerControl" }],
    });

    await expect(native.displayStatus(ref, deadline)).resolves.toEqual({
      ...display,
      edid,
    });
    await expect(
      native.powerControl(
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
    expect(native.deviceRpc).toBe(adapter);
  });

  it("rejects incoherent explicit ATX provenance instead of weakening the native fake", async () => {
    const adapter = new RecordingAdapter();
    const native = new FakeNativeControlPlane(adapter);
    native.loadScenario({
      version: 1,
      steps: [
        {
          operation: "powerControl",
          result: {
            ...atx,
            atxLedObservation: {
              power: null,
              hdd: false,
              observedAt: null,
              freshness: "unknown",
            },
          },
        },
      ],
    });

    await expect(
      native.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).rejects.toThrow(/ATX result shape is invalid/i);
    expect(adapter.calls).toEqual([]);
  });

  it("keeps native process state independent and never reports a lost RPC binding as healthy", async () => {
    const lostDisplay: CachedDisplayState = {
      ...display,
      signal: { ...display.signal, freshness: "stale" },
      resolution: { ...display.resolution, freshness: "stale" },
      fps: { ...display.fps, freshness: "stale" },
      qualification: "binding_lost_cached_only",
    };
    class LostBindingAdapter extends RecordingAdapter {
      public override async readDisplayState(): Promise<CachedDisplayState> {
        this.calls.push("readDisplayState");
        return lostDisplay;
      }
    }

    const derived = new FakeNativeControlPlane(new LostBindingAdapter());
    derived.loadScenario({
      version: 1,
      steps: [{ operation: "sessionStatus" }],
    });
    await expect(derived.sessionStatus(ref, deadline)).resolves.toEqual({
      rpcReachability: "unreachable",
      nativeProcess: "unknown",
      display: lostDisplay,
    });

    const explicit = new FakeNativeControlPlane(new RecordingAdapter());
    explicit.loadScenario({
      version: 1,
      steps: [
        {
          operation: "sessionStatus",
          result: {
            rpcReachability: "unknown",
            nativeProcess: "restarting",
            display: lostDisplay,
          },
        },
      ],
    });
    await expect(explicit.sessionStatus(ref, deadline)).resolves.toEqual({
      rpcReachability: "unknown",
      nativeProcess: "restarting",
      display: lostDisplay,
    });
  });

  it("can force a pre-adapter native fault with zero adapter calls", async () => {
    const adapter = new RecordingAdapter();
    const native = new FakeNativeControlPlane(adapter);
    native.loadScenario({
      version: 1,
      steps: [{ operation: "powerControl", fault: "capability_missing" }],
    });

    await expect(
      native.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).rejects.toMatchObject({
      fault: "capability_missing",
      outcome: "not_sent",
    });
    expect(adapter.calls).toEqual([]);
  });

  it.each([
    [
      "sessionStatus",
      {
        rpcReachability: "reachable",
        nativeProcess: "available",
        display,
      },
    ],
    ["displayStatus", { ...display, edid }],
    ["powerControl", atx],
  ] as const)(
    "fences stale %s refs before consuming an explicit scenario step",
    async (operation, result) => {
      const native = new FakeNativeControlPlane(new RecordingAdapter());
      native.loadScenario({
        version: 1,
        steps: [{ operation, result }],
      });
      const staleRef = { ...ref, sessionId: "session-b" };
      const call =
        operation === "sessionStatus"
          ? native.sessionStatus(staleRef, deadline)
          : operation === "displayStatus"
            ? native.displayStatus(staleRef, deadline)
            : native.powerControl(
                staleRef,
                { requestId: "power-a", action: "press_power" },
                deadline,
              );
      await expect(call).rejects.toThrow(/stale|session reference/i);
      expect(() => native.assertExhausted()).toThrow(/1 unconsumed/i);
    },
  );
});
