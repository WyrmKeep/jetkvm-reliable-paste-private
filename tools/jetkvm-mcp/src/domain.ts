import type { ErrorCode, ErrorPhase, RequiredNextStep } from "./errors.js";

export const JETKVM_TOOL_NAMES = [
  "jetkvm_display_capture",
  "jetkvm_display_status",
  "jetkvm_input_keyboard",
  "jetkvm_input_mouse",
  "jetkvm_input_paste",
  "jetkvm_input_release",
  "jetkvm_power_control",
  "jetkvm_session_connect",
  "jetkvm_session_reconnect",
  "jetkvm_session_status",
] as const;
export type JetKvmToolName = (typeof JETKVM_TOOL_NAMES)[number];

export const PERMISSION_NAMES = [
  "session.connect",
  "session.status",
  "session.reconnect",
  "session.takeover",
  "display.capture",
  "display.status",
  "input.mouse",
  "input.keyboard",
  "input.paste",
  "input.release",
  "power.control",
] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const CAPABILITY_NAMES = [
  "session_status",
  "display_capture",
  "display_status",
  "mouse",
  "absolute_pointer",
  "keyboard",
  "reliable_paste",
  "input_release",
  "power_control",
  "edid_read",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilitySnapshot = Record<CapabilityName, boolean>;

export type MutationOutcome =
  | "applied"
  | "already_applied"
  | "not_sent"
  | "unknown";
export type Verification = "device_state_verified" | "device_ack_only" | "none";

export type MutationState = {
  request_id: string;
  outcome: MutationOutcome;
  verification: Verification;
  safe_to_retry: boolean;
  required_next_step: RequiredNextStep;
};

export type Success<T> = {
  ok: true;
  tool: JetKvmToolName;
  operation_id: string;
  session_id: string;
  session_generation: number;
  duration_ms: number;
  result: T;
};

export type ToolErrorDetails = {
  permission: PermissionName | null;
  capability: CapabilityName | null;
  failed_action_index: number | null;
  dispatched_action_count: number | null;
  completed_action_count: number | null;
  downstream_stage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
  expected_generation: number | null;
  actual_generation: number | null;
  observation_id: string | null;
};

export type ToolError = {
  ok: false;
  tool: JetKvmToolName;
  operation_id: string;
  session_id: string | null;
  session_generation: number | null;
  duration_ms: number;
  error: {
    code: ErrorCode;
    message: string;
    phase: ErrorPhase;
    outcome: MutationOutcome | null;
    verification: Verification;
    safe_to_retry: boolean;
    required_next_step: RequiredNextStep;
    details: ToolErrorDetails;
  };
};

export type ObservedFact<T> = {
  value: T;
  observed_at: string | null;
  age_ms: number | null;
  freshness: "fresh" | "stale" | "unknown";
  source: "cached_snapshot" | "cached_event" | "none";
};

export type SessionConnectInput = {
  request_id: string;
  takeover?: boolean;
  timeout_ms: number;
};
export type SessionConnectResult = MutationState & {
  state: "ready";
  connection_epoch: number;
  display_generation: number;
  takeover_performed: boolean;
  fresh_capture_required: true;
  permissions: PermissionName[];
  capabilities: CapabilitySnapshot;
};

export type SessionStatusInput = {
  session_id: string;
  session_generation: number;
  timeout_ms: number;
};
export type SessionStatusResult = {
  state:
    | "connecting"
    | "ready"
    | "degraded"
    | "drained"
    | "taken_over"
    | "closing"
    | "failed";
  connection_epoch: number;
  display_generation: number;
  dispatch_generation: number;
  browser_channel_generation: number | null;
  device_reachable: boolean | null;
  setup_state: "complete" | "required" | "unknown";
  auth_mode: "password" | "no_password" | "unknown";
  rpc_reachability: "reachable" | "unreachable" | "unknown";
  native_process: "available" | "unavailable" | "restarting" | "unknown";
  web_rtc: "connecting" | "connected" | "disconnected" | "failed" | "unknown";
  hid: "ready" | "not_ready" | "unknown";
  decoded_video: "ready" | "stalled" | "unavailable" | "unknown";
  native_capture_facts: {
    signal: ObservedFact<
      "present" | "no_signal" | "no_lock" | "out_of_range" | "unknown"
    >;
    resolution: ObservedFact<{ width: number; height: number } | null>;
    fps: ObservedFact<number | null>;
  };
  active_mutation: boolean;
  fresh_capture_required: boolean;
  permissions: PermissionName[];
  capabilities: CapabilitySnapshot;
  blocked_reason: string | null;
  versions: {
    server: string;
    protocol: string;
    ui_contract: string | null;
    firmware: string | null;
  };
};

export type SessionReconnectInput = {
  session_id: string;
  session_generation: number;
  request_id: string;
  takeover?: boolean;
  timeout_ms: number;
};
export type SessionReconnectResult = MutationState & {
  previous_session_generation: number;
  new_session_generation: number;
  connection_epoch: number;
  state: "ready";
  takeover_performed: boolean;
  fresh_capture_required: true;
};

export type DisplayCaptureInput = {
  session_id: string;
  session_generation: number;
  format?: "jpeg" | "png";
  max_width?: number;
  max_height?: number;
  timeout_ms: number;
};
export type DisplayCaptureResult = {
  observation_id: string;
  connection_epoch: number;
  display_generation: number;
  frame_id: string;
  captured_at: string;
  source_width: number;
  source_height: number;
  image_width: number;
  image_height: number;
  rotation: 0 | 90 | 180 | 270;
  geometry: {
    content_x: number;
    content_y: number;
    content_width: number;
    content_height: number;
  };
  image: {
    content_index: number;
    mime_type: "image/jpeg" | "image/png";
    sha256: string;
    byte_length: number;
  };
};

export type DisplayStatusInput = {
  session_id: string;
  session_generation: number;
  timeout_ms: number;
};
export type EdidResult =
  | {
      status: "unsupported";
      read_completed: false;
      reason: "edid_read_capability_absent";
      observed_at: null;
      data: null;
    }
  | {
      status: "unavailable";
      read_completed: true;
      reason: "successful_read_reported_no_edid";
      observed_at: string;
      data: null;
    }
  | {
      status: "available";
      read_completed: true;
      reason: null;
      observed_at: string;
      data: {
        sha256: string;
        manufacturer_id: string | null;
        product_code: number | null;
        serial_number: string | null;
        display_name: string | null;
        preferred_resolution: {
          width: number;
          height: number;
          refresh_hz: number | null;
        } | null;
      };
    };
export type DisplayStatusResult = {
  signal: ObservedFact<
    "present" | "no_signal" | "no_lock" | "out_of_range" | "unknown"
  >;
  native_resolution: ObservedFact<{
    width: number;
    height: number;
    refresh_hz: number | null;
  } | null>;
  fps: ObservedFact<number | null>;
  edid: EdidResult;
};

export type Point = { x: number; y: number };
export type MouseButton = "left" | "middle" | "right";
export type MouseAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button: MouseButton }
  | { type: "double_click"; x: number; y: number; button: MouseButton }
  | { type: "drag"; button: MouseButton; path: Point[] }
  | { type: "scroll"; x: number; y: number; delta_y: number; delta_x?: 0 };
