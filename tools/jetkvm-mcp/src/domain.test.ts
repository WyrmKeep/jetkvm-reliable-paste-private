import { describe, expect, it } from "vitest";
import {
  isCoordinateAction,
  type Action,
  type ComputerActionsResult,
  type ComputerPasteTextResult,
  type ComputerReleaseInputResult,
  type ComputerScreenshotResult,
  type ComputerStatusResult,
  type FailureEnvelope,
  type MutationOutcome,
  type ViewId,
} from "./domain.js";

const view = {
  viewId: "view_1" as ViewId,
  connectionEpoch: 2,
  displayGeneration: 3,
  decodedFrameId: "frame_9",
  decodedMediaTimeSeconds: 12.5,
  capturedAt: "2026-07-12T12:00:00.000Z",
  capturedAtMonotonicMs: 1_000,
  sourceWidth: 1920,
  sourceHeight: 1080,
  imageWidth: 1280,
  imageHeight: 720,
  rotationDegrees: 0 as const,
  contentGeometry: {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    renderedX: 10,
    renderedY: 20,
    renderedWidth: 1280,
    renderedHeight: 720,
    fingerprint: "geometry-1",
  },
  format: "jpeg" as const,
  sha256: "a".repeat(64),
  imageBase64: "AA==",
};

const common = {
  ok: true as const,
  operationId: "op_1",
  connectionEpoch: 2,
  displayGeneration: 3,
  durationMs: 4,
};

const fiveResults: [
  ComputerScreenshotResult,
  ComputerActionsResult,
  ComputerPasteTextResult,
  ComputerStatusResult,
  ComputerReleaseInputResult,
] = [
  { ...common, view },
  {
    ...common,
    outcome: "sent",
    completedActionCount: 1,
    receipt: {
      dispatchedAt: "2026-07-12T12:00:00.000Z",
      sourceViewId: view.viewId,
    },
    view,
  },
  {
    ...common,
    outcome: "sent",
    originalByteCount: 4,
    normalizedByteCount: 4,
    normalizedSha256: "b".repeat(64),
    view,
  },
  {
    ...common,
    status: {
      mode: "observe",
      controller: "idle",
      ownership: "unclaimed",
      takeover: "none",
      setup: "unknown",
      deviceReachability: "unknown",
      authMode: "unknown",
      browser: "unknown",
      page: "unknown",
      route: "unknown",
      webRtc: "unknown",
      hidRpc: "unknown",
      video: "unknown",
      connectionEpoch: "unknown",
      displayGeneration: "unknown",
      nativeWidth: "unknown",
      nativeHeight: "unknown",
      lastDecodedFrameAgeMs: "unknown",
      pasteCapability: "unknown",
      currentPaste: null,
      mutationGateReason: null,
      serverVersion: "0.1.0",
      packageVersion: "0.1.0",
      protocolVersion: "2025-11-25",
      uiContractVersion: "unknown",
    },
  },
  {
    ...common,
    outcome: "sent",
    receipt: {
      operationId: "op_1",
      serverGeneration: 8,
      draining: true,
      emittersJoined: true,
      pasteInactive: true,
      macroInactive: true,
      ordinaryLeases: 0,
      keyboardZeroed: true,
      pointerZeroed: true,
    },
  },
];

describe("domain contracts", () => {
  it("defines exactly five discriminated, JSON-serializable result contracts", () => {
    expect(fiveResults).toHaveLength(5);
    for (const result of fiveResults) {
      expect(result.ok).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it("uses only the explicit status inventory without a catch-all bag", () => {
    const statusResult = fiveResults[3];
    expect(statusResult.ok && Object.keys(statusResult.status).sort()).toEqual([
      "authMode",
      "browser",
      "connectionEpoch",
      "controller",
      "currentPaste",
      "deviceReachability",
      "displayGeneration",
      "hidRpc",
      "lastDecodedFrameAgeMs",
      "mode",
      "mutationGateReason",
      "nativeHeight",
      "nativeWidth",
      "ownership",
      "packageVersion",
      "page",
      "pasteCapability",
      "protocolVersion",
      "route",
      "serverVersion",
      "setup",
      "takeover",
      "uiContractVersion",
      "video",
      "webRtc",
    ]);
  });
  it("keeps status and release successes view-free while allowing a complete trusted error view", () => {
    expect("view" in fiveResults[3]).toBe(false);
    expect("view" in fiveResults[4]).toBe(false);
    const failure: FailureEnvelope = {
      ok: false,
      operationId: "op_failure",
      error: {
        code: "STALE_VIEW",
        message: "The source view is stale.",
        phase: "admit",
        outcome: "not_sent",
        retryable: true,
        effectsUnknown: false,
      },
      view,
    };

    expect(failure.view).toEqual(view);
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
    const viewFreeFailure: FailureEnvelope = {
      ok: false,
      error: failure.error,
    };
    expect("view" in viewFreeFailure).toBe(false);
  });

  it("distinguishes dispatched actions from wait-only success without inventing a receipt", () => {
    const waitOnly: ComputerActionsResult = {
      ...common,
      outcome: "not_sent",
      completedActionCount: 2,
      view,
    };
    const dispatched = fiveResults[1];

    expect(waitOnly.ok && waitOnly.outcome).toBe("not_sent");
    expect("receipt" in waitOnly).toBe(false);
    expect(dispatched.ok && dispatched.outcome).toBe("sent");
    expect(
      dispatched.ok && dispatched.outcome === "sent"
        ? dispatched.receipt.sourceViewId
        : null,
    ).toBe(view.viewId);
  });

  it("defines every supported action and classifies only coordinate actions", () => {
    const actions: Action[] = [
      { type: "click", x: 1, y: 2 },
      { type: "double_click", x: 1, y: 2, button: "right", keys: ["SHIFT"] },
      { type: "move", x: 1, y: 2 },
      {
        type: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      { type: "scroll", x: 1, y: 2, scrollY: -3, scrollX: 0 },
      { type: "keypress", keys: ["CTRL", "A"] },
      { type: "type", text: "é" },
      { type: "wait", ms: 1 },
    ];

    expect(actions.map(isCoordinateAction)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(isCoordinateAction({ type: "wait", ms: 1 })).toBe(false);
  });

  it("limits mutation outcomes to the three dispatch states", () => {
    const outcomes: MutationOutcome[] = ["not_sent", "sent", "unknown"];
    expect(outcomes).toEqual(["not_sent", "sent", "unknown"]);
  });
});
