import { describe, expect, it } from "vitest";
import {
  isCoordinateAction,
  type Action,
  type ComputerActionsResult,
  type ComputerPasteTextResult,
  type ComputerReleaseInputResult,
  type ComputerScreenshotResult,
  type ComputerStatusResult,
  type MutationOutcome,
} from "./domain.js";

const view = {
  viewId: "view_1",
  connectionEpoch: 2,
  displayGeneration: 3,
  capturedAt: "2026-07-12T12:00:00.000Z",
  width: 1280,
  height: 720,
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
    receipt: { dispatchedAt: "2026-07-12T12:00:00.000Z", sourceViewId: "view_1" },
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
      device: "unknown",
      auth: "unknown",
      browser: "unknown",
      webRtc: "unknown",
      hidRpc: "unknown",
      video: "unknown",
      pasteLifecycle: "unknown",
      mutationGate: null,
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

  it("defines every supported action and classifies only coordinate actions", () => {
    const actions: Action[] = [
      { type: "click", x: 1, y: 2 },
      { type: "double_click", x: 1, y: 2, button: "right", keys: ["SHIFT"] },
      { type: "move", x: 1, y: 2 },
      { type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      { type: "scroll", x: 1, y: 2, scrollY: -3, scrollX: 0 },
      { type: "keypress", keys: ["CTRL", "A"] },
      { type: "type", text: "é" },
      { type: "wait", ms: 1 },
    ];

    expect(actions.map(isCoordinateAction)).toEqual([true, true, true, true, true, false, false, false]);
    expect(isCoordinateAction({ type: "wait", ms: 1 })).toBe(false);
  });

  it("limits mutation outcomes to the three dispatch states", () => {
    const outcomes: MutationOutcome[] = ["not_sent", "sent", "unknown"];
    expect(outcomes).toEqual(["not_sent", "sent", "unknown"]);
  });
});
