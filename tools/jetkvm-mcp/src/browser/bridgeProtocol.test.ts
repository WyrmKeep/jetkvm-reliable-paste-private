import { describe, expect, it } from "vitest";

import {
  BrowserPlaneError,
  parseAutomationSnapshot,
  parseBridgeCallEnvelope,
  parseCaptureBridgeRequest,
  parseCaptureBridgeResult,
  parseMouseBridgeRequest,
  parseMutationBridgeReceipt,
  parsePasteBridgeReceipt,
  parseReadBridgeResult,
  parseReleaseBridgeReceipt,
  type AutomationBridgeError,
  type AutomationSnapshot,
  type CaptureBridgeResult,
} from "./bridgeProtocol.js";

const snapshot: AutomationSnapshot = {
  version: 1,
  state: "ready",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  dispatch_generation: 5,
  rpc_ready: true,
  hid_ready: true,
  video_ready: true,
  absolute_pointer: true,
  scroll_throttling_disabled: true,
  keyboard_layout: "en-US",
  reliable_paste: true,
  source_width: 1920,
  source_height: 1080,
};

const captureResult: CaptureBridgeResult = {
  operation_id: "capture-1",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  frame_sequence: 6,
  captured_at: "2026-07-13T00:00:00.000Z",
  source_width: 4,
  source_height: 2,
  image_width: 4,
  image_height: 2,
  rotation: 0,
  geometry: { x: 0, y: 0, width: 4, height: 2 },
  format: "png",
  mime_type: "image/png",
  byte_length: 3,
  sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  base64: "AQID",
};

const mutationReceipt = {
  operation_id: "mouse-1",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  dispatch_generation: 5,
  queued_at: "2026-07-13T00:00:00.000Z",
  acknowledged_at: "2026-07-13T00:00:00.001Z",
  dispatched_count: 2,
  completed_count: 2,
};

const bridgeError: AutomationBridgeError = {
  version: 1,
  name: "JetKvmAutomationError",
  code: "CHANNEL_LOST",
  stage: "acknowledgement",
  outcome: "unknown",
  operation_id: "mouse-1",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  dispatch_generation: 5,
  write_began: true,
  acknowledged: false,
  dispatched_count: 2,
  completed_count: 1,
  message: "The managed product channel was lost.",
};

