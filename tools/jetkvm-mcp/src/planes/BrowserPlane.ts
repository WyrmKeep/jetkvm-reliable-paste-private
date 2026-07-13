import type { KeyboardAction, MouseAction, PhysicalKey } from "../domain.js";
import type {
  Deadline,
  DeviceRpcAdapter,
  DeviceRpcBinding,
  SessionRef,
} from "../device/DeviceRpcAdapter.js";

export interface BrowserConnection {
  readonly state: "ready";
  readonly ref: SessionRef;
  readonly binding: DeviceRpcBinding;
  readonly connectionEpoch: number;
  readonly browserChannelGeneration: number;
  readonly displayGeneration: number;
  /** The one adapter backed by the Browser-owned WebRTC RPC channel. */
  readonly deviceRpc: DeviceRpcAdapter;
}

export interface CaptureRequest {
  readonly format: "jpeg" | "png";
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export interface ObservationGeometry {
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

export interface Observation {
  readonly observationId: string;
  readonly sessionGeneration: number;
  readonly connectionEpoch: number;
  readonly displayGeneration: number;
  readonly frameId: string;
  readonly capturedAt: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly geometry: ObservationGeometry;
  readonly image: {
    readonly mimeType: "image/jpeg" | "image/png";
    readonly sha256: string;
    readonly bytes: Uint8Array;
  };
}

export interface MouseRequest {
  readonly observationId: string;
  readonly requestId: string;
  readonly actions: readonly MouseAction[];
}

export interface KeyboardRequest {
  readonly observationId: string;
  readonly requestId: string;
  readonly actions: readonly KeyboardAction[];
}

export interface PasteRequest {
  readonly observationId: string;
  readonly requestId: string;
  readonly text: string;
}

export interface ReleaseRequest {
  readonly requestId: string;
}

export interface MutationReceipt {
  readonly requestId: string;
  readonly outcome: "applied" | "already_applied";
  readonly verification: "device_ack_only" | "device_state_verified";
  readonly dispatchedCount: number;
  readonly completedCount: number;
  readonly acknowledgedAt: string;
}

export interface PasteReceipt extends MutationReceipt {
  readonly originalByteCount: number;
  readonly normalizedByteCount: number;
  readonly normalizedSha256: string;
  readonly acceptedAt: string | null;
  readonly completedAt: string | null;
  readonly terminalState: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly measuredCharsPerSecond: number | null;
}

export interface ReleaseReceipt extends MutationReceipt {
  readonly mutationGateClosed: boolean;
  readonly deferredProducersJoined: boolean;
  readonly pasteTerminal: "cancelled" | "inactive" | "unknown";
  readonly ordinaryLeasesZero: boolean | null;
  readonly keyboardZero: boolean | null;
  readonly pointerZero: boolean | null;
  readonly generationDrained: boolean;
  readonly heldKeys: readonly PhysicalKey[];
}

/** Capability-shaped access to the one managed product browser/WebRTC path. */
export interface BrowserPlane {
  connect(ref: SessionRef, deadline: Deadline): Promise<BrowserConnection>;
  reconnect(ref: SessionRef, deadline: Deadline): Promise<BrowserConnection>;
  capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<Observation>;
  mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt>;
  keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt>;
  paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt>;
  release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt>;
  close(ref: SessionRef, deadline: Deadline): Promise<void>;
}
