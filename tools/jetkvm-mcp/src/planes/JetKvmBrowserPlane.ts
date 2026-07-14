import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  PHYSICAL_KEYS,
  type KeyboardAction,
  type PhysicalKey,
} from "../domain.js";
import {
  DeviceRpcError,
  isCanonicalOpaqueId,
  parseAtxWireReceipt,
  validateDeviceRpcBindingReplacement,
  type AtxWireReceipt,
  type CachedDisplayState,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcErrorCode,
  type DeviceRpcBinding,
  type NativeResolution,
  type NativeSignal,
  type QualifiedEdidRead,
  type QualifiedFact,
  type SessionRef,
} from "../device/DeviceRpcAdapter.js";
import type { BrowserControllerPort } from "../browser/BrowserController.js";
import {
  BrowserPlaneError,
  type AutomationSnapshot,
  type BrowserPlaneErrorInit,
  type KeyboardBridgeOperation,
  type PasteBridgeReceipt,
  type ReadBridgeResult,
} from "../browser/bridgeProtocol.js";
import {
  expandMouseActions,
  type ExpandedMouseActions,
} from "../browser/geometry.js";
import { materializeCaptureFrame } from "../browser/frames.js";
import {
  MAX_OBSERVATION_AGE_MS,
  assertBrowserCaptureArtifact,
  type BrowserCaptureArtifact,
  type BrowserConnection,
  type BrowserPlane,
  type CaptureRequest,
  type KeyboardRequest,
  type MonotonicClock,
  type MouseRequest,
  type MutationReceipt,
  type Observation,
  type PasteReceipt,
  type PasteRequest,
  type ReleaseReceipt,
  type ReleaseRequest,
} from "./BrowserPlane.js";

const KEY_USAGE = Object.freeze({
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  ContextMenu: 0x65,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
} satisfies Readonly<Record<PhysicalKey, number>>);
const PHYSICAL_KEY_BY_USAGE = Object.freeze(
  Object.fromEntries(
    PHYSICAL_KEYS.map((key) => [KEY_USAGE[key], key]),
  ) as Record<number, PhysicalKey>,
);

export function resolvePhysicalKeyUsage(key: PhysicalKey): number {
  const usage = (KEY_USAGE as Readonly<Record<string, number>>)[key];
  if (usage === undefined) {
    throw new RangeError("The physical key is not in the canonical catalogue.");
  }
  return usage;
}
const FIRMWARE_NON_MODIFIER_AUTO_RELEASE_MS = 100;

function isModifierPhysicalKey(key: PhysicalKey): boolean {
  return resolvePhysicalKeyUsage(key) >= 0xe0;
}

export interface ExpandedKeyboardActions {
  readonly operations: readonly KeyboardBridgeOperation[];
  readonly actionOperationEnds: readonly number[];
  readonly finalHeldKeys: ReadonlySet<PhysicalKey>;
}

export interface KeyboardMutationReceipt extends MutationReceipt {
  readonly heldKeys: readonly PhysicalKey[];
}

function invalidKeyTransition(): BrowserPlaneError {
  return new BrowserPlaneError({
    code: "INVALID_KEY",
    outcome: "not_sent",
    stage: "admission",
    writeBegan: false,
    acknowledged: false,
    dispatchedCount: 0,
    completedCount: 0,
    requestedCount: 0,
    safeToRetry: false,
    requiredNextStep: "none",
    suffixSuppressed: false,
  });
}

export function expandKeyboardActions(
  actions: readonly KeyboardAction[],
  initialHeldKeys: ReadonlySet<PhysicalKey>,
): ExpandedKeyboardActions {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 64) {
    throw invalidKeyTransition();
  }
  const held = new Set(initialHeldKeys);
  const operations: KeyboardBridgeOperation[] = [];
  const actionOperationEnds: number[] = [];
  const push = (key: PhysicalKey, press: boolean): void => {
    operations.push({ key: resolvePhysicalKeyUsage(key), press });
    if (press) held.add(key);
    else held.delete(key);
  };
  for (const action of actions) {
    switch (action.type) {
      case "key_down":
        if (held.has(action.key)) throw invalidKeyTransition();
        push(action.key, true);
        break;
      case "key_up":
        if (!held.has(action.key)) throw invalidKeyTransition();
        push(action.key, false);
        break;
      case "key_press":
        if (held.has(action.key)) throw invalidKeyTransition();
        push(action.key, true);
        push(action.key, false);
        break;
      case "chord": {
        if (
          !Array.isArray(action.keys) ||
          action.keys.length < 1 ||
          action.keys.length > 8 ||
          new Set(action.keys).size !== action.keys.length ||
          action.keys.some((key: PhysicalKey) => held.has(key))
        ) {
          throw invalidKeyTransition();
        }
        for (const key of action.keys) push(key, true);
        for (let index = action.keys.length - 1; index >= 0; index -= 1) {
          const key = action.keys[index];
          if (key === undefined) throw invalidKeyTransition();
          push(key, false);
        }
        break;
      }
      default:
        throw invalidKeyTransition();
    }
    actionOperationEnds.push(operations.length);
  }
  return { operations, actionOperationEnds, finalHeldKeys: held };
}

interface PlaneState {
  readonly ref: SessionRef;
  readonly binding: DeviceRpcBinding;
  readonly controllerIdentity: object;
  snapshot: AutomationSnapshot;
  lastFrameSequence: number;
}
interface ObservationRecord {
  readonly observation: Observation;
  readonly createdAtMs: number;
  state: "available" | "reserved" | "consumed";
}

export interface JetKvmBrowserPlaneOptions {
  readonly clock?: MonotonicClock;
  readonly maxObservationAgeMs?: number;
  readonly idFactory?: (prefix: string) => string;
}

const defaultClock: MonotonicClock = { now: () => performance.now() };

