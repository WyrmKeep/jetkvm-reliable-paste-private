import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PHYSICAL_KEYS,
  type KeyboardAction,
  type PhysicalKey,
} from "../domain.js";
import {
  DeviceRpcError,
  type AtxWireReceipt,
  type CachedDisplayState,
  type Deadline,
  type DeviceRpcBinding,
  type QualifiedEdidRead,
} from "../device/DeviceRpcAdapter.js";
import type { BrowserControllerPort } from "../browser/BrowserController.js";
import {
  BrowserPlaneError,
  type AutomationSnapshot,
  type CaptureBridgeRequest,
  type CaptureBridgeResult,
  type KeyboardBridgeRequest,
  type KeyboardBridgeReceipt,
  type MouseBridgeRequest,
  type MutationBridgeReceipt,
  type PasteBridgeRequest,
  type PasteBridgeReceipt,
  type ReadBridgeRequest,
  type ReadBridgeResult,
  type ReleaseBridgeRequest,
  type ReleaseBridgeReceipt,
} from "../browser/bridgeProtocol.js";
import {
  JetKvmBrowserPlane,
  expandKeyboardActions,
  resolvePhysicalKeyUsage,
} from "./JetKvmBrowserPlane.js";

const ref = { sessionId: "session-a", sessionGeneration: 1 };
const deadline: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const readySnapshot: AutomationSnapshot = {
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

class TestClock {
  public value = 0;
  public now(): number {
    return this.value;
  }
}

class FakeController implements BrowserControllerPort {
  public snapshotValue: AutomationSnapshot = readySnapshot;
  public readonly captureRequests: CaptureBridgeRequest[] = [];
  public readonly mouseRequests: MouseBridgeRequest[] = [];
  public readonly keyboardRequests: KeyboardBridgeRequest[] = [];
  public readonly pasteAudit: Array<{
    readonly operationId: string;
    readonly normalizedSha256: string;
    readonly normalizedByteCount: number;
  }> = [];
  public readonly releaseRequests: ReleaseBridgeRequest[] = [];
  public mouseError: BrowserPlaneError | null = null;
  public keyboardError: BrowserPlaneError | null = null;
  public pasteError: BrowserPlaneError | null = null;
  public captureError: BrowserPlaneError | null = null;
  public readVideoResult: ReadBridgeResult["result"] = {
    validation_poll_completed: true,
    cached_event: null,
  };
  public readEdidResult: ReadBridgeResult["result"] = null;
  public readEdidError: BrowserPlaneError | null = null;
  public readEdidGate: Promise<void> | null = null;
  public closed = false;
  public frameSequence = 0;

  public async snapshot(_deadline: Deadline): Promise<AutomationSnapshot> {
    return this.snapshotValue;
  }

  public async capture(
    request: CaptureBridgeRequest,
    _deadline: Deadline,
  ): Promise<CaptureBridgeResult> {
    if (this.captureError) throw this.captureError;
    this.captureRequests.push(request);
    this.frameSequence += 1;
    const bytes = new Uint8Array([1, 2, this.frameSequence]);
    return {
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      display_generation: this.snapshotValue.display_generation,
      frame_sequence: this.frameSequence,
      captured_at: "2026-07-13T00:00:00.000Z",
      source_width: 1920,
      source_height: 1080,
      image_width: request.max_width,
      image_height: request.max_height,
      rotation: 0,
      geometry: {
        x: 0,
        y: 0,
        width: request.max_width,
        height: request.max_height,
      },
      format: request.format,
      mime_type: request.format === "png" ? "image/png" : "image/jpeg",
      byte_length: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: Buffer.from(bytes).toString("base64"),
    };
  }

  public async mouse(
    request: MouseBridgeRequest,
    _deadline: Deadline,
  ): Promise<MutationBridgeReceipt> {
    this.mouseRequests.push(request);
    if (this.mouseError) {
      const error = this.mouseError;
      this.mouseError = null;
      throw error;
    }
    return mutationReceipt(request, request.operations.length);
  }

  public async keyboard(
    request: KeyboardBridgeRequest,
    _deadline: Deadline,
  ): Promise<KeyboardBridgeReceipt> {
    this.keyboardRequests.push(request);
    if (this.keyboardError) {
      const error = this.keyboardError;
      this.keyboardError = null;
      throw error;
    }
    return mutationReceipt(request, request.operations.length);
  }

  public async paste(
    request: PasteBridgeRequest,
    _deadline: Deadline,
  ): Promise<PasteBridgeReceipt> {
    const normalized = normalize(request.text);
    const normalizedSha256 = createHash("sha256")
      .update(normalized)
      .digest("hex");
    const normalizedByteCount = Buffer.byteLength(normalized);
    this.pasteAudit.push({
      operationId: request.operation_id,
      normalizedSha256,
      normalizedByteCount,
    });
    if (this.pasteError) {
      const error = this.pasteError;
      this.pasteError = null;
      throw error;
    }
    return {
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      display_generation: request.expected_display_generation,
      dispatch_generation: request.expected_dispatch_generation,
      original_byte_count: Buffer.byteLength(request.text),
      normalized_byte_count: normalizedByteCount,
      normalized_sha256: normalizedSha256,
      accepted_at: "2026-07-13T00:00:00.000Z",
      completed_at: "2026-07-13T00:00:00.100Z",
      terminal_state: "succeeded",
      measured_source_cps: 90.9,
    };
  }

  public async release(
    request: ReleaseBridgeRequest,
    _deadline: Deadline,
  ): Promise<ReleaseBridgeReceipt> {
    this.releaseRequests.push(request);
    this.snapshotValue = {
      ...this.snapshotValue,
      state: "closed",
      dispatch_generation: this.snapshotValue.dispatch_generation + 1,
    };
    return {
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      display_generation: request.expected_display_generation,
      dispatch_generation: this.snapshotValue.dispatch_generation,
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
  }

  public async readVideoState(
    request: ReadBridgeRequest,
    _deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return {
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      acknowledged_at: "2026-07-13T00:00:00.000Z",
      result: this.readVideoResult,
    };
  }

  public async readEdid(
    request: ReadBridgeRequest,
    _deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    await this.readEdidGate;
    if (this.readEdidError) throw this.readEdidError;
    return {
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      acknowledged_at: "2026-07-13T00:00:00.000Z",
      result: this.readEdidResult,
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

function mutationReceipt(
  request: MouseBridgeRequest | KeyboardBridgeRequest,
  count: number,
): MutationBridgeReceipt {
  return {
    operation_id: request.operation_id,
    lifecycle_generation: request.expected_lifecycle_generation,
    channel_generation: request.expected_channel_generation,
    display_generation: request.expected_display_generation,
    dispatch_generation: request.expected_dispatch_generation,
    queued_at: "2026-07-13T00:00:00.000Z",
    acknowledged_at: "2026-07-13T00:00:00.001Z",
    dispatched_count: count,
    completed_count: count,
  };
}

function normalize(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
}

function setup(maxObservationAgeMs = 30_000) {
  const controller = new FakeController();
  const clock = new TestClock();
  let id = 0;
  const plane = new JetKvmBrowserPlane(controller, {
    clock,
    maxObservationAgeMs,
    idFactory: (prefix) => `${prefix}-${++id}`,
  });
  return { plane, controller, clock };
}

async function capture(
  plane: JetKvmBrowserPlane,
  format: "jpeg" | "png" = "png",
) {
  return plane.capture(
    ref,
    { format, maxWidth: 1280, maxHeight: 720 },
    deadline,
  );
}

function partialError(
  dispatchedCount: number,
  completedCount: number,
): BrowserPlaneError {
  return new BrowserPlaneError({
    code: "CONNECTION_LOST",
    outcome: "unknown",
    stage: "acknowledgement",
    writeBegan: true,
    acknowledged: false,
    dispatchedCount,
    completedCount,
    requestedCount: 99,
    failedIndex: completedCount,
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    suffixSuppressed: true,
  });
}

describe("JetKvmBrowserPlane capture and observation ledger", () => {
  it("publishes a byte-free fresh observation and exact shared adapter identity", async () => {
    const { plane } = setup();
    const connection = await plane.connect(ref, deadline);
    const artifact = await capture(plane);

    expect(connection).toMatchObject({
      state: "ready",
      ref,
      connectionEpoch: 2,
      browserChannelGeneration: 3,
      displayGeneration: 4,
    });
    expect(connection.deviceRpc).toBe(plane.deviceRpc);
    expect(connection.binding).toBe(plane.deviceRpc.binding);
    expect(artifact.observation).toMatchObject({
      sessionId: "session-a",
      sessionGeneration: 1,
      connectionEpoch: 2,
      displayGeneration: 4,
      monotonicAgeMs: 0,
      sourceWidth: 1920,
      sourceHeight: 1080,
      imageWidth: 1280,
      imageHeight: 720,
      rotation: 0,
      format: "png",
      byteLength: 3,
    });
    expect(Object.keys(artifact.observation)).not.toContain("bytes");
    expect(Object.keys(artifact.observation)).not.toContain("base64");
    expect(artifact.image.bytes).toBeInstanceOf(Uint8Array);
  });

  it("rejects a non-advancing frame sequence as stalled", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    await capture(plane);
    controller.frameSequence = 0;
    await expect(capture(plane)).rejects.toMatchObject({
      code: "VIDEO_STALLED",
      outcome: "not_sent",
    });
  });

  it("accepts fresh observations, rejects stale ones, and invalidates on display change", async () => {
    const { plane, controller, clock } = setup(10);
    await plane.connect(ref, deadline);
    const first = await capture(plane);
    clock.value = 10;
    await expect(
      plane.mouse(
        ref,
        {
          observationId: first.observation.observationId,
          requestId: "mouse-fresh",
          actions: [{ type: "move", x: 0, y: 0 }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ dispatchedCount: 1, completedCount: 1 });

    const stale = await capture(plane);
    clock.value = 21;
    await expect(
      plane.mouse(
        ref,
        {
          observationId: stale.observation.observationId,
          requestId: "mouse-stale",
          actions: [{ type: "move", x: 0, y: 0 }],
        },
        deadline,
      ),
    ).rejects.toMatchObject({ code: "STALE_OBSERVATION", outcome: "not_sent" });

    clock.value = 22;
    const changed = await capture(plane);
    controller.snapshotValue = {
      ...controller.snapshotValue,
      display_generation: 5,
    };
    await expect(
      plane.mouse(
        ref,
        {
          observationId: changed.observation.observationId,
          requestId: "mouse-changed",
          actions: [{ type: "move", x: 0, y: 0 }],
        },
        deadline,
      ),
    ).rejects.toMatchObject({ code: "DISPLAY_CHANGED", outcome: "not_sent" });
  });

  it("reserves observations once, releases only definitive not-sent, and consumes uncertainty", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const artifact = await capture(plane);
    controller.mouseError = new BrowserPlaneError({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
      stage: "queue",
      writeBegan: false,
      acknowledged: false,
      dispatchedCount: 0,
      completedCount: 0,
      requestedCount: 1,
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
      suffixSuppressed: false,
    });
    const request = {
      observationId: artifact.observation.observationId,
      requestId: "mouse-once",
      actions: [{ type: "move" as const, x: 0, y: 0 }],
    };
    await expect(plane.mouse(ref, request, deadline)).rejects.toMatchObject({
      outcome: "not_sent",
    });
    await expect(plane.mouse(ref, request, deadline)).resolves.toMatchObject({
      outcome: "applied",
    });
    await expect(plane.mouse(ref, request, deadline)).rejects.toMatchObject({
      code: "OBSERVATION_CONSUMED",
    });

    const uncertain = await capture(plane);
    controller.mouseError = partialError(1, 0);
    await expect(
      plane.mouse(
        ref,
        {
          ...request,
          requestId: "mouse-unknown",
          observationId: uncertain.observation.observationId,
        },
        deadline,
      ),
    ).rejects.toMatchObject({ outcome: "unknown" });
    await expect(capture(plane)).rejects.toMatchObject({
      code: "SESSION_DRAINED",
    });
    await expect(
      plane.release(ref, { requestId: "release-after-unknown" }, deadline),
    ).resolves.toMatchObject({
      outcome: "applied",
      mutationGateClosed: true,
    });
  });
});

describe("JetKvmBrowserPlane input expansion", () => {
  it("expands every mouse action and maps partial operation counts to action counts", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const artifact = await capture(plane);
    controller.mouseError = partialError(2, 1);
    await expect(
      plane.mouse(
        ref,
        {
          observationId: artifact.observation.observationId,
          requestId: "mouse-partial",
          actions: [
            { type: "move", x: 0, y: 0 },
            { type: "click", x: 10, y: 10, button: "left" },
            { type: "scroll", x: 20, y: 20, delta_y: 127 },
          ],
        },
        deadline,
      ),
    ).rejects.toMatchObject({
      outcome: "unknown",
      dispatchedCount: 2,
      completedCount: 1,
      failedIndex: 1,
      suffixSuppressed: true,
    });
    expect(controller.mouseRequests[0]?.operations).toHaveLength(6);
  });

  it("maps a partial chord sub-write to its owning public action and suppresses suffix actions", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const artifact = await capture(plane);
    controller.keyboardError = partialError(3, 2);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: artifact.observation.observationId,
          requestId: "keyboard-partial",
          actions: [
            { type: "key_press", key: "KeyA" },
            { type: "chord", keys: ["ControlLeft", "KeyB"] },
            { type: "key_press", key: "KeyC" },
          ],
        },
        deadline,
      ),
    ).rejects.toMatchObject({
      outcome: "unknown",
      dispatchedCount: 2,
      completedCount: 1,
      failedIndex: 1,
      suffixSuppressed: true,
    });
    expect(controller.keyboardRequests[0]?.operations).toHaveLength(8);
  });

  it("expires firmware auto-released non-modifier keys from the local held ledger", async () => {
    const { plane, clock } = setup();
    await plane.connect(ref, deadline);
    const firstObservation = await capture(plane);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: firstObservation.observation.observationId,
          requestId: "keyboard-held-first",
          actions: [{ type: "key_down", key: "KeyA" }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ heldKeys: ["KeyA"] });

    clock.value = 101;
    const secondObservation = await capture(plane);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: secondObservation.observation.observationId,
          requestId: "keyboard-held-after-auto-release",
          actions: [{ type: "key_down", key: "KeyA" }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ heldKeys: ["KeyA"] });
  });
  it("retains modifier keys until an explicit key-up or release", async () => {
    const { plane, clock } = setup();
    await plane.connect(ref, deadline);
    const firstObservation = await capture(plane);
    await plane.keyboard(
      ref,
      {
        observationId: firstObservation.observation.observationId,
        requestId: "keyboard-modifier-down",
        actions: [{ type: "key_down", key: "ControlLeft" }],
      },
      deadline,
    );

    clock.value = 1_000;
    const secondObservation = await capture(plane);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: secondObservation.observation.observationId,
          requestId: "keyboard-modifier-up",
          actions: [{ type: "key_up", key: "ControlLeft" }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ heldKeys: [] });
  });

  it("resolves every canonical physical key to a unique HID usage", () => {
    const usages = PHYSICAL_KEYS.map(resolvePhysicalKeyUsage);
    expect(new Set(usages).size).toBe(PHYSICAL_KEYS.length);
    expect(Math.min(...usages)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...usages)).toBeLessThanOrEqual(255);
  });

  it("expands chords in press order and reverse release order", () => {
    const result = expandKeyboardActions(
      [
        {
          type: "chord",
          keys: ["ControlLeft", "ShiftLeft", "KeyA"],
        },
      ],
      new Set<PhysicalKey>(),
    );
    expect(result.operations).toEqual([
      { key: resolvePhysicalKeyUsage("ControlLeft"), press: true },
      { key: resolvePhysicalKeyUsage("ShiftLeft"), press: true },
      { key: resolvePhysicalKeyUsage("KeyA"), press: true },
      { key: resolvePhysicalKeyUsage("KeyA"), press: false },
      { key: resolvePhysicalKeyUsage("ShiftLeft"), press: false },
      { key: resolvePhysicalKeyUsage("ControlLeft"), press: false },
    ]);
    expect(result.finalHeldKeys).toEqual(new Set());
  });

  it.each<KeyboardAction>([
    { type: "key_up", key: "KeyA" },
    { type: "chord", keys: ["KeyA", "KeyA"] },
  ])(
    "rejects impossible transition %o before reservation or page call",
    async (action) => {
      const { plane, controller } = setup();
      await plane.connect(ref, deadline);
      const artifact = await capture(plane);
      await expect(
        plane.keyboard(
          ref,
          {
            observationId: artifact.observation.observationId,
            requestId: "keyboard-invalid",
            actions: [action],
          },
          deadline,
        ),
      ).rejects.toMatchObject({ code: "INVALID_KEY", outcome: "not_sent" });
      expect(controller.keyboardRequests).toHaveLength(0);
      await expect(
        plane.keyboard(
          ref,
          {
            observationId: artifact.observation.observationId,
            requestId: "keyboard-valid",
            actions: [{ type: "key_press", key: "KeyA" }],
          },
          deadline,
        ),
      ).resolves.toMatchObject({ dispatchedCount: 1, completedCount: 1 });
    },
  );

  it("tracks held keys across captures and rejects duplicate downs before dispatch", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const first = await capture(plane);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: first.observation.observationId,
          requestId: "key-down",
          actions: [{ type: "key_down", key: "ShiftLeft" }],
        },
        deadline,
      ),
    ).resolves.toMatchObject({ dispatchedCount: 1, heldKeys: ["ShiftLeft"] });
    const second = await capture(plane);
    await expect(
      plane.keyboard(
        ref,
        {
          observationId: second.observation.observationId,
          requestId: "key-down-again",
          actions: [{ type: "key_down", key: "ShiftLeft" }],
        },
        deadline,
      ),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
    expect(controller.keyboardRequests).toHaveLength(1);
  });
});

