import { makeBridgeError, type AutomationInvalidationReason, type AutomationOwner } from "./bridge";
import {
  captureFreshFrame,
  FrameCaptureFailure,
  type CaptureCanvas,
  type DecodedVideoSource,
} from "./capture";
import {
  OperationFence,
  validateBridgeRequest,
  validateInputBridgeRequest,
  validateKeyboardRequest,
  validateMouseRequest,
  validatePasteRequest,
} from "./inputGuard";
import type {
  AutomationBridgeError,
  AutomationSnapshot,
  CaptureBridgeRequest,
  CaptureBridgeResult,
  JsonValue,
  KeyboardBridgeReceipt,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  MutationBridgeReceipt,
  PasteBridgeReceipt,
  PasteBridgeRequest,
  ReadBridgeRequest,
  ReadBridgeResult,
  ReleaseBridgeReceipt,
  ReleaseBridgeRequest,
} from "./protocol";
const EXPLICIT_OPERATION_CANCEL = Symbol("explicit-operation-cancel");
const LIFECYCLE_OPERATION_CANCEL = Symbol("lifecycle-operation-cancel");

function isExplicitOperationCancellation(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === EXPLICIT_OPERATION_CANCEL;
}

export type ProductRpcMethod =
  | "absMouseReport"
  | "wheelReport"
  | "keypressReport"
  | "getPasteCapabilities"
  | "quiesceAndZero"
  | "getVideoState"
  | "getEDID";

export interface ProductRpcRequestOptions {
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onWrite: () => void;
}

export type ProductRpcRequest = (
  method: ProductRpcMethod,
  params: JsonValue,
  options: ProductRpcRequestOptions,
) => Promise<JsonValue>;

export interface AutomationPasteResult {
  readonly acceptedAt: string;
  readonly completedAt: string;
  readonly measuredSourceCps: number;
}

export interface AutomationPasteTransport {
  execute(
    normalizedText: string,
    signal: AbortSignal,
    onAccepted: (acceptedAt: string) => void,
    timeoutMs: number,
  ): Promise<AutomationPasteResult>;
  cancelAndJoin(): Promise<void>;
  close(): void;
}

export interface AutomationChannelBinding {
  readonly rpcIdentity: object | null;
  readonly rpcRequest: ProductRpcRequest | null;
  readonly hidIdentity: object | null;
  readonly hidReady: boolean;
}

export interface AutomationDisplayBinding {
  readonly videoIdentity: object | null;
  readonly video: DecodedVideoSource | null;
  readonly videoReady: boolean;
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
  readonly sourceRevision?: number;
}

export interface AutomationControllerOptions {
  readonly nowIso?: () => string;
  readonly monotonicNow?: () => number;
  readonly digestText?: (text: string) => Promise<string>;
  readonly createCanvas?: () => CaptureCanvas;
  readonly digestFrame?: (bytes: Uint8Array) => Promise<string>;
}

