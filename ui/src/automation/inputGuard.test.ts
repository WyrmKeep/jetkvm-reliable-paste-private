import { describe, expect, it } from "vitest";

import {
  OperationFence,
  validateKeyboardRequest,
  validateMouseRequest,
  validatePasteRequest,
  validateReleaseBridgeRequest,
} from "./inputGuard";
import type {
  AutomationSnapshot,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  PasteBridgeRequest,
  ReleaseBridgeRequest,
} from "./protocol";

const readySnapshot = (): AutomationSnapshot => ({
  version: 1,
  state: "ready",
  lifecycle_generation: 4,
  channel_generation: 5,
  display_generation: 6,
  dispatch_generation: 7,
  rpc_ready: true,
  hid_ready: true,
  video_ready: true,
  absolute_pointer: true,
  scroll_throttling_disabled: true,
  keyboard_layout: "en-US",
  reliable_paste: true,
  source_width: 1920,
  source_height: 1080,
});

const inputBase = {
  operation_id: "input-1",
  expected_lifecycle_generation: 4,
  expected_channel_generation: 5,
  expected_display_generation: 6,
  expected_dispatch_generation: 7,
  timeout_ms: 1000,
};

describe("automation input admission", () => {
  it("prevalidates a complete mouse batch before any queue or write", () => {
    const request: MouseBridgeRequest = {
      ...inputBase,
      operations: [
        { kind: "absolute", x: 1, y: 2, buttons: 0 },
        { kind: "wheel", delta_y: 0 },
      ],
    };

    expect(() => validateMouseRequest(request, readySnapshot())).toThrow();
    try {
      validateMouseRequest(request, readySnapshot());
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        stage: "admission",
        outcome: "not_sent",
        write_began: false,
        dispatched_count: 0,
      });
    }
  });

  it("accepts only uint8 physical-key transitions and rejects an invalid suffix as a whole batch", () => {
    const request: KeyboardBridgeRequest = {
      ...inputBase,
      operations: [
        { key: 4, press: true },
        { key: 256, press: false },
      ],
    };
    expect(() => validateKeyboardRequest(request, readySnapshot())).toThrow();
    expect(() =>
      validateKeyboardRequest(
        {
          ...request,
          operations: [
            { key: 4, press: true },
            { key: 4, press: false },
          ],
        },
        readySnapshot(),
      ),
    ).not.toThrow();
  });
  it("accepts the exact expanded public batch maxima and rejects plus one", () => {
    const mouseOperation = { kind: "absolute" as const, x: 1, y: 2, buttons: 0 };
    expect(() =>
      validateMouseRequest(
        {
          ...inputBase,
          operations: Array.from({ length: 1056 }, () => mouseOperation),
        },
        readySnapshot(),
      ),
    ).not.toThrow();
    expect(() =>
      validateMouseRequest(
        {
          ...inputBase,
          operations: Array.from({ length: 1057 }, () => mouseOperation),
        },
        readySnapshot(),
      ),
    ).toThrow();

    const keyboardOperation = { key: 4, press: true };
    expect(() =>
      validateKeyboardRequest(
        {
          ...inputBase,
          operations: Array.from({ length: 1024 }, () => keyboardOperation),
        },
        readySnapshot(),
      ),
    ).not.toThrow();
    expect(() =>
      validateKeyboardRequest(
        {
          ...inputBase,
          operations: Array.from({ length: 1025 }, () => keyboardOperation),
        },
        readySnapshot(),
      ),
    ).toThrow();
  });

  it("requires normalized paste input to remain within the byte contract", () => {
    const empty: PasteBridgeRequest = { ...inputBase, text: "" };
    const tooLarge: PasteBridgeRequest = { ...inputBase, text: "x".repeat(262_145) };
    expect(() => validatePasteRequest(empty, readySnapshot())).toThrow();
    expect(() => validatePasteRequest(tooLarge, readySnapshot())).toThrow();
    expect(() =>
      validatePasteRequest({ ...inputBase, text: "\uFEFFok\r\n" }, readySnapshot()),
    ).not.toThrow();
  });
  it("keeps release admission independent of display generation", () => {
    const request: ReleaseBridgeRequest = inputBase;
    expect(() =>
      validateReleaseBridgeRequest(request, {
        ...readySnapshot(),
        display_generation: 8,
      }),
    ).not.toThrow();
    expect(() =>
      validateReleaseBridgeRequest(request, {
        ...readySnapshot(),
        display_generation: 8,
        dispatch_generation: 9,
      }),
    ).toThrow();
  });
});

describe("OperationFence", () => {
  it("classifies replacement before the first write as not sent", () => {
    let snapshot = readySnapshot();
    const fence = new OperationFence(
      inputBase,
      () => snapshot,
      () => true,
      0,
    );
    snapshot = { ...snapshot, channel_generation: 8 };

    expect(() => fence.verify("queue", 1)).toThrow();
    try {
      fence.verify("queue", 1);
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHANNEL_LOST",
        stage: "queue",
        outcome: "not_sent",
        write_began: false,
        acknowledged: false,
        dispatched_count: 0,
        completed_count: 0,
      });
    }
  });

  it("classifies replacement after a write as unknown with exact counts", () => {
    let snapshot = readySnapshot();
    const fence = new OperationFence(
      inputBase,
      () => snapshot,
      () => true,
      0,
    );
    fence.markWriteBegan();
    fence.markDispatched();
    snapshot = { ...snapshot, lifecycle_generation: 9, channel_generation: 10 };

    try {
      fence.verify("acknowledgement", 1);
      throw new Error("expected fence failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHANNEL_LOST",
        stage: "acknowledgement",
        outcome: "unknown",
        write_began: true,
        acknowledged: false,
        dispatched_count: 1,
        completed_count: 0,
      });
    }
  });

  it("retains the real post-write outcome when a deadline elapses", () => {
    const fence = new OperationFence(inputBase, readySnapshot, () => true, 0);
    fence.markWriteBegan();
    fence.markDispatched();
    fence.markCompleted();
    fence.markAcknowledged();

    try {
      fence.verify("verification", 1001);
      throw new Error("expected deadline failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "DEADLINE_EXCEEDED",
        outcome: "unknown",
        acknowledged: true,
        dispatched_count: 1,
        completed_count: 1,
      });
    }
  });
  it("converts fractional monotonic time to a conservative integer budget", () => {
    const fence = new OperationFence(inputBase, readySnapshot, () => true, 0);

    expect(fence.remainingMs(0.27)).toBe(999);
    expect(fence.remainingMs(999.9)).toBe(1);
    expect(fence.remainingMs(1000)).toBe(0);
    expect(Number.isSafeInteger(fence.remainingMs(123.456))).toBe(true);
  });
});