describe("JetKvmBrowserPlane paste and release", () => {
  it("accepts only correlated succeeded paste terminals and retains no text", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const artifact = await capture(plane);
    const secret = "\uFEFFse\r\ncre\u0301t";
    const receipt = await plane.paste(
      ref,
      {
        observationId: artifact.observation.observationId,
        requestId: "paste-1",
        text: secret,
      },
      deadline,
    );
    const normalized = normalize(secret);
    expect(receipt).toMatchObject({
      outcome: "applied",
      terminalState: "succeeded",
      originalByteCount: Buffer.byteLength(secret),
      normalizedByteCount: Buffer.byteLength(normalized),
      normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
      measuredCharsPerSecond: 90.9,
    });
    expect(JSON.stringify(controller.pasteAudit)).not.toContain(secret);
    expect(JSON.stringify(plane)).not.toContain(secret);
  });

  it("propagates failed/cancelled/unknown paste lifecycle as error and consumes the fence", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const artifact = await capture(plane);
    controller.pasteError = new BrowserPlaneError({
      code: "EVENT_GAP",
      outcome: "unknown",
      stage: "acknowledgement",
      writeBegan: true,
      acknowledged: false,
      dispatchedCount: 1,
      completedCount: 0,
      requestedCount: 6,
      failedIndex: 0,
      safeToRetry: false,
      requiredNextStep: "release_then_reconnect_then_capture",
      suffixSuppressed: true,
    });
    await expect(
      plane.paste(
        ref,
        {
          observationId: artifact.observation.observationId,
          requestId: "paste-gap",
          text: "secret",
        },
        deadline,
      ),
    ).rejects.toMatchObject({ code: "EVENT_GAP", outcome: "unknown" });
    expect(JSON.stringify(plane)).not.toContain("secret");
  });

  it("always invokes correlated release, closes the gate, and requires reconnect", async () => {
    const { plane, controller } = setup();
    await plane.connect(ref, deadline);
    const release = await plane.release(
      ref,
      { requestId: "release-1" },
      deadline,
    );
    expect(controller.releaseRequests).toHaveLength(1);
    expect(release).toMatchObject({
      outcome: "applied",
      verification: "device_state_verified",
      mutationGateClosed: true,
      deferredProducersJoined: true,
      pasteTerminal: "inactive",
      ordinaryLeasesZero: true,
      keyboardZero: true,
      pointerZero: true,
      generationDrained: true,
      heldKeys: [],
    });
    await expect(capture(plane)).rejects.toMatchObject({
      code: "SESSION_DRAINED",
    });

    controller.snapshotValue = {
      ...readySnapshot,
      lifecycle_generation: 3,
      channel_generation: 4,
      display_generation: 5,
      dispatch_generation: 7,
    };
    await expect(plane.reconnect(ref, deadline)).resolves.toMatchObject({
      connectionEpoch: 3,
      browserChannelGeneration: 4,
      displayGeneration: 5,
    });
    await expect(capture(plane)).resolves.toBeTruthy();
  });

  it("rejects reconnect without a new bridge channel generation", async () => {
    const { plane } = setup();
    const first = await plane.connect(ref, deadline);
    await expect(plane.reconnect(ref, deadline)).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      outcome: "not_sent",
    });
    expect(plane.deviceRpc.binding).toBe(first.binding);
  });

  it("keeps Node binding lineage monotonic when a replacement facade resets local counters", async () => {
    const { plane, controller } = setup();
    const first = await plane.connect(ref, deadline);
    controller.snapshotValue = {
      ...readySnapshot,
      lifecycle_generation: 1,
      channel_generation: 1,
      display_generation: 1,
      dispatch_generation: 1,
    };
    const replacement = await plane.reconnect(ref, deadline);
    expect(replacement.connectionEpoch).toBe(first.connectionEpoch + 1);
    expect(replacement.browserChannelGeneration).toBe(
      first.browserChannelGeneration + 1,
    );
    await capture(plane);
    expect(controller.captureRequests.at(-1)).toMatchObject({
      expected_lifecycle_generation: 1,
      expected_channel_generation: 1,
    });
  });
});