export type InputMouseInput = {
  session_id: string;
  session_generation: number;
  observation_id: string;
  request_id: string;
  actions: MouseAction[];
  timeout_ms: number;
};
export type InputMouseResult = MutationState & {
  dispatched_action_count: number;
  completed_action_count: number;
  post_capture: DisplayCaptureResult | null;
};

export const PHYSICAL_KEYS = [
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "Escape",
  "Tab",
  "CapsLock",
  "Space",
  "Enter",
  "Backspace",
  "Insert",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "NumLock",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "ContextMenu",
] as const;
export type PhysicalKey = (typeof PHYSICAL_KEYS)[number];
export type KeyboardAction =
  | { type: "key_down"; key: PhysicalKey }
  | { type: "key_up"; key: PhysicalKey }
  | { type: "key_press"; key: PhysicalKey }
  | { type: "chord"; keys: PhysicalKey[] };
export type InputKeyboardInput = {
  session_id: string;
  session_generation: number;
  observation_id: string;
  request_id: string;
  actions: KeyboardAction[];
  timeout_ms: number;
};
export type InputKeyboardResult = MutationState & {
  dispatched_action_count: number;
  completed_action_count: number;
  held_keys: PhysicalKey[];
  post_capture: DisplayCaptureResult | null;
};

export type InputPasteInput = {
  session_id: string;
  session_generation: number;
  observation_id: string;
  request_id: string;
  text: string;
  timeout_ms: number;
};
export type InputPasteResult = MutationState & {
  original_byte_count: number;
  normalized_byte_count: number;
  normalized_sha256: string;
  accepted_at: string | null;
  completed_at: string | null;
  terminal_state: "succeeded" | "failed" | "cancelled" | "unknown";
  measured_chars_per_second: number | null;
  post_capture: DisplayCaptureResult | null;
};

export type InputReleaseInput = {
  session_id: string;
  session_generation: number;
  request_id: string;
  timeout_ms: number;
};
export type InputReleaseResult = MutationState & {
  mutation_gate_closed: boolean;
  deferred_producers_joined: boolean;
  paste_terminal: "cancelled" | "inactive" | "unknown";
  ordinary_leases_zero: boolean | null;
  keyboard_zero: boolean | null;
  pointer_zero: boolean | null;
  generation_drained: boolean;
};

export type PowerAction = "press_power" | "hold_power" | "press_reset";
export type PowerControlInput = {
  session_id: string;
  session_generation: number;
  request_id: string;
  action: PowerAction;
  timeout_ms: number;
};
export type PowerControlResult = MutationState & {
  action: PowerAction;
  wire_action: "power-short" | "power-long" | "reset";
  fixed_press_ms: 200 | 5000;
  serial_sequence_completed: boolean;
  atx_led_observation: {
    power: boolean | null;
    hdd: boolean | null;
    observed_at: string | null;
    freshness: "fresh" | "stale" | "unknown";
  };
};

export type ToolInputByName = {
  jetkvm_display_capture: DisplayCaptureInput;
  jetkvm_display_status: DisplayStatusInput;
  jetkvm_input_keyboard: InputKeyboardInput;
  jetkvm_input_mouse: InputMouseInput;
  jetkvm_input_paste: InputPasteInput;
  jetkvm_input_release: InputReleaseInput;
  jetkvm_power_control: PowerControlInput;
  jetkvm_session_connect: SessionConnectInput;
  jetkvm_session_reconnect: SessionReconnectInput;
  jetkvm_session_status: SessionStatusInput;
};

export type ToolResultByName = {
  jetkvm_display_capture: DisplayCaptureResult;
  jetkvm_display_status: DisplayStatusResult;
  jetkvm_input_keyboard: InputKeyboardResult;
  jetkvm_input_mouse: InputMouseResult;
  jetkvm_input_paste: InputPasteResult;
  jetkvm_input_release: InputReleaseResult;
  jetkvm_power_control: PowerControlResult;
  jetkvm_session_connect: SessionConnectResult;
  jetkvm_session_reconnect: SessionReconnectResult;
  jetkvm_session_status: SessionStatusResult;
};