const cachedVideoResultSchema = z
  .object({
    validation_poll_completed: z.literal(true),
    cached_event: z
      .object({
        channel_generation: z
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER),
        event_sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        observed_at: z.string().datetime({ offset: true }),
        observed_monotonic_ms: z.number().nonnegative().finite(),
        age_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        state: z
          .object({
            ready: z.boolean(),
            error: z.string().max(256),
            width: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            fps: z.number().nonnegative().finite(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const edidWireResultSchema = z.string().max(65_536).nullable();
const EDID_BLOCK_BYTES = 128;
const EDID_EXTENSION_COUNT_OFFSET = 126;

function browserFailure(init: BrowserPlaneErrorInit): BrowserPlaneError {
  return new BrowserPlaneError(init);
}

function admissionFailure(
  code:
    | "CONNECTION_LOST"
    | "SESSION_DRAINED"
    | "STALE_SESSION_GENERATION"
    | "DISPLAY_CHANGED"
    | "STALE_OBSERVATION"
    | "OBSERVATION_CONSUMED"
    | "INVALID_COORDINATE",
  requiredNextStep: "none" | "capture_then_retry" | "reconnect_then_capture",
  safeToRetry = code === "CONNECTION_LOST" ||
    code === "DISPLAY_CHANGED" ||
    code === "STALE_OBSERVATION" ||
    code === "OBSERVATION_CONSUMED",
): BrowserPlaneError {
  return browserFailure({
    code,
    outcome: "not_sent",
    stage: "admission",
    writeBegan: false,
    acknowledged: false,
    dispatchedCount: 0,
    completedCount: 0,
    requestedCount: 0,
    safeToRetry,
    requiredNextStep,
    suffixSuppressed: false,
  });
}

function normalizePasteText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
}

function bindingsEqual(
  left: DeviceRpcBinding,
  right: DeviceRpcBinding,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionGeneration === right.sessionGeneration &&
    left.connectionEpoch === right.connectionEpoch &&
    left.browserChannelGeneration === right.browserChannelGeneration
  );
}
const ATX_DEVICE_ERROR_CODES = new Set<DeviceRpcErrorCode>([
  "ATX_EXTENSION_INACTIVE",
  "ATX_SERIAL_UNAVAILABLE",
  "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
  "STALE_SESSION_GENERATION",
  "MUTATION_OUTCOME_UNKNOWN",
  "CONFIG_INVALID",
  "DOWNSTREAM_MALFORMED_RESPONSE",
]);

function remapOperationError(
  error: BrowserPlaneError,
  actionOperationEnds: readonly number[],
): BrowserPlaneError {
  const completedCount = actionOperationEnds.filter(
    (end) => end <= error.completedCount,
  ).length;
  const priorEnd =
    completedCount === 0 ? 0 : (actionOperationEnds[completedCount - 1] ?? 0);
  const unknownOwningAction =
    error.outcome === "unknown" &&
    error.writeBegan &&
    !error.acknowledged &&
    completedCount < actionOperationEnds.length;
  const dispatchedCount =
    unknownOwningAction || error.dispatchedCount > priorEnd
      ? Math.min(actionOperationEnds.length, completedCount + 1)
      : completedCount;
  const failedIndex =
    !error.acknowledged &&
    error.writeBegan &&
    dispatchedCount === completedCount + 1
      ? completedCount
      : undefined;
  return new BrowserPlaneError({
    code: error.code,
    outcome: error.outcome,
    stage: error.stage,
    writeBegan: error.writeBegan,
    acknowledged: error.acknowledged,
    dispatchedCount,
    completedCount,
    requestedCount: actionOperationEnds.length,
    ...(failedIndex === undefined ? {} : { failedIndex }),
    safeToRetry: error.safeToRetry,
    requiredNextStep: error.requiredNextStep,
    suffixSuppressed: error.suffixSuppressed,
  });
}

function unknownDisplayState(): CachedDisplayState {
  return {
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
  };
}

export class JetKvmBrowserPlane implements BrowserPlane {
  public readonly deviceRpc: DeviceRpcAdapter;
  private readonly clock: MonotonicClock;
  private readonly maxObservationAgeMs: number;
  private readonly idFactory: (prefix: string) => string;
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly heldKeys = new Set<PhysicalKey>();
  private readonly heldKeyAutoReleaseAtMs = new Map<PhysicalKey, number>();
  private current: PlaneState | null = null;
  private previous: PlaneState | null = null;
  private gateClosed = false;
  private releaseAttempted = false;
  private pasteActive = false;
  private keyboardTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly controller: BrowserControllerPort,
    options: JetKvmBrowserPlaneOptions = {},
  ) {
    this.clock = options.clock ?? defaultClock;
    this.maxObservationAgeMs =
      options.maxObservationAgeMs ?? MAX_OBSERVATION_AGE_MS;
    if (
      !Number.isSafeInteger(this.maxObservationAgeMs) ||
      this.maxObservationAgeMs < 1 ||
      this.maxObservationAgeMs > MAX_OBSERVATION_AGE_MS
    ) {
      throw new RangeError("Maximum observation age is invalid.");
    }
    this.idFactory =
      options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`);
    const plane = this;
    this.deviceRpc = Object.freeze({
      get binding(): DeviceRpcBinding {
        return plane.requireCurrent().binding;
      },
      readDisplayState: (
        binding: DeviceRpcBinding,
        deadline: Deadline,
      ): Promise<CachedDisplayState> =>
        plane.readDisplayState(binding, deadline),
      readEdid: (
        binding: DeviceRpcBinding,
        deadline: Deadline,
      ): Promise<QualifiedEdidRead> => plane.readEdid(binding, deadline),
      performAtx: (
        binding: DeviceRpcBinding,
        request: {
          readonly requestId: string;
          readonly action: "press_power" | "hold_power" | "press_reset";
        },
        deadline: Deadline,
      ): Promise<AtxWireReceipt> =>
        plane.performAtx(binding, request, deadline),
    });
  }

  public async connect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    if (this.current !== null) {
      if (
        this.current.ref.sessionId === ref.sessionId &&
        this.current.ref.sessionGeneration === ref.sessionGeneration
      ) {
        return this.connection(this.current);
      }
      throw admissionFailure(
        "STALE_SESSION_GENERATION",
        "reconnect_then_capture",
      );
    }
    return this.publishConnection(ref, deadline, false);
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    return this.publishConnection(ref, deadline, true);
  }

  public async observeSession(ref: SessionRef, deadline: Deadline) {
    const state = await this.preflight(ref, deadline, true, true);
    const snapshot = state.snapshot;
    return {
      deviceReachable: true,
      setupState: "complete" as const,
      authMode: "unknown" as const,
      lifecycleState: "ready" as const,
      webRtc: snapshot.rpc_ready ? ("connected" as const) : ("unknown" as const),
      hid: snapshot.hid_ready ? ("ready" as const) : ("not_ready" as const),
      decodedVideo:
        snapshot.video_ready &&
        snapshot.source_width !== null &&
        snapshot.source_height !== null
          ? ("ready" as const)
          : ("unavailable" as const),
      dispatchGeneration: snapshot.dispatch_generation,
      activeMutation: this.pasteActive,
      blockedReason: this.gateClosed ? "session_drained" : null,
      uiContractVersion: String(snapshot.version),
      firmwareVersion: null,
    };
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<BrowserCaptureArtifact> {
    const state = await this.preflight(ref, deadline, true);
    const operationId = this.nextId("capture");
    const bridgeRequest = {
      operation_id: operationId,
      expected_lifecycle_generation: state.snapshot.lifecycle_generation,
      expected_channel_generation: state.snapshot.channel_generation,
      timeout_ms: deadline.timeoutMs,
      format: request.format,
      max_width: request.maxWidth,
      max_height: request.maxHeight,
    } as const;
    let frame;
    let frameSequence = 0;
    try {
      const result = await this.controller.capture(bridgeRequest, deadline);
      frameSequence = result.frame_sequence;
      frame = materializeCaptureFrame(result, bridgeRequest);
    } catch (error) {
      if (error instanceof BrowserPlaneError) throw error;
      throw browserFailure({
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        outcome: "not_sent",
        stage: "verification",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: false,
        requiredNextStep: "capture_then_retry",
        suffixSuppressed: false,
      });
    }
    if (
      frame.metadata.displayGeneration !== state.snapshot.display_generation ||
      frame.metadata.sourceWidth !== state.snapshot.source_width ||
      frame.metadata.sourceHeight !== state.snapshot.source_height
    ) {
      this.observations.clear();
      throw admissionFailure("DISPLAY_CHANGED", "capture_then_retry", true);
    }
    if (frameSequence <= state.lastFrameSequence) {
      throw browserFailure({
        code: "VIDEO_STALLED",
        outcome: "not_sent",
        stage: "verification",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "capture_then_retry",
        suffixSuppressed: false,
      });
    }
    state.lastFrameSequence = frameSequence;
    const observationId = this.nextId("observation");
    const observation: Observation = Object.freeze({
      observationId,
      sessionId: ref.sessionId,
      sessionGeneration: ref.sessionGeneration,
      connectionEpoch: state.binding.connectionEpoch,
      displayGeneration: frame.metadata.displayGeneration,
      frameId: frame.metadata.frameId,
      capturedAt: frame.metadata.capturedAt,
      monotonicAgeMs: 0,
      sourceWidth: frame.metadata.sourceWidth,
      sourceHeight: frame.metadata.sourceHeight,
      imageWidth: frame.metadata.imageWidth,
      imageHeight: frame.metadata.imageHeight,
      rotation: frame.metadata.rotation,
      geometry: frame.metadata.geometry,
      format: frame.metadata.format,
      sha256: frame.metadata.sha256,
      byteLength: frame.metadata.byteLength,
    });
    const artifact: BrowserCaptureArtifact = {
      observation,
      image: frame.image,
    };
    assertBrowserCaptureArtifact(artifact);
    this.observations.set(observationId, {
      observation,
      createdAtMs: this.clock.now(),
      state: "available",
    });
    return artifact;
  }

  public async mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    const record = await this.observationForMutation(
      ref,
      request.observationId,
      deadline,
    );
    let expanded: ExpandedMouseActions;
    try {
      expanded = expandMouseActions(request.actions, {
        imageWidth: record.observation.imageWidth,
        imageHeight: record.observation.imageHeight,
        contentX: record.observation.geometry.contentX,
        contentY: record.observation.geometry.contentY,
        contentWidth: record.observation.geometry.contentWidth,
        contentHeight: record.observation.geometry.contentHeight,
      });
    } catch {
      throw admissionFailure("INVALID_COORDINATE", "none");
    }
    this.reserveObservation(record);
    const state = this.requireCurrent();
    try {
      const receipt = await this.controller.mouse(
        {
          operation_id: request.requestId,
          expected_lifecycle_generation: state.snapshot.lifecycle_generation,
          expected_channel_generation: state.snapshot.channel_generation,
          expected_display_generation: state.snapshot.display_generation,
          expected_dispatch_generation: state.snapshot.dispatch_generation,
          timeout_ms: deadline.timeoutMs,
          operations: expanded.operations,
        },
        deadline,
      );
      record.state = "consumed";
      return {
        requestId: request.requestId,
        outcome: "applied",
        verification: "device_ack_only",
        dispatchedCount: request.actions.length,
        completedCount: request.actions.length,
        acknowledgedAt: receipt.acknowledged_at,
      };
    } catch (error) {
      if (!(error instanceof BrowserPlaneError)) {
        this.consumeUnknown(record);
        throw browserFailure({
          code: "MUTATION_OUTCOME_UNKNOWN",
          outcome: "unknown",
          stage: "acknowledgement",
          writeBegan: true,
          acknowledged: false,
          dispatchedCount: 0,
          completedCount: 0,
          requestedCount: request.actions.length,
          failedIndex: 0,
          safeToRetry: false,
          requiredNextStep: "inspect_device_state_before_retry",
          suffixSuppressed: true,
        });
      }
      this.finalizeObservationAfterError(record, error);
      throw remapOperationError(error, expanded.actionOperationEnds);
    }
  }

  public keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<KeyboardMutationReceipt> {
    const previous = this.keyboardTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.keyboardTail = previous.then(
      () => slot,
      () => slot,
    );
    return previous
      .then(() => this.keyboardNow(ref, request, deadline))
      .finally(release);
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    const normalized = normalizePasteText(request.text);
    const originalByteCount = Buffer.byteLength(request.text, "utf8");
    const normalizedByteCount = Buffer.byteLength(normalized, "utf8");
    const normalizedSha256 = createHash("sha256")
      .update(normalized)
      .digest("hex");
    const record = await this.observationForMutation(
      ref,
      request.observationId,
      deadline,
    );
    const state = this.requireCurrent();
    if (
      !state.snapshot.reliable_paste ||
      state.snapshot.keyboard_layout === null
    ) {
      throw browserFailure({
        code: "CAPABILITY_MISSING",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: normalizedByteCount,
        safeToRetry: false,
        requiredNextStep: "enable_capability",
        suffixSuppressed: false,
      });
    }
    this.reserveObservation(record);
    this.pasteActive = true;
    try {
      const receipt = await this.controller.paste(
        {
          operation_id: request.requestId,
          expected_lifecycle_generation: state.snapshot.lifecycle_generation,
          expected_channel_generation: state.snapshot.channel_generation,
          expected_display_generation: state.snapshot.display_generation,
          expected_dispatch_generation: state.snapshot.dispatch_generation,
          timeout_ms: deadline.timeoutMs,
          text: request.text,
        },
        deadline,
      );
      if (
        receipt.original_byte_count !== originalByteCount ||
        receipt.normalized_byte_count !== normalizedByteCount ||
        receipt.normalized_sha256 !== normalizedSha256
      ) {
        record.state = "consumed";
        throw browserFailure({
          code: "DOWNSTREAM_MALFORMED_RESPONSE",
          outcome: "applied",
          stage: "verification",
          writeBegan: true,
          acknowledged: true,
          dispatchedCount: normalizedByteCount,
          completedCount: normalizedByteCount,
          requestedCount: normalizedByteCount,
          safeToRetry: false,
          requiredNextStep: "none",
          suffixSuppressed: false,
        });
      }
      record.state = "consumed";
      return this.pasteReceipt(request.requestId, receipt);
    } catch (error) {
      if (!(error instanceof BrowserPlaneError)) {
        this.consumeUnknown(record);
        throw browserFailure({
          code: "MUTATION_OUTCOME_UNKNOWN",
          outcome: "unknown",
          stage: "acknowledgement",
          writeBegan: true,
          acknowledged: false,
          dispatchedCount: normalizedByteCount,
          completedCount: 0,
          requestedCount: normalizedByteCount,
          failedIndex: 0,
          safeToRetry: false,
          requiredNextStep: "inspect_device_state_before_retry",
          suffixSuppressed: true,
        });
      }
      this.finalizeObservationAfterError(record, error);
      if (!error.writeBegan) throw error;
      throw new BrowserPlaneError({
        code: error.code,
        outcome: error.outcome,
        stage: error.stage,
        writeBegan: error.writeBegan,
        acknowledged: error.acknowledged,
        dispatchedCount: normalizedByteCount,
        completedCount: error.acknowledged ? normalizedByteCount : 0,
        requestedCount: normalizedByteCount,
        ...(error.acknowledged ? {} : { failedIndex: 0 }),
        safeToRetry: error.safeToRetry,
        requiredNextStep: error.requiredNextStep,
        suffixSuppressed: error.suffixSuppressed,
      });
    } finally {
      this.pasteActive = false;
    }
  }

  public async release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt> {
    if (this.releaseAttempted) {
      throw admissionFailure("SESSION_DRAINED", "reconnect_then_capture");
    }
    this.releaseAttempted = true;
    let state: PlaneState;
    try {
      state = await this.preflight(ref, deadline, true, true);
    } catch (error) {
      this.releaseAttempted = false;
      throw error;
    }
    const pasteWasActive = this.pasteActive;
    this.gateClosed = true;
    this.observations.clear();
    try {
      const receipt = await this.controller.release(
        {
          operation_id: request.requestId,
          expected_lifecycle_generation: state.snapshot.lifecycle_generation,
          expected_channel_generation: state.snapshot.channel_generation,
          expected_display_generation: state.snapshot.display_generation,
          expected_dispatch_generation: state.snapshot.dispatch_generation,
          timeout_ms: deadline.timeoutMs,
        },
        deadline,
      );
      state.snapshot = {
        ...state.snapshot,
        state: "closed",
        dispatch_generation: receipt.dispatch_generation,
      };
      this.clearHeldKeys();
      return {
        requestId: request.requestId,
        outcome: "applied",
        verification: "device_state_verified",
        dispatchedCount: 1,
        completedCount: 1,
        acknowledgedAt: receipt.released_at,
        mutationGateClosed: true,
        deferredProducersJoined: true,
        pasteTerminal: pasteWasActive ? "cancelled" : "inactive",
        ordinaryLeasesZero: true,
        keyboardZero: true,
        pointerZero: true,
        generationDrained: true,
        heldKeys: [],
      };
    } catch (error) {
      this.gateClosed = true;
      this.observations.clear();
      if (error instanceof BrowserPlaneError) throw error;
      throw browserFailure({
        code: "MUTATION_OUTCOME_UNKNOWN",
        outcome: "unknown",
        stage: "acknowledgement",
        writeBegan: true,
        acknowledged: false,
        dispatchedCount: 1,
        completedCount: 0,
        requestedCount: 1,
        failedIndex: 0,
        safeToRetry: false,
        requiredNextStep: "inspect_device_state_before_retry",
        suffixSuppressed: true,
      });
    }
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.assertDeadline(deadline);
    this.assertRef(ref);
    this.gateClosed = true;
    this.observations.clear();
    this.clearHeldKeys();
    this.previous = this.current;
    this.current = null;
    await this.controller.close(deadline);
  }

  private async publishConnection(
    ref: SessionRef,
    deadline: Deadline,
    replacing: boolean,
  ): Promise<BrowserConnection> {
    this.assertDeadline(deadline);
    if (replacing) {
      await this.controller.reconnect(deadline);
    }
    const snapshot = await this.controller.snapshot(deadline);
    this.assertReady(snapshot);
    const previous = this.current ?? (replacing ? this.previous : null);
    const sameSessionLineage =
      previous !== null && previous.binding.sessionId === ref.sessionId;
    if (
      replacing &&
      sameSessionLineage &&
      this.controller.connectionIdentity() === previous.controllerIdentity &&
      snapshot.channel_generation === previous.snapshot.channel_generation
    ) {
      throw admissionFailure("CONNECTION_LOST", "reconnect_then_capture");
    }
    const connectionEpoch = sameSessionLineage
      ? Math.max(
          previous.binding.connectionEpoch + 1,
          snapshot.lifecycle_generation,
        )
      : snapshot.lifecycle_generation;
    const browserChannelGeneration = sameSessionLineage
      ? Math.max(
          previous.binding.browserChannelGeneration + 1,
          snapshot.channel_generation,
        )
      : snapshot.channel_generation;
    const next: PlaneState = {
      ref: Object.freeze({ ...ref }),
      binding: Object.freeze({
        sessionId: ref.sessionId,
        sessionGeneration: ref.sessionGeneration,
        connectionEpoch,
        browserChannelGeneration,
      }),
      controllerIdentity: this.controller.connectionIdentity(),
      snapshot,
      lastFrameSequence: 0,
    };
    if (replacing && previous !== null) {
      try {
        validateDeviceRpcBindingReplacement(previous.binding, next.binding);
      } catch {
        throw admissionFailure(
          "STALE_SESSION_GENERATION",
          "reconnect_then_capture",
        );
      }
    } else if (replacing) {
      throw admissionFailure(
        "STALE_SESSION_GENERATION",
        "reconnect_then_capture",
      );
    }
    this.observations.clear();
    this.clearHeldKeys();
    this.gateClosed = false;
    this.releaseAttempted = false;
    this.current = next;
    this.previous = null;
    return this.connection(next);
  }

  private connection(state: PlaneState): BrowserConnection {
    return Object.freeze({
      state: "ready",
      ref: state.ref,
      binding: state.binding,
      connectionEpoch: state.binding.connectionEpoch,
      browserChannelGeneration: state.binding.browserChannelGeneration,
      displayGeneration: state.snapshot.display_generation,
      deviceRpc: this.deviceRpc,
    });
  }

  private async preflight(
    ref: SessionRef,
    deadline: Deadline,
    allowDisplayChange: boolean,
    allowClosedGate = false,
  ): Promise<PlaneState> {
    this.assertDeadline(deadline);
    this.assertRef(ref);
    if (this.gateClosed && !allowClosedGate) {
      throw admissionFailure("SESSION_DRAINED", "reconnect_then_capture");
    }
    const state = this.requireCurrent();
    const snapshot = await this.controller.snapshot(deadline);
    this.assertReady(snapshot);
    if (
      snapshot.lifecycle_generation !== state.snapshot.lifecycle_generation ||
      snapshot.channel_generation !== state.snapshot.channel_generation
    ) {
      this.observations.clear();
      throw admissionFailure("CONNECTION_LOST", "reconnect_then_capture");
    }
    if (snapshot.dispatch_generation !== state.snapshot.dispatch_generation) {
      this.gateClosed = true;
      this.observations.clear();
      state.snapshot = snapshot;
      throw admissionFailure("SESSION_DRAINED", "reconnect_then_capture");
    }
    const displayChanged =
      snapshot.display_generation !== state.snapshot.display_generation ||
      snapshot.source_width !== state.snapshot.source_width ||
      snapshot.source_height !== state.snapshot.source_height;
    state.snapshot = snapshot;
    if (displayChanged) {
      this.observations.clear();
      if (!allowDisplayChange) {
        throw admissionFailure("DISPLAY_CHANGED", "capture_then_retry", true);
      }
    }
    return state;
  }

  private assertReady(snapshot: AutomationSnapshot): void {
    if (snapshot.state !== "ready") {
      throw admissionFailure(
        snapshot.state === "closed" ? "SESSION_DRAINED" : "CONNECTION_LOST",
        "reconnect_then_capture",
      );
    }
    if (
      !snapshot.rpc_ready ||
      !snapshot.hid_ready ||
      !snapshot.video_ready ||
      !snapshot.absolute_pointer ||
      !snapshot.scroll_throttling_disabled ||
      snapshot.source_width === null ||
      snapshot.source_height === null
    ) {
      throw admissionFailure("CONNECTION_LOST", "reconnect_then_capture");
    }
  }

  private async observationForMutation(
    ref: SessionRef,
    observationId: string,
    deadline: Deadline,
  ): Promise<ObservationRecord> {
    const state = await this.preflight(ref, deadline, false);
    const record = this.observations.get(observationId);
    if (
      record === undefined ||
      record.observation.sessionId !== ref.sessionId ||
      record.observation.sessionGeneration !== ref.sessionGeneration ||
      record.observation.connectionEpoch !== state.binding.connectionEpoch ||
      record.observation.displayGeneration !== state.snapshot.display_generation
    ) {
      throw admissionFailure("STALE_OBSERVATION", "capture_then_retry");
    }
    if (record.state !== "available") {
      throw admissionFailure("OBSERVATION_CONSUMED", "capture_then_retry");
    }
    const age = Math.max(0, Math.floor(this.clock.now() - record.createdAtMs));
    if (age > this.maxObservationAgeMs) {
      throw admissionFailure("STALE_OBSERVATION", "capture_then_retry");
    }
    return record;
  }

  private reserveObservation(record: ObservationRecord): void {
    if (record.state !== "available") {
      throw admissionFailure("OBSERVATION_CONSUMED", "capture_then_retry");
    }
    const age = Math.max(0, Math.floor(this.clock.now() - record.createdAtMs));
    if (age > this.maxObservationAgeMs) {
      throw admissionFailure("STALE_OBSERVATION", "capture_then_retry");
    }
    record.state = "reserved";
  }

  private finalizeObservationAfterError(
    record: ObservationRecord,
    error: BrowserPlaneError,
  ): void {
    if (error.outcome === "not_sent" && !error.writeBegan && !this.gateClosed) {
      record.state = "available";
      if (error.code === "DISPLAY_CHANGED") this.observations.clear();
      return;
    }
    record.state = "consumed";
    if (error.outcome === "unknown") {
      this.gateClosed = true;
      this.observations.clear();
    }
  }

  private consumeUnknown(record: ObservationRecord): void {
    record.state = "consumed";
    this.gateClosed = true;
    this.observations.clear();
  }

  private clearHeldKeys(): void {
    this.heldKeys.clear();
    this.heldKeyAutoReleaseAtMs.clear();
  }

  private updateHeldKey(
    key: PhysicalKey,
    press: boolean,
    nonModifierReleaseAtMs = this.clock.now() + FIRMWARE_NON_MODIFIER_AUTO_RELEASE_MS,
  ): void {
    if (!press) {
      this.heldKeys.delete(key);
      this.heldKeyAutoReleaseAtMs.delete(key);
      return;
    }
    this.heldKeys.add(key);
    if (isModifierPhysicalKey(key)) {
      this.heldKeyAutoReleaseAtMs.delete(key);
      return;
    }
    this.heldKeyAutoReleaseAtMs.set(key, nonModifierReleaseAtMs);
  }

  private replaceHeldKeys(
    keys: ReadonlySet<PhysicalKey>,
    nonModifierReleaseAtMs: number,
  ): void {
    this.clearHeldKeys();
    for (const key of keys) {
      this.updateHeldKey(key, true, nonModifierReleaseAtMs);
    }
    this.pruneAutoReleasedKeys();
  }

  private pruneAutoReleasedKeys(): void {
    const now = this.clock.now();
    for (const [key, releaseAt] of this.heldKeyAutoReleaseAtMs) {
      if (now < releaseAt) continue;
      this.heldKeyAutoReleaseAtMs.delete(key);
      this.heldKeys.delete(key);
    }
  }

  private async keyboardNow(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<KeyboardMutationReceipt> {
    this.pruneAutoReleasedKeys();
    let expanded: ExpandedKeyboardActions;
    try {
      expanded = expandKeyboardActions(request.actions, this.heldKeys);
    } catch (error) {
      if (error instanceof BrowserPlaneError) throw error;
      throw invalidKeyTransition();
    }
    const record = await this.observationForMutation(
      ref,
      request.observationId,
      deadline,
    );
    const state = this.requireCurrent();
    if (state.snapshot.keyboard_layout === null) {
      throw browserFailure({
        code: "CAPABILITY_MISSING",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: request.actions.length,
        safeToRetry: false,
        requiredNextStep: "enable_capability",
        suffixSuppressed: false,
      });
    }
    this.reserveObservation(record);
    const nonModifierReleaseAtMs =
      this.clock.now() + FIRMWARE_NON_MODIFIER_AUTO_RELEASE_MS;
    try {
      const receipt = await this.controller.keyboard(
        {
          operation_id: request.requestId,
          expected_lifecycle_generation: state.snapshot.lifecycle_generation,
          expected_channel_generation: state.snapshot.channel_generation,
          expected_display_generation: state.snapshot.display_generation,
          expected_dispatch_generation: state.snapshot.dispatch_generation,
          timeout_ms: deadline.timeoutMs,
          operations: expanded.operations,
        },
        deadline,
      );
      record.state = "consumed";
      this.replaceHeldKeys(expanded.finalHeldKeys, nonModifierReleaseAtMs);
      return {
        requestId: request.requestId,
        outcome: "applied",
        verification: "device_ack_only",
        dispatchedCount: request.actions.length,
        completedCount: request.actions.length,
        acknowledgedAt: receipt.acknowledged_at,
        heldKeys: Object.freeze(
          PHYSICAL_KEYS.filter((key) => this.heldKeys.has(key)),
        ),
      };
    } catch (error) {
      if (!(error instanceof BrowserPlaneError)) {
        this.consumeUnknown(record);
        throw browserFailure({
          code: "MUTATION_OUTCOME_UNKNOWN",
          outcome: "unknown",
          stage: "acknowledgement",
          writeBegan: true,
          acknowledged: false,
          dispatchedCount: 0,
          completedCount: 0,
          requestedCount: request.actions.length,
          failedIndex: 0,
          safeToRetry: false,
          requiredNextStep: "inspect_device_state_before_retry",
          suffixSuppressed: true,
        });
      }
      for (
        let index = 0;
        index < Math.min(error.completedCount, expanded.operations.length);
        index += 1
      ) {
        const operation = expanded.operations[index];
        const actionKey =
          operation === undefined
            ? undefined
            : PHYSICAL_KEY_BY_USAGE[operation.key];
        if (actionKey !== undefined) {
          this.updateHeldKey(
            actionKey,
            operation?.press === true,
            nonModifierReleaseAtMs,
          );
        }
      }
      if (error.outcome === "applied" && error.acknowledged) {
        this.replaceHeldKeys(expanded.finalHeldKeys, nonModifierReleaseAtMs);
      }
      this.finalizeObservationAfterError(record, error);
      throw remapOperationError(error, expanded.actionOperationEnds);
    }
  }

  private pasteReceipt(
    requestId: string,
    receipt: PasteBridgeReceipt,
  ): PasteReceipt {
    return {
      requestId,
      outcome: "applied",
      verification: "device_ack_only",
      dispatchedCount: receipt.normalized_byte_count,
      completedCount: receipt.normalized_byte_count,
      acknowledgedAt: receipt.completed_at,
      originalByteCount: receipt.original_byte_count,
      normalizedByteCount: receipt.normalized_byte_count,
      normalizedSha256: receipt.normalized_sha256,
      acceptedAt: receipt.accepted_at,
      completedAt: receipt.completed_at,
      terminalState: "succeeded",
      measuredCharsPerSecond: receipt.measured_source_cps,
    };
  }

  private nextId(prefix: string): string {
    const id = this.idFactory(prefix);
    if (!isCanonicalOpaqueId(id)) {
      throw new TypeError("Generated browser operation identifier is invalid.");
    }
    return id;
  }

  private assertDeadline(deadline: Deadline): void {
    if (
      deadline.signal.aborted ||
      !Number.isSafeInteger(deadline.timeoutMs) ||
      deadline.timeoutMs < 100 ||
      deadline.timeoutMs > 300_000
    ) {
      throw browserFailure({
        code: deadline.signal.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "none",
        suffixSuppressed: false,
      });
    }
  }

  private assertRef(ref: SessionRef): void {
    const current = this.requireCurrent();
    if (
      current.ref.sessionId !== ref.sessionId ||
      current.ref.sessionGeneration !== ref.sessionGeneration
    ) {
      throw admissionFailure(
        "STALE_SESSION_GENERATION",
        "reconnect_then_capture",
      );
    }
  }

  private requireCurrent(): PlaneState {
    if (this.current === null) {
      throw admissionFailure("CONNECTION_LOST", "reconnect_then_capture");
    }
    return this.current;
  }

  private assertDeviceDeadline(deadline: Deadline, maximumMs: number): void {
    if (
      deadline.signal.aborted ||
      !Number.isSafeInteger(deadline.timeoutMs) ||
      deadline.timeoutMs < 1 ||
      deadline.timeoutMs > maximumMs
    ) {
      throw new DeviceRpcError(
        deadline.signal.aborted ? "CANCELLED" : "INVALID_DEADLINE",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
  }

  private assertDeviceBinding(binding: DeviceRpcBinding): void {
    const current = this.requireCurrent().binding;
    if (!bindingsEqual(binding, current)) {
      throw new DeviceRpcError(
        "STALE_BINDING",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
  }

  private async readDisplayState(
    binding: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState> {
    this.assertDeviceBinding(binding);
    this.assertDeviceDeadline(deadline, 30_000);
    const current = this.requireCurrent();
    const expected = current.binding;
    const bridgeSnapshot = current.snapshot;
    let result: ReadBridgeResult;
    try {
      result = await this.controller.readVideoState(
        {
          operation_id: this.nextId("read-video"),
          expected_lifecycle_generation: bridgeSnapshot.lifecycle_generation,
          expected_channel_generation: bridgeSnapshot.channel_generation,
          timeout_ms: deadline.timeoutMs,
        },
        deadline,
      );
    } catch (error) {
      throw this.deviceReadError(error, expected);
    }
    this.assertDeviceBindingAfterAwait(binding, expected);
    const parsed = cachedVideoResultSchema.safeParse(result.result);
    if (!parsed.success) throw this.malformedDeviceRead();
    const cached = parsed.data.cached_event;
    if (cached === null) return unknownDisplayState();
    if (cached.channel_generation !== bridgeSnapshot.channel_generation) {
      throw this.malformedDeviceRead();
    }
    const freshness = cached.age_ms === 0 ? "fresh" : "stale";
    const fact = <T>(value: T): QualifiedFact<T> => ({
      value,
      observedAt: cached.observed_at,
      ageMs: cached.age_ms,
      freshness,
      source: "cached_event",
    });
    const signal: NativeSignal = cached.state.ready
      ? "present"
      : cached.state.error === "no_signal" ||
          cached.state.error === "no_lock" ||
          cached.state.error === "out_of_range"
        ? cached.state.error
        : "unknown";
    const resolution: NativeResolution | null =
      cached.state.width > 0 && cached.state.height > 0
        ? {
            width: cached.state.width,
            height: cached.state.height,
            refreshHz: null,
          }
        : null;
    return {
      signal: fact(signal),
      resolution: fact(resolution),
      fps: fact(cached.state.fps > 0 ? cached.state.fps : null),
      qualification: "current_binding",
    };
  }

  private async readEdid(
    binding: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.assertDeviceBinding(binding);
    this.assertDeviceDeadline(deadline, 30_000);
    const current = this.requireCurrent();
    const expected = current.binding;
    const bridgeSnapshot = current.snapshot;
    let result: ReadBridgeResult;
    try {
      result = await this.controller.readEdid(
        {
          operation_id: this.nextId("read-edid"),
          expected_lifecycle_generation: bridgeSnapshot.lifecycle_generation,
          expected_channel_generation: bridgeSnapshot.channel_generation,
          timeout_ms: deadline.timeoutMs,
        },
        deadline,
      );
    } catch (error) {
      throw this.deviceReadError(error, expected);
    }
    this.assertDeviceBindingAfterAwait(binding, expected);
    const parsed = edidWireResultSchema.safeParse(result.result);
    if (!parsed.success) throw this.malformedDeviceRead();
    return this.mapEdid(parsed.data, result.acknowledged_at);
  }

  private async performAtx(
    binding: DeviceRpcBinding,
    request: {
      readonly requestId: string;
      readonly action: "press_power" | "hold_power" | "press_reset";
    },
    deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    this.assertDeviceBinding(binding);
    this.assertDeviceDeadline(deadline, 60_000);
    if (!isCanonicalOpaqueId(request.requestId)) {
      throw new DeviceRpcError(
        "INVALID_REQUEST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    const current = this.requireCurrent();
    const expected = current.binding;
    const bridgeSnapshot = current.snapshot;
    let result: ReadBridgeResult;
    try {
      result = await this.controller.performAtx(
        {
          operation_id: request.requestId,
          expected_lifecycle_generation: bridgeSnapshot.lifecycle_generation,
          expected_channel_generation: bridgeSnapshot.channel_generation,
          timeout_ms: deadline.timeoutMs,
          request_id: request.requestId,
          action: request.action,
        },
        deadline,
      );
    } catch (error) {
      throw this.deviceReadError(error, expected);
    }
    this.assertDeviceBindingAfterAwait(binding, expected);
    try {
      return parseAtxWireReceipt(result.result, request);
    } catch {
      throw this.malformedDeviceRead();
    }
  }

  private assertDeviceBindingAfterAwait(
    requested: DeviceRpcBinding,
    expectedObject: DeviceRpcBinding,
  ): void {
    const current = this.current?.binding;
    if (
      current === undefined ||
      current !== expectedObject ||
      !bindingsEqual(requested, current)
    ) {
      throw new DeviceRpcError(
        "BINDING_REPLACED",
        "ack",
        "applied",
        true,
        true,
      );
    }
  }

  private deviceReadError(
    error: unknown,
    expected: DeviceRpcBinding,
  ): DeviceRpcError {
    if (error instanceof DeviceRpcError) return error;
    const replaced = this.current?.binding !== expected;
    if (error instanceof BrowserPlaneError) {
      const boundary =
        error.boundary === "admission"
          ? "admission"
          : error.boundary === "queue"
            ? "queue"
            : error.boundary === "send"
              ? "send"
              : "ack";
      const qualifiedAtxCode =
        ATX_DEVICE_ERROR_CODES.has(error.code as DeviceRpcErrorCode)
          ? (error.code as DeviceRpcErrorCode)
          : null;
      const code = replaced
        ? "BINDING_REPLACED"
        : qualifiedAtxCode ??
          (error.code === "EDID_READ_FAILED"
            ? "EDID_READ_FAILED"
            : error.code === "CANCELLED"
              ? "CANCELLED"
              : error.code === "DEADLINE_EXCEEDED"
                ? "DEADLINE_EXCEEDED"
                : error.code === "DOWNSTREAM_MALFORMED_RESPONSE"
                  ? "MALFORMED_RESPONSE"
                  : "CONNECTION_LOST");
      return new DeviceRpcError(
        code,
        boundary,
        error.outcome,
        error.writeBegan,
        error.acknowledged,
      );
    }
    return new DeviceRpcError(
      replaced ? "BINDING_REPLACED" : "CONNECTION_LOST",
      "ack",
      "unknown",
      true,
      false,
    );
  }

  private malformedDeviceRead(): DeviceRpcError {
    return new DeviceRpcError(
      "MALFORMED_RESPONSE",
      "ack",
      "applied",
      true,
      true,
    );
  }

  private mapEdid(raw: string | null, observedAt: string): QualifiedEdidRead {
    if (raw === null || raw.length === 0) {
      return {
        status: "unavailable",
        readCompleted: true,
        reason: "successful_read_reported_no_edid",
        observedAt,
        data: null,
      };
    }
    if (
      raw.length < EDID_BLOCK_BYTES * 2 ||
      raw.length % (EDID_BLOCK_BYTES * 2) !== 0 ||
      !/^[a-fA-F0-9]+$/.test(raw)
    ) {
      throw this.malformedDeviceRead();
    }
    const extensionCountOffset = EDID_EXTENSION_COUNT_OFFSET * 2;
    const extensionCount = Number.parseInt(
      raw.slice(extensionCountOffset, extensionCountOffset + 2),
      16,
    );
    if (raw.length !== (extensionCount + 1) * EDID_BLOCK_BYTES * 2) {
      throw this.malformedDeviceRead();
    }
    const bytes = Buffer.from(raw, "hex");
    const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    if (header.some((value, index) => bytes[index] !== value)) {
      throw this.malformedDeviceRead();
    }
    for (let offset = 0; offset < bytes.length; offset += EDID_BLOCK_BYTES) {
      let checksum = 0;
      for (let index = offset; index < offset + EDID_BLOCK_BYTES; index += 1) {
        checksum = (checksum + (bytes[index] ?? 0)) & 0xff;
      }
      if (checksum !== 0) throw this.malformedDeviceRead();
    }
    const manufacturerCode = (bytes[8] ?? 0) * 256 + (bytes[9] ?? 0);
    const manufacturerCharacters = [
      (manufacturerCode >> 10) & 0x1f,
      (manufacturerCode >> 5) & 0x1f,
      manufacturerCode & 0x1f,
    ];
    const manufacturerId = manufacturerCharacters.every(
      (value) => value >= 1 && value <= 26,
    )
      ? String.fromCharCode(
          ...manufacturerCharacters.map((value) => value + 64),
        )
      : null;
    const productCode = (bytes[10] ?? 0) + (bytes[11] ?? 0) * 256;
    const serial =
      (bytes[12] ?? 0) +
      (bytes[13] ?? 0) * 256 +
      (bytes[14] ?? 0) * 65_536 +
      (bytes[15] ?? 0) * 16_777_216;
    let displayName: string | null = null;
    for (const offset of [54, 72, 90, 108]) {
      if (
        bytes[offset] === 0 &&
        bytes[offset + 1] === 0 &&
        bytes[offset + 2] === 0 &&
        bytes[offset + 3] === 0xfc
      ) {
        const value = String.fromCharCode(
          ...bytes.subarray(offset + 5, offset + 18),
        )
          .replace(/[\0\r\n]/g, "")
          .trim();
        displayName = value.length === 0 ? null : value;
        break;
      }
    }
    let preferredResolution: NativeResolution | null = null;
    const pixelClock10Khz = (bytes[54] ?? 0) + (bytes[55] ?? 0) * 256;
    if (pixelClock10Khz > 0) {
      const width = (bytes[56] ?? 0) + (((bytes[58] ?? 0) & 0xf0) << 4);
      const horizontalBlanking =
        (bytes[57] ?? 0) + (((bytes[58] ?? 0) & 0x0f) << 8);
      const height = (bytes[59] ?? 0) + (((bytes[61] ?? 0) & 0xf0) << 4);
      const verticalBlanking =
        (bytes[60] ?? 0) + (((bytes[61] ?? 0) & 0x0f) << 8);
      const total = (width + horizontalBlanking) * (height + verticalBlanking);
      const refreshHz =
        total > 0
          ? Math.round((pixelClock10Khz * 10_000 * 100) / total) / 100
          : null;
      if (width > 0 && height > 0) {
        preferredResolution = {
          width,
          height,
          refreshHz: refreshHz !== null && refreshHz > 0 ? refreshHz : null,
        };
      }
    }
    return {
      status: "available",
      readCompleted: true,
      reason: null,
      observedAt,
      data: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        manufacturerId,
        productCode,
        serialNumber: serial === 0 ? null : String(serial),
        displayName,
        preferredResolution,
      },
    };
  }
}