describe("page-backed shared DeviceRpcAdapter", () => {
  it("maps only the strict prior video event cache and ignores streaming", async () => {
    const { plane, controller } = setup();
    const connection = await plane.connect(ref, deadline);
    const binding = connection.binding;
    await expect(
      plane.deviceRpc.readDisplayState(binding, deadline),
    ).resolves.toEqual({
      signal: {
        value: "unknown",
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      resolution: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      fps: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      qualification: "current_binding",
    } satisfies CachedDisplayState);

    controller.readVideoResult = {
      validation_poll_completed: true,
      cached_event: {
        channel_generation: 3,
        event_sequence: 8,
        observed_at: "2026-07-13T00:00:00.000Z",
        observed_monotonic_ms: 100,
        age_ms: 0,
        state: { ready: true, error: "", width: 1920, height: 1080, fps: 60 },
      },
    };
    await expect(
      plane.deviceRpc.readDisplayState(binding, deadline),
    ).resolves.toEqual({
      signal: {
        value: "present",
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_event",
      },
      resolution: {
        value: { width: 1920, height: 1080, refreshHz: null },
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_event",
      },
      fps: {
        value: 60,
        observedAt: "2026-07-13T00:00:00.000Z",
        ageMs: 0,
        freshness: "fresh",
        source: "cached_event",
      },
      qualification: "current_binding",
    } satisfies CachedDisplayState);

    controller.readVideoResult = {
      ...controller.readVideoResult,
      raw_poll: { streaming: 1 },
    };
    await expect(
      plane.deviceRpc.readDisplayState(binding, deadline),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("uses the same adapter for EDID and rejects ATX without a raw method escape", async () => {
    const { plane, controller } = setup();
    const connection = await plane.connect(ref, deadline);
    expect(connection.deviceRpc).toBe(plane.deviceRpc);
    controller.readEdidResult = null;
    await expect(
      plane.deviceRpc.readEdid(connection.binding, deadline),
    ).resolves.toEqual({
      status: "unavailable",
      readCompleted: true,
      reason: "successful_read_reported_no_edid",
      observedAt: "2026-07-13T00:00:00.000Z",
      data: null,
    } satisfies QualifiedEdidRead);
    controller.readEdidError = new BrowserPlaneError({
      code: "EDID_READ_FAILED",
      outcome: "unknown",
      stage: "acknowledgement",
      writeBegan: true,
      acknowledged: false,
      dispatchedCount: 0,
      completedCount: 0,
      requestedCount: 0,
      safeToRetry: false,
      requiredNextStep: "none",
      suffixSuppressed: false,
    });
    await expect(
      plane.deviceRpc.readEdid(connection.binding, deadline),
    ).rejects.toMatchObject({
      code: "EDID_READ_FAILED",
      boundary: "ack",
      outcome: "unknown",
      writeBegan: true,
      acknowledged: false,
    });
    controller.readEdidError = null;
    const atx = await plane.deviceRpc
      .performAtx(
        connection.binding,
        { requestId: "power-1", action: "press_power" },
        deadline,
      )
      .catch((error: unknown) => error);
    expect(atx).toBeInstanceOf(DeviceRpcError);
    expect(atx).toMatchObject({
      code: "INCOMPATIBLE_DOWNSTREAM",
      outcome: "not_sent",
      writeBegan: false,
    });
  });

  it("fences exact binding before and after page awaits", async () => {
    const { plane, controller } = setup();
    const connection = await plane.connect(ref, deadline);
    const stale: DeviceRpcBinding = {
      ...connection.binding,
      connectionEpoch: 1,
    };
    await expect(
      plane.deviceRpc.readEdid(stale, deadline),
    ).rejects.toMatchObject({
      code: "STALE_BINDING",
      outcome: "not_sent",
    });
    controller.readEdidResult = null;
    let resolveRead!: () => void;
    controller.readEdidGate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const readPromise = plane.deviceRpc.readEdid(connection.binding, deadline);
    controller.snapshotValue = {
      ...readySnapshot,
      lifecycle_generation: 3,
      channel_generation: 4,
    };
    await plane.reconnect(ref, deadline);
    resolveRead();
    await expect(readPromise).rejects.toMatchObject({
      code: "BINDING_REPLACED",
      acknowledged: true,
    });
  });
});