interface ParsedReleaseReceipt {
  readonly generation: number;
}
interface CachedVideoState {
  readonly ready: boolean;
  readonly error: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

interface CachedVideoInputEvent {
  readonly channelGeneration: number;
  readonly eventSequence: number;
  readonly observedAt: string;
  readonly observedMonotonicMs: number;
  readonly state: CachedVideoState;
}

let nextMonotonicGeneration = 0;
let nextMonotonicFrame = 0;
let nextMonotonicVideoEvent = 0;

function advanceGeneration(): number {
  nextMonotonicGeneration += 1;
  if (!Number.isSafeInteger(nextMonotonicGeneration)) {
    throw new Error("Automation generation exhausted.");
  }
  return nextMonotonicGeneration;
}

function advanceFrameSequence(): number {
  nextMonotonicFrame += 1;
  if (!Number.isSafeInteger(nextMonotonicFrame)) {
    throw new Error("Automation frame sequence exhausted.");
  }
  return nextMonotonicFrame;
}

function advanceVideoEventSequence(): number {
  nextMonotonicVideoEvent += 1;
  if (!Number.isSafeInteger(nextMonotonicVideoEvent)) {
    throw new Error("Automation video event sequence exhausted.");
  }
  return nextMonotonicVideoEvent;
}

function isBridgeError(value: unknown): value is AutomationBridgeError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "JetKvmAutomationError" &&
    "version" in value &&
    value.version === 1
  );
}
function isQualifiedEdidReadFailure(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "EDID_READ_FAILED"
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVideoInputState(value: unknown): CachedVideoState | null {
  if (!isUnknownRecord(value)) return null;
  const allowedKeys: Record<string, true> = {
    error: true,
    fps: true,
    height: true,
    ready: true,
    streaming: true,
    width: true,
  };
  if (Object.keys(value).some(key => allowedKeys[key] !== true)) return null;
  const ready = value.ready;
  const width = value.width;
  const height = value.height;
  const fps = value.fps;
  const error = value.error ?? "";
  if (
    typeof ready !== "boolean" ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 0 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 0 ||
    typeof fps !== "number" ||
    !Number.isFinite(fps) ||
    fps < 0 ||
    typeof error !== "string"
  ) {
    return null;
  }
  return Object.freeze({ ready, error, width, height, fps });
}

async function defaultDigestText(text: string): Promise<string> {
  const bytes = Uint8Array.from(new TextEncoder().encode(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseReleaseReceipt(value: JsonValue, operationId: string): ParsedReleaseReceipt | null {
  if (!isJsonObject(value)) return null;
  const expectedKeys = [
    "draining",
    "generation",
    "keyboardZero",
    "macroInactive",
    "operationId",
    "ordinaryLeasesZero",
    "outcome",
    "pasteInactive",
    "pointerZero",
    "producersJoined",
  ];
  if (Object.keys(value).sort().join("|") !== expectedKeys.join("|")) return null;
  const generation = value.generation;
  if (
    value.operationId !== operationId ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    value.outcome !== "released" ||
    value.draining !== true ||
    value.producersJoined !== true ||
    value.macroInactive !== true ||
    value.pasteInactive !== true ||
    value.ordinaryLeasesZero !== true ||
    value.keyboardZero !== true ||
    value.pointerZero !== true
  ) {
    return null;
  }
  return { generation };
}

export class AutomationController implements AutomationOwner {
  private lifecycleGeneration = advanceGeneration();
  private channelGeneration = advanceGeneration();
  private displayGeneration = advanceGeneration();
  private dispatchGeneration = advanceGeneration();
  private active = true;
  private unmounted = false;
  private closed = false;
  private rpcIdentity: object | null = null;
  private rpcRequest: ProductRpcRequest | null = null;
  private hidIdentity: object | null = null;
  private hidReady = false;
  private videoIdentity: object | null = null;
  private video: DecodedVideoSource | null = null;
  private videoReady = false;
  private sourceWidth: number | null = null;
  private sourceHeight: number | null = null;
  private sourceRevision = 0;
  private absolutePointer = false;
  private scrollThrottlingDisabled = false;
  private keyboardLayout: string | null = null;
  private pasteTransport: AutomationPasteTransport | null = null;
  private ordinaryTail: Promise<void> = Promise.resolve();
  private readonly ordinaryControllers = new Set<AbortController>();
  private readonly ordinaryTasks = new Set<Promise<unknown>>();
  private readonly operationControllers = new Map<string, AbortController>();
  private cachedVideoInputEvent: CachedVideoInputEvent | null = null;
  private readonly nowIso: () => string;
  private readonly monotonicNow: () => number;
  private readonly digestText: (text: string) => Promise<string>;
  private readonly createCanvas: (() => CaptureCanvas) | undefined;
  private readonly digestFrame: ((bytes: Uint8Array) => Promise<string>) | undefined;

  constructor(options: AutomationControllerOptions = {}) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.digestText = options.digestText ?? defaultDigestText;
    this.createCanvas = options.createCanvas;
    this.digestFrame = options.digestFrame;
  }

  activate(lifecycleGeneration: number): void {
    if (this.active && !this.unmounted) {
      if (
        Number.isSafeInteger(lifecycleGeneration) &&
        lifecycleGeneration > this.lifecycleGeneration
      ) {
        this.lifecycleGeneration = lifecycleGeneration;
      }
      return;
    }
    this.active = true;
    this.unmounted = false;
    this.closed = false;
    this.lifecycleGeneration = advanceGeneration();
    this.channelGeneration = advanceGeneration();
    this.displayGeneration = advanceGeneration();
    this.dispatchGeneration = advanceGeneration();
    this.rpcIdentity = null;
    this.rpcRequest = null;
    this.hidIdentity = null;
    this.hidReady = false;
    this.videoIdentity = null;
    this.video = null;
    this.videoReady = false;
    this.sourceWidth = null;
    this.sourceHeight = null;
    this.sourceRevision = 0;
    this.absolutePointer = false;
    this.scrollThrottlingDisabled = false;
    this.keyboardLayout = null;
    this.pasteTransport = null;
    this.cachedVideoInputEvent = null;
  }

  snapshot(): AutomationSnapshot {
    const ready =
      this.active &&
      !this.closed &&
      this.rpcIdentity !== null &&
      this.rpcRequest !== null &&
      this.hidIdentity !== null &&
      this.hidReady &&
      this.videoReady &&
      this.sourceWidth !== null &&
      this.sourceHeight !== null &&
      this.absolutePointer &&
      this.scrollThrottlingDisabled &&
      this.keyboardLayout !== null;
    const state = this.closed
      ? "closed"
      : this.unmounted || !this.active
        ? "unmounted"
        : ready
          ? "ready"
          : "not_ready";
    return Object.freeze({
      version: 1,
      state,
      lifecycle_generation: this.lifecycleGeneration,
      channel_generation: this.channelGeneration,
      display_generation: this.displayGeneration,
      dispatch_generation: this.dispatchGeneration,
      rpc_ready: this.rpcIdentity !== null && this.rpcRequest !== null,
      hid_ready: this.hidIdentity !== null && this.hidReady,
      video_ready: this.videoReady,
      absolute_pointer: this.absolutePointer,
      scroll_throttling_disabled: this.scrollThrottlingDisabled,
      keyboard_layout: this.keyboardLayout,
      reliable_paste: this.pasteTransport !== null,
      source_width: this.sourceWidth,
      source_height: this.sourceHeight,
    });
  }
  cancel(operationId: string): boolean {
    const controller = this.operationControllers.get(operationId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(EXPLICIT_OPERATION_CANCEL);
    return true;
  }

  replaceChannels(binding: AutomationChannelBinding): void {
    const changed =
      binding.rpcIdentity !== this.rpcIdentity ||
      binding.rpcRequest !== this.rpcRequest ||
      binding.hidIdentity !== this.hidIdentity ||
      binding.hidReady !== this.hidReady;
    if (!changed) return;

    this.abortAllOperations();
    this.pasteTransport?.close();
    this.pasteTransport = null;
    this.keyboardLayout = null;
    this.cachedVideoInputEvent = null;
    this.channelGeneration = advanceGeneration();
    this.rpcIdentity = binding.rpcIdentity;
    this.rpcRequest = binding.rpcRequest;
    this.hidIdentity = binding.hidIdentity;
    this.hidReady = binding.hidReady;
  }

  replaceDisplay(binding: AutomationDisplayBinding): void {
    const changed =
      binding.videoIdentity !== this.videoIdentity ||
      binding.video !== this.video ||
      binding.videoReady !== this.videoReady ||
      binding.sourceWidth !== this.sourceWidth ||
      binding.sourceHeight !== this.sourceHeight ||
      (binding.sourceRevision ?? 0) !== this.sourceRevision;
    if (!changed) return;

    this.abortAllOperations();
    this.displayGeneration = advanceGeneration();
    this.videoIdentity = binding.videoIdentity;
    this.video = binding.video;
    this.videoReady = binding.videoReady;
    this.sourceWidth = binding.sourceWidth;
    this.sourceHeight = binding.sourceHeight;
    this.sourceRevision = binding.sourceRevision ?? 0;
  }

  publishInputCapabilities(
    channelGeneration: number,
    keyboardLayout: string,
    pasteTransport: AutomationPasteTransport | null,
  ): void {
    if (
      channelGeneration !== this.channelGeneration ||
      !this.active ||
      this.closed ||
      typeof keyboardLayout !== "string" ||
      keyboardLayout.length === 0
    ) {
      pasteTransport?.close();
      return;
    }
    this.pasteTransport?.close();
    this.keyboardLayout = keyboardLayout;
    this.pasteTransport = pasteTransport;
  }
  invalidateInputCapabilities(channelGeneration: number): void {
    if (
      channelGeneration !== this.channelGeneration ||
      (this.keyboardLayout === null && this.pasteTransport === null)
    ) {
      return;
    }
    this.abortOrdinary();
    this.dispatchGeneration = advanceGeneration();
    this.pasteTransport?.close();
    this.pasteTransport = null;
    this.keyboardLayout = null;
  }

  setInputMode(absolutePointer: boolean, scrollThrottlingDisabled: boolean): void {
    this.absolutePointer = absolutePointer;
    this.scrollThrottlingDisabled = scrollThrottlingDisabled;
  }

  observeVideoInputState(params: unknown, rpcIdentity: object): boolean {
    if (
      !this.active ||
      this.closed ||
      this.rpcIdentity === null ||
      this.rpcIdentity !== rpcIdentity
    ) {
      return false;
    }
    const state = parseVideoInputState(params);
    if (!state) return false;
    this.cachedVideoInputEvent = Object.freeze({
      channelGeneration: this.channelGeneration,
      eventSequence: advanceVideoEventSequence(),
      observedAt: this.nowIso(),
      observedMonotonicMs: this.monotonicNow(),
      state,
    });
    return true;
  }

  invalidate(_reason: AutomationInvalidationReason): void {
    if (!this.active) return;
    this.active = false;
    this.unmounted = true;
    this.lifecycleGeneration = advanceGeneration();
    this.abortAllOperations();
    this.pasteTransport?.close();
    this.pasteTransport = null;
    this.keyboardLayout = null;
    this.cachedVideoInputEvent = null;
  }

  async capture(request: CaptureBridgeRequest): Promise<CaptureBridgeResult> {
    const admitted = this.requireReady(request.operation_id);
    validateBridgeRequest(request, admitted, 60_000);
    const expectedVideoIdentity = this.videoIdentity;
    const video = this.video;
    if (!video || !expectedVideoIdentity) {
      throw makeBridgeError("NOT_READY", "admission", {
        snapshot: admitted,
        operationId: request.operation_id,
      });
    }
    const operationController = this.beginOperation(request.operation_id);
    const fence = new OperationFence(
      request,
      () => this.snapshot(),
      () => this.active,
      this.monotonicNow(),
    );
    try {
      const captured = await captureFreshFrame(video, request, advanceFrameSequence(), {
        createCanvas: this.createCanvas,
        digest: this.digestFrame,
        monotonicNow: this.monotonicNow,
        nowIso: this.nowIso,
        signal: operationController.signal,
        verify: () => {
          fence.verify("verification", this.monotonicNow());
          if (this.videoIdentity !== expectedVideoIdentity || this.video !== video) {
            throw makeBridgeError("DISPLAY_CHANGED", "verification", {
              snapshot: this.snapshot(),
              operationId: request.operation_id,
            });
          }
        },
      });
      return Object.freeze({
        operation_id: request.operation_id,
        lifecycle_generation: admitted.lifecycle_generation,
        channel_generation: admitted.channel_generation,
        display_generation: admitted.display_generation,
        ...captured,
      });
    } catch (error) {
      if (isBridgeError(error)) throw error;
      if (error instanceof FrameCaptureFailure) {
        if (
          error.code === "CANCELLED" &&
          !isExplicitOperationCancellation(operationController.signal)
        ) {
          fence.verify("verification", this.monotonicNow());
        }
        throw makeBridgeError(error.code, "verification", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
        });
      }
      throw makeBridgeError("CAPTURE_FAILED", "verification", {
        snapshot: this.snapshot(),
        operationId: request.operation_id,
      });
    } finally {
      this.finishOperation(request.operation_id, operationController);
    }
  }

  mouse(request: MouseBridgeRequest): Promise<MutationBridgeReceipt> {
    const startedAtMs = this.monotonicNow();
    const admitted = this.requireReady(request.operation_id);
    validateMouseRequest(request, admitted);
    return this.enqueueOrdinary(
      request,
      async (signal, fence, queuedAt) => {
        for (const operation of request.operations) {
          if (operation.kind === "absolute") {
            await this.writeVoidRpc(
              "absMouseReport",
              { x: operation.x, y: operation.y, buttons: operation.buttons },
              request,
              signal,
              fence,
            );
          } else {
            await this.writeVoidRpc(
              "wheelReport",
              { wheelY: operation.delta_y },
              request,
              signal,
              fence,
            );
          }
        }
        fence.markAcknowledged();
        return this.mutationReceipt(request, queuedAt, request.operations.length);
      },
      startedAtMs,
    );
  }

  keyboard(request: KeyboardBridgeRequest): Promise<KeyboardBridgeReceipt> {
    const startedAtMs = this.monotonicNow();
    const admitted = this.requireReady(request.operation_id);
    validateKeyboardRequest(request, admitted);
    return this.enqueueOrdinary(
      request,
      async (signal, fence, queuedAt) => {
        for (const operation of request.operations) {
          await this.writeVoidRpc(
            "keypressReport",
            { key: operation.key, press: operation.press },
            request,
            signal,
            fence,
          );
        }
        fence.markAcknowledged();
        return this.mutationReceipt(request, queuedAt, request.operations.length);
      },
      startedAtMs,
    );
  }

  async paste(request: PasteBridgeRequest): Promise<PasteBridgeReceipt> {
    const startedAtMs = this.monotonicNow();
    const admitted = this.requireReady(request.operation_id);
    const normalized = validatePasteRequest(request, admitted);
    const pasteTransport = this.pasteTransport;
    if (!pasteTransport) {
      throw makeBridgeError("PASTE_UNSUPPORTED", "admission", {
        snapshot: admitted,
        operationId: request.operation_id,
      });
    }
    const operationController = this.beginOperation(request.operation_id);
    const originalByteCount = new TextEncoder().encode(request.text).byteLength;
    const normalizedByteCount = new TextEncoder().encode(normalized).byteLength;
    let normalizedSha256: string;
    try {
      normalizedSha256 = await this.digestText(normalized);
      if (!/^[0-9a-f]{64}$/.test(normalizedSha256)) {
        throw makeBridgeError("DOWNSTREAM_ERROR", "verification", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
        });
      }
    } catch (error) {
      this.finishOperation(request.operation_id, operationController);
      throw error;
    }

    return this.enqueueOrdinary(
      request,
      async (signal, fence) => {
        let writeBegan = false;
        let acceptedAt = "";
        try {
          fence.verify("queue", this.monotonicNow());
          const remainingMs = fence.remainingMs(this.monotonicNow());
          if (remainingMs < 100) {
            throw makeBridgeError("DEADLINE_EXCEEDED", "queue", {
              snapshot: this.snapshot(),
              operationId: request.operation_id,
            });
          }
          const terminal = await pasteTransport.execute(
            normalized,
            signal,
            accepted => {
              if (writeBegan) return;
              writeBegan = true;
              acceptedAt = accepted;
              fence.markWriteBegan();
              fence.markDispatched();
            },
            remainingMs,
          );
          fence.verify("acknowledgement", this.monotonicNow());
          if (
            !writeBegan ||
            terminal.acceptedAt !== acceptedAt ||
            !Number.isFinite(terminal.measuredSourceCps) ||
            terminal.measuredSourceCps <= 0
          ) {
            throw makeBridgeError("PASTE_LIFECYCLE", "acknowledgement", {
              snapshot: this.snapshot(),
              operationId: request.operation_id,
              writeBegan,
              dispatchedCount: writeBegan ? 1 : 0,
            });
          }
          fence.markCompleted();
          fence.markAcknowledged();
          return Object.freeze({
            operation_id: request.operation_id,
            lifecycle_generation: request.expected_lifecycle_generation,
            channel_generation: request.expected_channel_generation,
            display_generation: request.expected_display_generation,
            dispatch_generation: request.expected_dispatch_generation,
            original_byte_count: originalByteCount,
            normalized_byte_count: normalizedByteCount,
            normalized_sha256: normalizedSha256,
            accepted_at: terminal.acceptedAt,
            completed_at: terminal.completedAt,
            terminal_state: "succeeded",
            measured_source_cps: terminal.measuredSourceCps,
          });
        } catch (error) {
          if (isBridgeError(error)) throw error;
          if (isExplicitOperationCancellation(signal)) {
            const outcome = fence.outcome();
            throw makeBridgeError("CANCELLED", outcome.writeBegan ? "acknowledgement" : "queue", {
              snapshot: this.snapshot(),
              operationId: request.operation_id,
              writeBegan: outcome.writeBegan,
              acknowledged: outcome.acknowledged,
              dispatchedCount: outcome.dispatchedCount,
              completedCount: outcome.completedCount,
            });
          }
          fence.verify("acknowledgement", this.monotonicNow());
          throw makeBridgeError("PASTE_LIFECYCLE", "acknowledgement", {
            snapshot: this.snapshot(),
            operationId: request.operation_id,
            writeBegan,
            dispatchedCount: writeBegan ? 1 : 0,
          });
        }
      },
      startedAtMs,
      operationController,
    );
  }

  async release(request: ReleaseBridgeRequest): Promise<ReleaseBridgeReceipt> {
    const admitted = this.requireReady(request.operation_id);
    validateInputBridgeRequest(request, admitted, 60_000);
    const startedAt = this.monotonicNow();
    const rpcIdentity = this.rpcIdentity;
    const rpcRequest = this.rpcRequest;
    const pasteTransport = this.pasteTransport;
    if (!rpcIdentity || !rpcRequest) {
      throw makeBridgeError("NOT_READY", "admission", {
        snapshot: admitted,
        operationId: request.operation_id,
      });
    }

    const operationController = this.beginOperation(request.operation_id);
    try {
      this.closed = true;
      this.dispatchGeneration = advanceGeneration();
      this.abortOrdinary();
      let localJoined = true;
      try {
        await pasteTransport?.cancelAndJoin();
      } catch {
        localJoined = false;
      }
      await Promise.allSettled([...this.ordinaryTasks]);
      if (isExplicitOperationCancellation(operationController.signal)) {
        throw makeBridgeError("CANCELLED", "queue", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
        });
      }

      let writeBegan = false;
      if (
        !this.active ||
        this.rpcIdentity !== rpcIdentity ||
        this.rpcRequest !== rpcRequest ||
        this.lifecycleGeneration !== admitted.lifecycle_generation ||
        this.channelGeneration !== admitted.channel_generation ||
        this.displayGeneration !== admitted.display_generation
      ) {
        throw makeBridgeError("CHANNEL_LOST", "queue", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
        });
      }
      const remaining = request.timeout_ms - (this.monotonicNow() - startedAt);
      if (remaining <= 0) {
        throw makeBridgeError("DEADLINE_EXCEEDED", "queue", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
        });
      }

      try {
        const result = await rpcRequest(
          "quiesceAndZero",
          { operationId: request.operation_id },
          {
            operationId: request.operation_id,
            timeoutMs: remaining,
            signal: operationController.signal,
            onWrite: () => {
              writeBegan = true;
            },
          },
        );
        if (
          !this.active ||
          this.rpcIdentity !== rpcIdentity ||
          this.rpcRequest !== rpcRequest ||
          this.lifecycleGeneration !== admitted.lifecycle_generation ||
          this.channelGeneration !== admitted.channel_generation ||
          this.displayGeneration !== admitted.display_generation
        ) {
          throw makeBridgeError("CHANNEL_LOST", "acknowledgement", {
            snapshot: this.snapshot(),
            operationId: request.operation_id,
            writeBegan,
          });
        }
        const parsed = parseReleaseReceipt(result, request.operation_id);
        if (!writeBegan || !localJoined || !parsed) {
          throw makeBridgeError("RELEASE_FAILED", "acknowledgement", {
            snapshot: this.snapshot(),
            operationId: request.operation_id,
            writeBegan,
          });
        }
        return Object.freeze({
          operation_id: request.operation_id,
          lifecycle_generation: admitted.lifecycle_generation,
          channel_generation: admitted.channel_generation,
          display_generation: admitted.display_generation,
          dispatch_generation: this.dispatchGeneration,
          device_generation: parsed.generation,
          outcome: "released",
          draining: true,
          producers_joined: true,
          macro_inactive: true,
          paste_inactive: true,
          ordinary_leases_zero: true,
          keyboard_zero: true,
          pointer_zero: true,
          released_at: this.nowIso(),
        });
      } catch (error) {
        if (isBridgeError(error)) throw error;
        if (isExplicitOperationCancellation(operationController.signal)) {
          throw makeBridgeError("CANCELLED", writeBegan ? "acknowledgement" : "queue", {
            snapshot: this.snapshot(),
            operationId: request.operation_id,
            writeBegan,
          });
        }
        throw makeBridgeError("RELEASE_FAILED", "acknowledgement", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan,
        });
      }
    } finally {
      this.finishOperation(request.operation_id, operationController);
    }
  }

  async readVideoState(request: ReadBridgeRequest): Promise<ReadBridgeResult> {
    const acknowledgement = await this.readRpc("getVideoState", request);
    const cached = this.cachedVideoInputEvent;
    const cachedEvent =
      cached && cached.channelGeneration === acknowledgement.channel_generation
        ? {
            channel_generation: cached.channelGeneration,
            event_sequence: cached.eventSequence,
            observed_at: cached.observedAt,
            observed_monotonic_ms: cached.observedMonotonicMs,
            age_ms: Math.max(0, Math.floor(this.monotonicNow() - cached.observedMonotonicMs)),
            state: {
              ready: cached.state.ready,
              error: cached.state.error,
              width: cached.state.width,
              height: cached.state.height,
              fps: cached.state.fps,
            },
          }
        : null;
    return Object.freeze({
      ...acknowledgement,
      result: {
        validation_poll_completed: true,
        cached_event: cachedEvent,
      },
    });
  }

  readEdid(request: ReadBridgeRequest): Promise<ReadBridgeResult> {
    return this.readRpc("getEDID", request);
  }

  private requireReady(operationId: string | null): AutomationSnapshot {
    const snapshot = this.snapshot();
    if (snapshot.state !== "ready") {
      const code =
        snapshot.state === "closed"
          ? "CLOSED"
          : snapshot.state === "unmounted"
            ? "UNMOUNTED"
            : "NOT_READY";
      throw makeBridgeError(code, "admission", { snapshot, operationId });
    }
    return snapshot;
  }

  private beginOperation(operationId: string): AbortController {
    if (this.operationControllers.has(operationId)) {
      throw makeBridgeError("INVALID_REQUEST", "admission", {
        snapshot: this.snapshot(),
        operationId,
      });
    }
    const controller = new AbortController();
    this.operationControllers.set(operationId, controller);
    return controller;
  }

  private finishOperation(operationId: string, controller: AbortController): void {
    if (this.operationControllers.get(operationId) === controller) {
      this.operationControllers.delete(operationId);
    }
  }

  private abortAllOperations(): void {
    for (const controller of this.operationControllers.values()) {
      controller.abort(LIFECYCLE_OPERATION_CANCEL);
    }
  }

  private abortOrdinary(): void {
    for (const controller of this.ordinaryControllers) {
      controller.abort(LIFECYCLE_OPERATION_CANCEL);
    }
  }

  private enqueueOrdinary<Result>(
    request: MouseBridgeRequest | KeyboardBridgeRequest | PasteBridgeRequest,
    work: (signal: AbortSignal, fence: OperationFence, queuedAt: string) => Promise<Result>,
    startedAtMs: number,
    operationController?: AbortController,
  ): Promise<Result> {
    const abortController = operationController ?? this.beginOperation(request.operation_id);
    if (this.operationControllers.get(request.operation_id) !== abortController) {
      throw new Error("Ordinary operation controller is not registered.");
    }
    this.ordinaryControllers.add(abortController);
    const previous = this.ordinaryTail;
    const result = Promise.withResolvers<Result>();
    const tracked = previous
      .then(async () => {
        const fence = new OperationFence(
          request,
          () => this.snapshot(),
          () => this.active,
          startedAtMs,
        );
        fence.verify("queue", this.monotonicNow());
        if (abortController.signal.aborted) {
          if (isExplicitOperationCancellation(abortController.signal)) {
            throw makeBridgeError("CANCELLED", "queue", {
              snapshot: this.snapshot(),
              operationId: request.operation_id,
            });
          }
          fence.verify("queue", this.monotonicNow());
        }
        return work(abortController.signal, fence, this.nowIso());
      })
      .then(result.resolve, result.reject)
      .finally(() => {
        this.ordinaryControllers.delete(abortController);
        this.finishOperation(request.operation_id, abortController);
        this.ordinaryTasks.delete(result.promise);
      });
    this.ordinaryTasks.add(result.promise);
    this.ordinaryTail = tracked.then(
      () => undefined,
      () => undefined,
    );
    return result.promise;
  }

  private async writeVoidRpc(
    method: "absMouseReport" | "wheelReport" | "keypressReport",
    params: JsonValue,
    request: MouseBridgeRequest | KeyboardBridgeRequest,
    signal: AbortSignal,
    fence: OperationFence,
  ): Promise<void> {
    const rpcRequest = this.rpcRequest;
    const rpcIdentity = this.rpcIdentity;
    if (!rpcRequest || !rpcIdentity) fence.verify("queue", this.monotonicNow());
    let writeBegan = false;
    try {
      fence.verify("write", this.monotonicNow());
      const remainingMs = fence.remainingMs(this.monotonicNow());
      if (remainingMs <= 0) fence.verify("write", this.monotonicNow());
      const result = await rpcRequest!(method, params, {
        operationId: request.operation_id,
        timeoutMs: remainingMs,
        signal,
        onWrite: () => {
          if (writeBegan) return;
          writeBegan = true;
          fence.markWriteBegan();
          fence.markDispatched();
        },
      });
      fence.verify("acknowledgement", this.monotonicNow());
      if (this.rpcIdentity !== rpcIdentity || result !== null) {
        const outcome = fence.outcome();
        throw makeBridgeError("MALFORMED_ACKNOWLEDGEMENT", "acknowledgement", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan: outcome.writeBegan,
          acknowledged: outcome.acknowledged,
          dispatchedCount: outcome.dispatchedCount,
          completedCount: outcome.completedCount,
        });
      }
      fence.markCompleted();
    } catch (error) {
      if (isBridgeError(error)) throw error;
      if (isExplicitOperationCancellation(signal)) {
        const outcome = fence.outcome();
        throw makeBridgeError("CANCELLED", outcome.writeBegan ? "acknowledgement" : "queue", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan: outcome.writeBegan,
          acknowledged: outcome.acknowledged,
          dispatchedCount: outcome.dispatchedCount,
          completedCount: outcome.completedCount,
        });
      }
      fence.verify("acknowledgement", this.monotonicNow());
      const outcome = fence.outcome();
      throw makeBridgeError("DOWNSTREAM_ERROR", "acknowledgement", {
        snapshot: this.snapshot(),
        operationId: request.operation_id,
        writeBegan: outcome.writeBegan,
        acknowledged: outcome.acknowledged,
        dispatchedCount: outcome.dispatchedCount,
        completedCount: outcome.completedCount,
      });
    }
  }

  private mutationReceipt(
    request: MouseBridgeRequest | KeyboardBridgeRequest,
    queuedAt: string,
    count: number,
  ): MutationBridgeReceipt {
    return Object.freeze({
      operation_id: request.operation_id,
      lifecycle_generation: request.expected_lifecycle_generation,
      channel_generation: request.expected_channel_generation,
      display_generation: request.expected_display_generation,
      dispatch_generation: request.expected_dispatch_generation,
      queued_at: queuedAt,
      acknowledged_at: this.nowIso(),
      dispatched_count: count,
      completed_count: count,
    });
  }

  private async readRpc(
    method: "getVideoState" | "getEDID",
    request: ReadBridgeRequest,
  ): Promise<ReadBridgeResult> {
    const admitted = this.requireReady(request.operation_id);
    validateBridgeRequest(request, admitted, 30_000);
    const rpcRequest = this.rpcRequest;
    const rpcIdentity = this.rpcIdentity;
    if (!rpcRequest || !rpcIdentity) {
      throw makeBridgeError("NOT_READY", "admission", {
        snapshot: admitted,
        operationId: request.operation_id,
      });
    }
    const operationController = this.beginOperation(request.operation_id);
    const fence = new OperationFence(
      request,
      () => this.snapshot(),
      () => this.active,
      this.monotonicNow(),
    );
    let writeBegan = false;
    try {
      const result = await rpcRequest(
        method,
        {},
        {
          operationId: request.operation_id,
          timeoutMs: request.timeout_ms,
          signal: operationController.signal,
          onWrite: () => {
            writeBegan = true;
            fence.markWriteBegan();
            fence.markDispatched();
          },
        },
      );
      fence.verify("acknowledgement", this.monotonicNow());
      if (!writeBegan || this.rpcIdentity !== rpcIdentity || !isJsonValue(result)) {
        throw makeBridgeError("MALFORMED_ACKNOWLEDGEMENT", "acknowledgement", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan,
        });
      }
      fence.markCompleted();
      fence.markAcknowledged();
      return Object.freeze({
        operation_id: request.operation_id,
        lifecycle_generation: admitted.lifecycle_generation,
        channel_generation: admitted.channel_generation,
        acknowledged_at: this.nowIso(),
        result,
      });
    } catch (error) {
      if (isBridgeError(error)) throw error;
      if (isExplicitOperationCancellation(operationController.signal)) {
        throw makeBridgeError("CANCELLED", writeBegan ? "acknowledgement" : "queue", {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan,
        });
      }
      fence.verify("acknowledgement", this.monotonicNow());
      throw makeBridgeError(
        method === "getEDID" && isQualifiedEdidReadFailure(error)
          ? "EDID_READ_FAILED"
          : "DOWNSTREAM_ERROR",
        "acknowledgement",
        {
          snapshot: this.snapshot(),
          operationId: request.operation_id,
          writeBegan,
        },
      );
    } finally {
      this.finishOperation(request.operation_id, operationController);
    }
  }
}
