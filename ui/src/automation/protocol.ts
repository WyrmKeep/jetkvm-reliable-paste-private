export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type AutomationState = "ready" | "not_ready" | "unmounted" | "closed";

export interface AutomationSnapshot {
  readonly version: 1;
  readonly state: AutomationState;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number;
  readonly dispatch_generation: number;
  readonly rpc_ready: boolean;
  readonly hid_ready: boolean;
  readonly video_ready: boolean;
  readonly absolute_pointer: boolean;
  readonly scroll_throttling_disabled: boolean;
  readonly keyboard_layout: string | null;
  readonly reliable_paste: boolean;
  readonly source_width: number | null;
  readonly source_height: number | null;
}

export interface BridgeRequest {
  readonly operation_id: string;
  readonly expected_lifecycle_generation: number;
  readonly expected_channel_generation: number;
  readonly timeout_ms: number;
}

export interface InputBridgeRequest extends BridgeRequest {
  readonly expected_display_generation: number;
  readonly expected_dispatch_generation: number;
}

export interface CaptureBridgeRequest extends BridgeRequest {
  readonly format: "jpeg" | "png";
  readonly max_width: number;
  readonly max_height: number;
}

export interface CaptureBridgeResult {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number;
  readonly frame_sequence: number;
  readonly captured_at: string;
  readonly source_width: number;
  readonly source_height: number;
  readonly image_width: number;
  readonly image_height: number;
  readonly rotation: 0;
  readonly geometry: {
    readonly x: 0;
    readonly y: 0;
    readonly width: number;
    readonly height: number;
  };
  readonly format: "jpeg" | "png";
  readonly mime_type: "image/jpeg" | "image/png";
  readonly byte_length: number;
  readonly sha256: string;
  readonly base64: string;
}

export type MouseBridgeOperation =
  | {
      readonly kind: "absolute";
      readonly x: number;
      readonly y: number;
      readonly buttons: number;
    }
  | {
      readonly kind: "wheel";
      readonly delta_y: number;
    };

export interface MouseBridgeRequest extends InputBridgeRequest {
  readonly operations: readonly MouseBridgeOperation[];
}

export interface KeyboardBridgeOperation {
  readonly key: number;
  readonly press: boolean;
}

export interface KeyboardBridgeRequest extends InputBridgeRequest {
  readonly operations: readonly KeyboardBridgeOperation[];
}

export interface MutationBridgeReceipt {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number;
  readonly dispatch_generation: number;
  readonly queued_at: string;
  readonly acknowledged_at: string;
  readonly dispatched_count: number;
  readonly completed_count: number;
}

export type KeyboardBridgeReceipt = MutationBridgeReceipt;

export interface PasteBridgeRequest extends InputBridgeRequest {
  readonly text: string;
}

export interface PasteBridgeReceipt {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number;
  readonly dispatch_generation: number;
  readonly original_byte_count: number;
  readonly normalized_byte_count: number;
  readonly normalized_sha256: string;
  readonly accepted_at: string;
  readonly completed_at: string;
  readonly terminal_state: "succeeded";
  readonly measured_source_cps: number;
}

export type ReleaseBridgeRequest = InputBridgeRequest;

export interface ReleaseBridgeReceipt {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number;
  readonly dispatch_generation: number;
  readonly device_generation: number;
  readonly outcome: "released";
  readonly draining: true;
  readonly producers_joined: true;
  readonly macro_inactive: true;
  readonly paste_inactive: true;
  readonly ordinary_leases_zero: true;
  readonly keyboard_zero: true;
  readonly pointer_zero: true;
  readonly released_at: string;
}

export type ReadBridgeRequest = BridgeRequest;
export interface AtxBridgeRequest extends BridgeRequest {
  readonly request_id: string;
  readonly action: "press_power" | "hold_power" | "press_reset";
}

export interface ReadBridgeResult {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly acknowledged_at: string;
  readonly result: JsonValue;
}

export type AutomationBridgeErrorCode =
  | "INVALID_REQUEST"
  | "NOT_READY"
  | "UNMOUNTED"
  | "CLOSED"
  | "GENERATION_MISMATCH"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "CHANNEL_LOST"
  | "DISPLAY_CHANGED"
  | "DISPATCH_REPLACED"
  | "DOWNSTREAM_ERROR"
  | "EDID_READ_FAILED"
  | "ATX_EXTENSION_INACTIVE"
  | "ATX_SERIAL_UNAVAILABLE"
  | "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT"
  | "STALE_SESSION_GENERATION"
  | "MUTATION_OUTCOME_UNKNOWN"
  | "CONFIG_INVALID"
  | "DOWNSTREAM_MALFORMED_RESPONSE"
  | "MALFORMED_ACKNOWLEDGEMENT"
  | "VIDEO_STALLED"
  | "CAPTURE_FAILED"
  | "CAPTURE_TOO_LARGE"
  | "MIME_MISMATCH"
  | "PASTE_UNSUPPORTED"
  | "PASTE_LIFECYCLE"
  | "RELEASE_FAILED";

export type AutomationBridgeStage =
  | "admission"
  | "queue"
  | "write"
  | "acknowledgement"
  | "verification";

export interface AutomationBridgeError {
  readonly version: 1;
  readonly name: "JetKvmAutomationError";
  readonly code: AutomationBridgeErrorCode;
  readonly stage: AutomationBridgeStage;
  readonly outcome: "not_sent" | "unknown";
  readonly operation_id: string | null;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly display_generation: number | null;
  readonly dispatch_generation: number | null;
  readonly write_began: boolean;
  readonly acknowledged: boolean;
  readonly dispatched_count: number;
  readonly completed_count: number;
  readonly message: string;
}

export interface JetKvmAutomationV1 {
  readonly version: 1;
  snapshot(): AutomationSnapshot;
  cancel(operationId: string): boolean;
  capture(request: CaptureBridgeRequest): Promise<CaptureBridgeResult>;
  mouse(request: MouseBridgeRequest): Promise<MutationBridgeReceipt>;
  keyboard(request: KeyboardBridgeRequest): Promise<KeyboardBridgeReceipt>;
  paste(request: PasteBridgeRequest): Promise<PasteBridgeReceipt>;
  release(request: ReleaseBridgeRequest): Promise<ReleaseBridgeReceipt>;
  readVideoState(request: ReadBridgeRequest): Promise<ReadBridgeResult>;
  readEdid(request: ReadBridgeRequest): Promise<ReadBridgeResult>;
  performAtx(request: AtxBridgeRequest): Promise<ReadBridgeResult>;
}

declare global {
  interface Window {
    __JETKVM_AUTOMATION__?: JetKvmAutomationV1;
  }
}
