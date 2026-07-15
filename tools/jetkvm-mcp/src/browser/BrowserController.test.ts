import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import {
  BrowserPlaneError,
  type AutomationSnapshot,
  type CaptureBridgeRequest,
  type CaptureBridgeResult,
  type MouseBridgeRequest,
  type MutationBridgeReceipt,
  type ReleaseBridgeReceipt,
  type ReleaseBridgeRequest,
} from "./bridgeProtocol.js";
import { BrowserController } from "./BrowserController.js";

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
const deadline = { timeoutMs: 1_000, signal: new AbortController().signal };
const captureRequest: CaptureBridgeRequest = {
  operation_id: "capture-1",
  expected_lifecycle_generation: 2,
  expected_channel_generation: 3,
  timeout_ms: 1_000,
  format: "png",
  max_width: 1280,
  max_height: 720,
};
const captureResult: CaptureBridgeResult = {
  operation_id: "capture-1",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  frame_sequence: 1,
  captured_at: "2026-07-13T00:00:00.000Z",
  source_width: 1920,
  source_height: 1080,
  image_width: 1280,
  image_height: 720,
  rotation: 0,
  geometry: { x: 0, y: 0, width: 1280, height: 720 },
  format: "png",
  mime_type: "image/png",
  byte_length: 3,
  sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  base64: "AQID",
};
const mouseRequest: MouseBridgeRequest = {
  operation_id: "mouse-1",
  expected_lifecycle_generation: 2,
  expected_channel_generation: 3,
  expected_display_generation: 4,
  expected_dispatch_generation: 5,
  timeout_ms: 1_000,
  operations: [
    { kind: "absolute", x: 0, y: 0, buttons: 0 },
    { kind: "absolute", x: 0, y: 0, buttons: 1 },
  ],
};
const mutationReceipt: MutationBridgeReceipt = {
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
const releaseRequest: ReleaseBridgeRequest = {
  operation_id: "release-1",
  expected_lifecycle_generation: 2,
  expected_channel_generation: 3,
  expected_display_generation: 4,
  expected_dispatch_generation: 5,
  timeout_ms: 1_000,
};
const releaseReceipt: ReleaseBridgeReceipt = {
  operation_id: "release-1",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 6,
  dispatch_generation: 6,
  device_generation: 9,
  outcome: "released",
  draining: true,
  producers_joined: true,
  macro_inactive: true,
  paste_inactive: true,
  ordinary_leases_zero: true,
  keyboard_zero: true,
  pointer_zero: true,
  released_at: "2026-07-13T00:00:00.200Z",
};

class QueuePage {
  public readonly calls: Array<{ readonly argument: unknown }> = [];
  public readonly values: unknown[];
  public reloadCalls = 0;
  public readonly waits: number[] = [];

  public constructor(values: readonly unknown[]) {
    this.values = [...values];
  }

  public async evaluate(
    _callback: unknown,
    argument?: unknown,
  ): Promise<unknown> {
    this.calls.push({ argument });
    if (this.values.length === 0)
      throw new Error("Unexpected page evaluation.");
    const next = this.values.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  public async reload(): Promise<null> {
    this.reloadCalls += 1;
    return null;
  }

  public async waitForTimeout(timeoutMs: number): Promise<void> {
    this.waits.push(timeoutMs);
  }

  public async close(): Promise<void> {}
}

function controllerFor(values: readonly unknown[]): {
  readonly page: QueuePage;
  readonly controller: BrowserController;
} {
  const page = new QueuePage(values);
  return {
    page,
    controller: new BrowserController(page as unknown as Page),
  };
}

describe("BrowserController", () => {
  it("strictly validates the facade snapshot", async () => {
    const { controller } = controllerFor([snapshot]);
    await expect(controller.snapshot(deadline)).resolves.toEqual(snapshot);

    const malformed = controllerFor([{ ...snapshot, token: "secret" }]);
    await expect(malformed.controller.snapshot(deadline)).rejects.toMatchObject(
      {
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        outcome: "not_sent",
        writeBegan: false,
      },
    );
  });

  it("calls capture through one page and fences exact generations before and after", async () => {
    const { controller, page } = controllerFor([
      snapshot,
      { ok: true, value: captureResult },
      snapshot,
    ]);
    await expect(controller.capture(captureRequest, deadline)).resolves.toEqual(
      captureResult,
    );
    expect(page.calls).toHaveLength(3);
    expect(page.calls[1]?.argument).toEqual(captureRequest);

    const preReplacement = controllerFor([
      { ...snapshot, channel_generation: 4 },
      { ok: true, value: captureResult },
    ]);
    await expect(
      preReplacement.controller.capture(captureRequest, deadline),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
      writeBegan: false,
    });
    expect(preReplacement.page.calls).toHaveLength(1);
  });

  it("rejects strict result drift instead of returning unvalidated page data", async () => {
    const { controller } = controllerFor([
      snapshot,
      { ok: true, value: { ...captureResult, debug: "private" } },
      snapshot,
    ]);
    await expect(
      controller.capture(captureRequest, deadline),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_MALFORMED_RESPONSE",
      outcome: "not_sent",
    });
  });

  it("preserves exact pre-write and post-write channel replacement outcomes", async () => {
    const beforeWrite = controllerFor([
      snapshot,
      {
        ok: false,
        error: {
          version: 1,
          name: "JetKvmAutomationError",
          code: "CHANNEL_LOST",
          stage: "queue",
          outcome: "not_sent",
          operation_id: "mouse-1",
          lifecycle_generation: 2,
          channel_generation: 4,
          display_generation: 4,
          dispatch_generation: 5,
          write_began: false,
          acknowledged: false,
          dispatched_count: 0,
          completed_count: 0,
          message: "The managed product channel was lost.",
        },
      },
    ]);
    await expect(
      beforeWrite.controller.mouse(mouseRequest, deadline),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
      stage: "queue",
      writeBegan: false,
      dispatchedCount: 0,
      completedCount: 0,
    });

    const afterWrite = controllerFor([
      snapshot,
      {
        ok: false,
        error: {
          version: 1,
          name: "JetKvmAutomationError",
          code: "CHANNEL_LOST",
          stage: "acknowledgement",
          outcome: "unknown",
          operation_id: "mouse-1",
          lifecycle_generation: 2,
          channel_generation: 4,
          display_generation: 4,
          dispatch_generation: 5,
          write_began: true,
          acknowledged: false,
          dispatched_count: 1,
          completed_count: 0,
          message: "The managed product channel was lost.",
        },
      },
    ]);
    await expect(
      afterWrite.controller.mouse(mouseRequest, deadline),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "unknown",
      stage: "acknowledgement",
      writeBegan: true,
      dispatchedCount: 1,
      completedCount: 0,
      failedIndex: 0,
      suffixSuppressed: true,
    });
  });

  it("classifies a replacement after definitive acknowledgement as applied verification loss", async () => {
    const { controller } = controllerFor([
      snapshot,
      { ok: true, value: mutationReceipt },
      { ...snapshot, channel_generation: 4 },
    ]);
    const caught = await controller
      .mouse(mouseRequest, deadline)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(BrowserPlaneError);
    expect(caught).toMatchObject({
      code: "PARTIAL_VERIFICATION",
      outcome: "applied",
      acknowledged: true,
      dispatchedCount: 2,
      completedCount: 2,
      safeToRetry: false,
    });
  });

  it("accepts definitive release across unrelated display generation changes", async () => {
    const { controller } = controllerFor([
      { ...snapshot, display_generation: 6 },
      { ok: true, value: releaseReceipt },
      {
        ...snapshot,
        state: "closed",
        display_generation: 7,
        dispatch_generation: 6,
      },
    ]);

    await expect(controller.release(releaseRequest, deadline)).resolves.toEqual(
      releaseReceipt,
    );
  });
  it("keeps release fenced by dispatch generation during display churn", async () => {
    const { controller, page } = controllerFor([
      {
        ...snapshot,
        display_generation: 6,
        dispatch_generation: 6,
      },
    ]);

    await expect(
      controller.release(releaseRequest, deadline),
    ).rejects.toMatchObject({
      code: "SESSION_DRAINED",
      outcome: "not_sent",
      writeBegan: false,
    });
    expect(page.calls).toHaveLength(1);
  });

  it("forwards cancellation to the exact in-page operation before returning", async () => {
    const pending = Promise.withResolvers<unknown>();
    const abort = new AbortController();
    const { controller, page } = controllerFor([
      snapshot,
      pending.promise,
      true,
    ]);
    const operation = controller.mouse(mouseRequest, {
      timeoutMs: 1_000,
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(page.calls).toHaveLength(2));

    abort.abort();
    await expect(operation).rejects.toMatchObject({
      code: "MUTATION_OUTCOME_UNKNOWN",
      outcome: "unknown",
    });
    await vi.waitFor(() => expect(page.calls).toHaveLength(3));
    expect(page.calls[2]?.argument).toBe(mouseRequest.operation_id);
    pending.resolve({
      ok: false,
      error: {
        version: 1,
        name: "JetKvmAutomationError",
        code: "CANCELLED",
        stage: "acknowledgement",
        outcome: "unknown",
        operation_id: mouseRequest.operation_id,
        lifecycle_generation: 2,
        channel_generation: 3,
        display_generation: 4,
        dispatch_generation: 5,
        write_began: true,
        acknowledged: false,
        dispatched_count: 1,
        completed_count: 0,
        message: "The automation operation was cancelled.",
      },
    });
  });

  it("waits for stable ready generations after reloading", async () => {
    const changedChannel = { ...snapshot, channel_generation: 4 };
    const { controller, page } = controllerFor([
      snapshot,
      changedChannel,
      changedChannel,
      changedChannel,
    ]);
    const previousIdentity = controller.connectionIdentity();

    await expect(controller.reconnect(deadline)).resolves.toBeUndefined();
    await expect(controller.stableReadySnapshot(deadline)).resolves.toEqual(
      changedChannel,
    );
    expect(controller.connectionIdentity()).not.toBe(previousIdentity);

    expect(page.reloadCalls).toBe(1);
    expect(page.waits).toEqual([250, 250, 250]);
    expect(page.values).toHaveLength(0);
  });

  it("bounds page close with the caller cancellation signal", async () => {
    const page = new QueuePage([]);
    const closeGate = Promise.withResolvers<void>();
    const closeSpy = vi
      .spyOn(page, "close")
      .mockImplementation(() => closeGate.promise);
    const controller = new BrowserController(page as unknown as Page);
    const abort = new AbortController();
    const operation = controller.close({
      timeoutMs: 1_000,
      signal: abort.signal,
    });

    abort.abort();
    await expect(operation).rejects.toMatchObject({
      code: "CANCELLED",
      outcome: "not_sent",
    });
    expect(closeSpy).toHaveBeenCalledOnce();
    const retry = controller.close(deadline);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    closeGate.resolve();
    await expect(retry).resolves.toBeUndefined();
    await expect(controller.close(deadline)).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not enter the page when cancellation already won", async () => {
    const abort = new AbortController();
    abort.abort();
    const { controller, page } = controllerFor([snapshot]);
    await expect(
      controller.snapshot({ timeoutMs: 1_000, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", outcome: "not_sent" });
    expect(page.calls).toHaveLength(0);
  });
});