describe("strict automation bridge parsing", () => {
  it("accepts the exact v1 snapshot and rejects unknown or inconsistent fields", () => {
    expect(parseAutomationSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      parseAutomationSnapshot({ ...snapshot, credential: "must-not-cross" }),
    ).toThrow();
    expect(() =>
      parseAutomationSnapshot({ ...snapshot, source_height: null }),
    ).toThrow();
    expect(() =>
      parseAutomationSnapshot({ ...snapshot, lifecycle_generation: 0 }),
    ).toThrow();
  });

  it("strictly validates capture requests and full capture results", () => {
    expect(
      parseCaptureBridgeRequest({
        operation_id: "capture-1",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        timeout_ms: 1_000,
        format: "png",
        max_width: 1280,
        max_height: 720,
      }),
    ).toBeTruthy();
    expect(parseCaptureBridgeResult(captureResult)).toEqual(captureResult);
    expect(() =>
      parseCaptureBridgeResult({ ...captureResult, mime_type: "image/jpeg" }),
    ).toThrow();
    expect(() =>
      parseCaptureBridgeResult({
        ...captureResult,
        geometry: { ...captureResult.geometry, x: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseCaptureBridgeResult({ ...captureResult, raw_frame: "AQID" }),
    ).toThrow();
  });

  it("strictly validates bounded expanded mouse operations and receipts", () => {
    expect(
      parseMouseBridgeRequest({
        operation_id: "mouse-1",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 1_000,
        operations: [
          { kind: "absolute", x: 0, y: 32_767, buttons: 7 },
          { kind: "wheel", delta_y: -127 },
        ],
      }).operations,
    ).toHaveLength(2);
    expect(() =>
      parseMouseBridgeRequest({
        operation_id: "mouse-1",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 1_000,
        operations: [{ kind: "wheel", delta_y: 0 }],
      }),
    ).toThrow();
    expect(parseMutationBridgeReceipt(mutationReceipt)).toEqual(
      mutationReceipt,
    );
    expect(() =>
      parseMutationBridgeReceipt({
        ...mutationReceipt,
        dispatched_count: 1,
        completed_count: 2,
      }),
    ).toThrow();
    expect(() =>
      parseMutationBridgeReceipt({
        ...mutationReceipt,
        queued_at: "2026-07-13T00:00:00.002Z",
      }),
    ).toThrow();
  });

  it("validates paste, release, and JSON-only read results without widening", () => {
    const paste = {
      operation_id: "paste-1",
      lifecycle_generation: 2,
      channel_generation: 3,
      display_generation: 4,
      dispatch_generation: 5,
      original_byte_count: 4,
      normalized_byte_count: 3,
      normalized_sha256:
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      accepted_at: "2026-07-13T00:00:00.000Z",
      completed_at: "2026-07-13T00:00:00.100Z",
      terminal_state: "succeeded" as const,
      measured_source_cps: 90.9,
    };
    expect(parsePasteBridgeReceipt(paste)).toEqual(paste);
    expect(() =>
      parsePasteBridgeReceipt({ ...paste, text: "private" }),
    ).toThrow();
    expect(() =>
      parsePasteBridgeReceipt({
        ...paste,
        accepted_at: "2026-07-13T00:00:00.200Z",
      }),
    ).toThrow();

    const release = {
      operation_id: "release-1",
      lifecycle_generation: 2,
      channel_generation: 3,
      display_generation: 4,
      dispatch_generation: 6,
      device_generation: 9,
      outcome: "released" as const,
      draining: true as const,
      producers_joined: true as const,
      macro_inactive: true as const,
      paste_inactive: true as const,
      ordinary_leases_zero: true as const,
      keyboard_zero: true as const,
      pointer_zero: true as const,
      released_at: "2026-07-13T00:00:00.200Z",
    };
    expect(parseReleaseBridgeReceipt(release)).toEqual(release);
    expect(() =>
      parseReleaseBridgeReceipt({ ...release, pointer_zero: false }),
    ).toThrow();

    const read = {
      operation_id: "read-1",
      lifecycle_generation: 2,
      channel_generation: 3,
      acknowledged_at: "2026-07-13T00:00:00.000Z",
      result: { ready: true, nested: [1, "two", null] },
    };
    expect(parseReadBridgeResult(read)).toEqual(read);
    expect(() =>
      parseReadBridgeResult({ ...read, result: undefined }),
    ).toThrow();
  });

  it("accepts only exact call envelopes and exact safe bridge errors", () => {
    expect(parseBridgeCallEnvelope({ ok: true, value: captureResult })).toEqual(
      {
        ok: true,
        value: captureResult,
      },
    );
    expect(parseBridgeCallEnvelope({ ok: false, error: bridgeError })).toEqual({
      ok: false,
      error: bridgeError,
    });
    expect(() =>
      parseBridgeCallEnvelope({
        ok: false,
        error: { ...bridgeError, message: "hostile downstream details" },
      }),
    ).toThrow();
    expect(() =>
      parseBridgeCallEnvelope({ ok: true, value: captureResult, debug: true }),
    ).toThrow();
  });
});

describe("BrowserPlaneError", () => {
  it("publishes the stable sanitized handler-facing error contract", () => {
    const error = BrowserPlaneError.fromBridge(bridgeError, 3);
    expect(error).toMatchObject({
      name: "BrowserPlaneError",
      code: "CONNECTION_LOST",
      outcome: "unknown",
      stage: "acknowledgement",
      boundary: "ack",
      writeBegan: true,
      acknowledged: false,
      dispatchedCount: 2,
      completedCount: 1,
      failedIndex: 1,
      suffixSuppressed: true,
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
    });
    expect(JSON.stringify(error)).not.toContain("managed product");
    expect(JSON.stringify(error)).not.toContain("message");
  });

  it("maps paste lifecycle failure by the first-write boundary", () => {
    const beforeWrite = BrowserPlaneError.fromBridge(
      {
        ...bridgeError,
        code: "PASTE_LIFECYCLE",
        stage: "queue",
        outcome: "not_sent",
        operation_id: "paste-before-write",
        write_began: false,
        dispatched_count: 0,
        completed_count: 0,
        message: "Reliable Paste completion could not be verified.",
      },
      1,
    );
    expect(beforeWrite).toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
      stage: "queue",
      writeBegan: false,
      safeToRetry: true,
      requiredNextStep: "reconnect_then_capture",
    });

    const afterWrite = BrowserPlaneError.fromBridge(
      {
        ...bridgeError,
        code: "PASTE_LIFECYCLE",
        operation_id: "paste-after-write",
        dispatched_count: 1,
        completed_count: 0,
        message: "Reliable Paste completion could not be verified.",
      },
      1,
    );
    expect(afterWrite).toMatchObject({
      code: "EVENT_GAP",
      outcome: "unknown",
      writeBegan: true,
      safeToRetry: false,
      requiredNextStep: "release_then_reconnect_then_capture",
    });
  });

  it("preserves the qualified EDID failure without exposing lower-layer details", () => {
    const error = BrowserPlaneError.fromBridge(
      {
        ...bridgeError,
        code: "EDID_READ_FAILED",
        operation_id: "read-edid-1",
        write_began: true,
        dispatched_count: 1,
        completed_count: 0,
        message: "The native EDID read failed.",
      },
      1,
    );

    expect(error).toMatchObject({
      code: "EDID_READ_FAILED",
      outcome: "unknown",
      writeBegan: true,
      safeToRetry: false,
      requiredNextStep: "none",
    });
    expect(JSON.stringify(error)).not.toContain("EDID read failed");
  });

  it.each([
    ["CONFIG_INVALID", "The ATX action configuration is invalid.", "none"],
    [
      "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
      "The ATX request id was reused with different input.",
      "none",
    ],
    [
      "STALE_SESSION_GENERATION",
      "The device session generation is stale.",
      "reconnect_then_capture",
    ],
  ] as const)(
    "preserves a definitive %s negative acknowledgement as not sent",
    (code, message, requiredNextStep) => {
      const error = BrowserPlaneError.fromBridge(
        {
          ...bridgeError,
          code,
          outcome: "not_sent",
          acknowledged: true,
          dispatched_count: 0,
          completed_count: 0,
          message,
        },
        1,
      );

      expect(error).toMatchObject({
        code,
        outcome: "not_sent",
        safeToRetry: false,
        requiredNextStep,
      });
    },
  );

  it("preserves an acknowledged explicit unknown ATX outcome", () => {
    const error = BrowserPlaneError.fromBridge(
      {
        ...bridgeError,
        code: "MUTATION_OUTCOME_UNKNOWN",
        outcome: "unknown",
        acknowledged: true,
        dispatched_count: 1,
        completed_count: 0,
        message: "The ATX mutation outcome is unknown.",
      },
      1,
    );

    expect(error).toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      outcome: "unknown",
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
    });
  });

  it("treats a correlated acknowledgement as applied and never fabricates unknown", () => {
    const error = BrowserPlaneError.fromBridge(
      {
        ...bridgeError,
        code: "MALFORMED_ACKNOWLEDGEMENT",
        acknowledged: true,
        dispatched_count: 2,
        completed_count: 2,
        message: "The product acknowledgement was invalid.",
      },
      2,
    );
    expect(error.outcome).toBe("applied");
    expect(error.code).toBe("PARTIAL_VERIFICATION");
    expect(error.failedIndex).toBeUndefined();
    expect(error.safeToRetry).toBe(false);
  });
});
