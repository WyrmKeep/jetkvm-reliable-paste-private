import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  type CapabilitySnapshot,
  type JetKvmToolName,
} from "../domain.js";
import { ERROR_CODES, type ErrorCode } from "../errors.js";

import {
  SCHEMA_FILE_NAMES,
  TOOL_INPUT_SCHEMAS,
  TOOL_RESULT_PAYLOAD_SCHEMAS,
  TOOL_RESULT_SCHEMAS,
  generateJsonSchemaDocuments,
  mutationStateSchema,
  successEnvelopeSchema,
  toolErrorSchema,
} from "./schemas.js";

const capabilities = Object.fromEntries(
  CAPABILITY_NAMES.map((name) => [name, true]),
) as unknown as CapabilitySnapshot;
const observedUnknown = {
  value: null,
  observed_at: null,
  age_ms: null,
  freshness: "unknown",
  source: "none",
} as const;
const captureResult = {
  observation_id: "observation-1",
  connection_epoch: 1,
  display_generation: 2,
  frame_id: "frame-1",
  captured_at: "2026-07-13T00:00:00.000Z",
  source_width: 1920,
  source_height: 1080,
  image_width: 1280,
  image_height: 720,
  rotation: 0,
  geometry: {
    content_x: 0,
    content_y: 0,
    content_width: 1280,
    content_height: 720,
  },
  image: {
    content_index: 1,
    mime_type: "image/jpeg",
    sha256: "a".repeat(64),
    byte_length: 4,
  },
} as const;
const mutation = {
  request_id: "request-1",
  outcome: "applied",
  verification: "device_ack_only",
  safe_to_retry: false,
  required_next_step: "none",
} as const;

const validInputs: Record<JetKvmToolName, unknown> = {
  jetkvm_display_capture: {
    session_id: "session-1",
    session_generation: 1,
    timeout_ms: 1_000,
  },
  jetkvm_display_status: {
    session_id: "session-1",
    session_generation: 1,
    timeout_ms: 1_000,
  },
  jetkvm_input_keyboard: {
    session_id: "session-1",
    session_generation: 1,
    observation_id: "observation-1",
    request_id: "request-1",
    actions: [{ type: "chord", keys: ["ControlLeft", "KeyC"] }],
    timeout_ms: 1_000,
  },
  jetkvm_input_mouse: {
    session_id: "session-1",
    session_generation: 1,
    observation_id: "observation-1",
    request_id: "request-1",
    actions: [{ type: "scroll", x: 0, y: 0, delta_y: -1 }],
    timeout_ms: 1_000,
  },
  jetkvm_input_paste: {
    session_id: "session-1",
    session_generation: 1,
    observation_id: "observation-1",
    request_id: "request-1",
    text: "hello",
    timeout_ms: 1_000,
  },
  jetkvm_input_release: {
    session_id: "session-1",
    session_generation: 1,
    request_id: "request-1",
    timeout_ms: 1_000,
  },
  jetkvm_power_control: {
    session_id: "session-1",
    session_generation: 1,
    request_id: "request-1",
    action: "press_power",
    timeout_ms: 1_000,
  },
  jetkvm_session_connect: {
    request_id: "request-1",
    timeout_ms: 1_000,
  },
  jetkvm_session_reconnect: {
    session_id: "session-1",
    session_generation: 1,
    request_id: "request-1",
    timeout_ms: 1_000,
  },
  jetkvm_session_status: {
    session_id: "session-1",
    session_generation: 1,
    timeout_ms: 1_000,
  },
};

const validPayloads: Record<JetKvmToolName, unknown> = {
  jetkvm_display_capture: captureResult,
  jetkvm_display_status: {
    signal: { ...observedUnknown, value: "unknown" },
    native_resolution: observedUnknown,
    fps: observedUnknown,
    edid: {
      status: "unsupported",
      read_completed: false,
      reason: "edid_read_capability_absent",
      observed_at: null,
      data: null,
    },
  },
  jetkvm_input_keyboard: {
    ...mutation,
    dispatched_action_count: 1,
    completed_action_count: 1,
    held_keys: [],
    post_capture: captureResult,
  },
  jetkvm_input_mouse: {
    ...mutation,
    dispatched_action_count: 1,
    completed_action_count: 1,
    post_capture: captureResult,
  },
  jetkvm_input_paste: {
    ...mutation,
    original_byte_count: 5,
    normalized_byte_count: 5,
    normalized_sha256: "b".repeat(64),
    accepted_at: "2026-07-13T00:00:00.000Z",
    completed_at: "2026-07-13T00:00:01.000Z",
    terminal_state: "succeeded",
    measured_chars_per_second: 91,
    post_capture: captureResult,
  },
  jetkvm_input_release: {
    ...mutation,
    verification: "device_state_verified",
    mutation_gate_closed: true,
    deferred_producers_joined: true,
    paste_terminal: "inactive",
    ordinary_leases_zero: true,
    keyboard_zero: true,
    pointer_zero: true,
    generation_drained: true,
  },
  jetkvm_power_control: {
    ...mutation,
    action: "press_power",
    wire_action: "power-short",
    fixed_press_ms: 200,
    serial_sequence_completed: true,
    atx_led_observation: {
      power: null,
      hdd: null,
      observed_at: null,
      freshness: "unknown",
    },
  },
  jetkvm_session_connect: {
    ...mutation,
    state: "ready",
    connection_epoch: 1,
    display_generation: 2,
    takeover_performed: false,
    fresh_capture_required: true,
    permissions: ["session.connect"],
    capabilities,
  },
  jetkvm_session_reconnect: {
    ...mutation,
    previous_session_generation: 1,
    new_session_generation: 2,
    connection_epoch: 2,
    state: "ready",
    takeover_performed: false,
    fresh_capture_required: true,
  },
  jetkvm_session_status: {
    state: "ready",
    connection_epoch: 1,
    display_generation: 2,
    dispatch_generation: 3,
    browser_channel_generation: 1,
    device_reachable: true,
    setup_state: "complete",
    auth_mode: "password",
    rpc_reachability: "reachable",
    native_process: "available",
    web_rtc: "connected",
    hid: "ready",
    decoded_video: "ready",
    native_capture_facts: {
      signal: { ...observedUnknown, value: "unknown" },
      resolution: observedUnknown,
      fps: observedUnknown,
    },
    active_mutation: false,
    fresh_capture_required: false,
    permissions: ["session.status"],
    capabilities,
    blocked_reason: null,
    versions: {
      server: "1.0.0",
      protocol: "1",
      ui_contract: null,
      firmware: null,
    },
  },
};

function successEnvelope(
  tool: JetKvmToolName,
  result: unknown,
): Record<string, unknown> {
  return {
    ok: true,
    tool,
    operation_id: "operation-1",
    session_id: "session-1",
    session_generation: tool === "jetkvm_session_reconnect" ? 2 : 1,
    duration_ms: 5,
    result,
  };
}

describe("strict canonical tool schemas", () => {
  it("parses all ten exact inputs and rejects unknown root fields", () => {
    expect(Object.keys(TOOL_INPUT_SCHEMAS)).toEqual(JETKVM_TOOL_NAMES);
    for (const tool of JETKVM_TOOL_NAMES) {
      expect(
        TOOL_INPUT_SCHEMAS[tool].safeParse(validInputs[tool]).success,
      ).toBe(true);
      expect(
        TOOL_INPUT_SCHEMAS[tool].safeParse({
          ...(validInputs[tool] as object),
          unexpected: true,
        }).success,
      ).toBe(false);
    }
  });

  it("requires timeout_ms and enforces every canonical timeout bound", () => {
    const limits: Record<JetKvmToolName, readonly [number, number]> = {
      jetkvm_display_capture: [100, 60_000],
      jetkvm_display_status: [100, 30_000],
      jetkvm_input_keyboard: [100, 60_000],
      jetkvm_input_mouse: [100, 60_000],
      jetkvm_input_paste: [100, 300_000],
      jetkvm_input_release: [100, 60_000],
      jetkvm_power_control: [100, 60_000],
      jetkvm_session_connect: [100, 60_000],
      jetkvm_session_reconnect: [100, 60_000],
      jetkvm_session_status: [100, 30_000],
    };

    for (const tool of JETKVM_TOOL_NAMES) {
      const schema = TOOL_INPUT_SCHEMAS[tool];
      const input = validInputs[tool] as Record<string, unknown>;
      const [minimum, maximum] = limits[tool];
      const { timeout_ms: _removed, ...withoutTimeout } = input;
      expect(schema.safeParse(withoutTimeout).success).toBe(false);
      expect(schema.safeParse({ ...input, timeout_ms: minimum }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...input, timeout_ms: maximum }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({ ...input, timeout_ms: minimum - 1 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...input, timeout_ms: maximum + 1 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...input, timeout_ms: minimum + 0.5 }).success,
      ).toBe(false);
    }
  });

  it("defaults only canonical optional input fields", () => {
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_session_connect.parse(
        validInputs.jetkvm_session_connect,
      ),
    ).toEqual({
      request_id: "request-1",
      takeover: false,
      timeout_ms: 1_000,
    });
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_session_reconnect.parse(
        validInputs.jetkvm_session_reconnect,
      ),
    ).toMatchObject({
      takeover: false,
    });
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_display_capture.parse(
        validInputs.jetkvm_display_capture,
      ),
    ).toMatchObject({
      format: "jpeg",
      max_width: 1280,
      max_height: 720,
    });
  });

  it("rejects target, authentication, mode, lease, timing, and alias fields", () => {
    const forbidden = [
      "target",
      "url",
      "credential",
      "token",
      "password",
      "mode",
      "lease",
      "idempotency_key",
      "duration_ms",
      "delay_ms",
      "repeat",
      "sequence",
    ];
    for (const field of forbidden) {
      expect(
        TOOL_INPUT_SCHEMAS.jetkvm_session_connect.safeParse({
          ...(validInputs.jetkvm_session_connect as object),
          [field]: "forbidden",
        }).success,
      ).toBe(false);
      expect(
        TOOL_INPUT_SCHEMAS.jetkvm_power_control.safeParse({
          ...(validInputs.jetkvm_power_control as object),
          [field]: "forbidden",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only canonical physical keyboard actions and bounds", () => {
    const schema = TOOL_INPUT_SCHEMAS.jetkvm_input_keyboard;
    const input = validInputs.jetkvm_input_keyboard as Record<string, unknown>;
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "key_down", key: "KeyA" }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...input, actions: [{ type: "key_up", key: "F12" }] })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "key_press", key: "NumpadEnter" }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "type", text: "secret" }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "keypress", keys: ["A"] }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, actions: [{ type: "key_press", key: "a" }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, actions: [{ type: "chord", keys: [] }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "chord", keys: Array(9).fill("KeyA") }],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...input, actions: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: Array(65).fill({ type: "key_press", key: "KeyA" }),
      }).success,
    ).toBe(false);
  });

  it("enforces mouse action, drag, scroll, and whole-request structural bounds", () => {
    const schema = TOOL_INPUT_SCHEMAS.jetkvm_input_mouse;
    const input = validInputs.jetkvm_input_mouse as Record<string, unknown>;
    for (const delta_y of [-127, -1, 1, 127]) {
      expect(
        schema.safeParse({
          ...input,
          actions: [{ type: "scroll", x: 0, y: 0, delta_y }],
        }).success,
      ).toBe(true);
    }
    for (const delta_y of [-128, 0, 128, 1.5]) {
      expect(
        schema.safeParse({
          ...input,
          actions: [{ type: "scroll", x: 0, y: 0, delta_y }],
        }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "scroll", x: 0, y: 0, delta_y: 1, delta_x: 1 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: [{ type: "drag", button: "left", path: [{ x: 0, y: 0 }] }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: [
          {
            type: "drag",
            button: "left",
            path: Array(65).fill({ x: 0, y: 0 }),
          },
        ],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...input, actions: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        actions: Array(17).fill({ type: "move", x: 0, y: 0 }),
      }).success,
    ).toBe(false);
  });

  it("enforces opaque IDs and normalized paste UTF-8 byte bounds", () => {
    const connect = validInputs.jetkvm_session_connect as Record<
      string,
      unknown
    >;
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_session_connect.safeParse({
        ...connect,
        request_id: "bad id",
      }).success,
    ).toBe(false);
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_session_connect.safeParse({
        ...connect,
        request_id: "a".repeat(129),
      }).success,
    ).toBe(false);
    const paste = validInputs.jetkvm_input_paste as Record<string, unknown>;
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_input_paste.safeParse({ ...paste, text: "" })
        .success,
    ).toBe(false);
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_input_paste.safeParse({
        ...paste,
        text: "a".repeat(262_144),
      }).success,
    ).toBe(true);
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_input_paste.safeParse({
        ...paste,
        text: "é".repeat(131_073),
      }).success,
    ).toBe(false);
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_input_paste.safeParse({
        ...paste,
        text: "\uFEFF",
      }).success,
    ).toBe(false);
    expect(
      TOOL_INPUT_SCHEMAS.jetkvm_input_paste.safeParse({
        ...paste,
        text: `\uFEFF${"\r\n".repeat(131_072)}`,
      }).success,
    ).toBe(true);
  });

  it("accepts documented non-negative result dimensions and counts", () => {
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
        ...captureResult,
        source_width: 0,
        source_height: 0,
        image_width: 0,
        image_height: 0,
        geometry: {
          content_x: 0,
          content_y: 0,
          content_width: 0,
          content_height: 0,
        },
        image: { ...captureResult.image, byte_length: 0 },
      }).success,
    ).toBe(true);
  });

  it("accepts exactly the three semantic power actions", () => {
    const schema = TOOL_INPUT_SCHEMAS.jetkvm_power_control;
    const input = validInputs.jetkvm_power_control as Record<string, unknown>;
    for (const action of ["press_power", "hold_power", "press_reset"]) {
      expect(schema.safeParse({ ...input, action }).success).toBe(true);
    }
    for (const action of [
      "power-short",
      "power-long",
      "reset",
      "reboot",
      "off",
    ]) {
      expect(schema.safeParse({ ...input, action }).success).toBe(false);
    }
  });

  it("enforces every mutation outcome/verification/retry/next-step combination", () => {
    const outcomes = [
      "applied",
      "already_applied",
      "not_sent",
      "unknown",
    ] as const;
    const verifications = [
      "device_state_verified",
      "device_ack_only",
      "none",
    ] as const;
    const retryValues = [false, true] as const;
    const nextSteps = [
      "none",
      "capture_then_retry",
      "reconnect_then_capture",
      "release_then_reconnect_then_capture",
      "inspect_device_state_before_retry",
      "wait_or_request_takeover",
      "grant_permission",
      "enable_capability",
    ] as const;

    for (const outcome of outcomes) {
      for (const verification of verifications) {
        for (const safe_to_retry of retryValues) {
          for (const required_next_step of nextSteps) {
            const isDefinitive =
              outcome === "applied" || outcome === "already_applied";
            const legal = isDefinitive
              ? verification !== "none" &&
                !safe_to_retry &&
                required_next_step === "none"
              : outcome === "unknown"
                ? verification === "none" &&
                  !safe_to_retry &&
                  (required_next_step === "inspect_device_state_before_retry" ||
                    required_next_step ===
                      "release_then_reconnect_then_capture")
                : verification === "none" &&
                  required_next_step !== "inspect_device_state_before_retry" &&
                  required_next_step !== "release_then_reconnect_then_capture";
            expect(
              mutationStateSchema.safeParse({
                request_id: "request-1",
                outcome,
                verification,
                safe_to_retry,
                required_next_step,
              }).success,
              JSON.stringify({
                outcome,
                verification,
                safe_to_retry,
                required_next_step,
              }),
            ).toBe(legal);
          }
        }
      }
    }
  });

  it("enforces the exhaustive mutation error code-class table", () => {
    type Policy = {
      readonly phase:
        | "validate"
        | "authorize"
        | "queue"
        | "connect"
        | "execute"
        | "verify"
        | "cleanup";
      readonly outcome: "applied" | "already_applied" | "not_sent" | "unknown";
      readonly verification:
        | "device_state_verified"
        | "device_ack_only"
        | "none";
      readonly safe_to_retry: boolean;
      readonly required_next_step:
        | "none"
        | "capture_then_retry"
        | "reconnect_then_capture"
        | "release_then_reconnect_then_capture"
        | "inspect_device_state_before_retry"
        | "wait_or_request_takeover"
        | "grant_permission"
        | "enable_capability";
      readonly downstream_stage:
        | "none"
        | "admission"
        | "write"
        | "acknowledgement"
        | "verification";
    };
    const applied = {
      phase: "verify",
      outcome: "applied",
      verification: "device_ack_only",
      safe_to_retry: false,
      required_next_step: "none",
      downstream_stage: "verification",
    } as const satisfies Policy;
    const unknown = {
      phase: "execute",
      outcome: "unknown",
      verification: "none",
      safe_to_retry: false,
      required_next_step: "inspect_device_state_before_retry",
      downstream_stage: "write",
    } as const satisfies Policy;
    const releaseUnknown = {
      ...unknown,
      required_next_step: "release_then_reconnect_then_capture",
    } as const satisfies Policy;
    const notSent = {
      phase: "validate",
      outcome: "not_sent",
      verification: "none",
      safe_to_retry: false,
      required_next_step: "none",
      downstream_stage: "none",
    } as const satisfies Policy;
    const retryableNotSent = {
      ...notSent,
      safe_to_retry: true,
    } as const satisfies Policy;
    const policies = {
      CONFIG_INVALID: [notSent],
      AUTH_FAILED: [
        { ...notSent, phase: "connect", downstream_stage: "admission" },
      ],
      AUTH_RATE_LIMITED: [
        {
          ...retryableNotSent,
          phase: "connect",
          downstream_stage: "admission",
        },
      ],
      AUTH_EXPIRED: [
        { ...notSent, phase: "connect", downstream_stage: "admission" },
      ],
      PERMISSION_DENIED: [
        {
          ...notSent,
          phase: "authorize",
          required_next_step: "grant_permission",
        },
      ],
      OBSERVE_ONLY: [{ ...notSent, phase: "authorize" }],
      SAFETY_DENIED: [{ ...notSent, phase: "authorize" }],
      CAPABILITY_MISSING: [
        { ...notSent, required_next_step: "enable_capability" },
      ],
      UNSUPPORTED_UI_VERSION: [
        { ...notSent, phase: "connect", downstream_stage: "admission" },
      ],
      FIRMWARE_INCOMPATIBLE: [
        { ...notSent, phase: "connect", downstream_stage: "admission" },
      ],
      BROWSER_UNSUPPORTED: [
        { ...notSent, phase: "connect", downstream_stage: "admission" },
      ],
      SESSION_NOT_FOUND: [
        {
          ...notSent,
          required_next_step: "reconnect_then_capture",
          downstream_stage: "admission",
        },
      ],
      STALE_SESSION_GENERATION: [
        {
          ...notSent,
          required_next_step: "reconnect_then_capture",
          downstream_stage: "admission",
        },
      ],
      SESSION_TAKEN_OVER: [
        {
          ...notSent,
          phase: "execute",
          required_next_step: "reconnect_then_capture",
          downstream_stage: "admission",
        },
        releaseUnknown,
      ],
      CONTROL_BUSY: [
        {
          ...retryableNotSent,
          phase: "authorize",
          required_next_step: "wait_or_request_takeover",
          downstream_stage: "admission",
        },
      ],
      SESSION_DRAINED: [
        {
          ...notSent,
          phase: "execute",
          required_next_step: "reconnect_then_capture",
          downstream_stage: "admission",
        },
        releaseUnknown,
      ],
      DEVICE_UNREACHABLE: [
        {
          ...retryableNotSent,
          phase: "connect",
          downstream_stage: "admission",
        },
      ],
      CONNECTION_LOST: [
        {
          ...retryableNotSent,
          phase: "execute",
          required_next_step: "reconnect_then_capture",
          downstream_stage: "write",
        },
        unknown,
      ],
      DOWNSTREAM_MALFORMED_RESPONSE: [
        {
          ...notSent,
          phase: "execute",
          required_next_step: "reconnect_then_capture",
          downstream_stage: "write",
        },
        unknown,
      ],
      VIDEO_UNAVAILABLE: [
        { ...retryableNotSent, required_next_step: "capture_then_retry" },
      ],
      VIDEO_STALLED: [
        { ...retryableNotSent, required_next_step: "capture_then_retry" },
      ],
      FRAME_TIMEOUT: [],
      STALE_OBSERVATION: [
        {
          ...retryableNotSent,
          required_next_step: "capture_then_retry",
        },
      ],
      OBSERVATION_CONSUMED: [
        {
          ...retryableNotSent,
          required_next_step: "capture_then_retry",
        },
      ],
      DISPLAY_CHANGED: [
        {
          ...retryableNotSent,
          required_next_step: "capture_then_retry",
        },
        releaseUnknown,
      ],
      EDID_READ_FAILED: [],
      DISPLAY_STATUS_STALE: [],
      INVALID_COORDINATE: [notSent],
      INVALID_KEY: [notSent],
      UNSUPPORTED_SCROLL_AXIS: [notSent],
      PASTE_BUSY: [{ ...retryableNotSent, phase: "queue" }],
      PASTE_REJECTED: [{ ...notSent, phase: "execute" }],
      PASTE_FAILED: [releaseUnknown],
      PASTE_CANCELLED: [releaseUnknown],
      EVENT_GAP: [releaseUnknown],
      POWER_ACTION_REJECTED: [{ ...notSent, phase: "execute" }],
      ATX_EXTENSION_INACTIVE: [notSent],
      ATX_SERIAL_UNAVAILABLE: [
        {
          ...retryableNotSent,
          phase: "execute",
          downstream_stage: "write",
        },
        unknown,
      ],
      ATX_BUSY: [{ ...retryableNotSent, phase: "queue" }],
      POWER_STATE_UNVERIFIED: [
        applied,
        { ...applied, outcome: "already_applied" },
      ],
      CANCELLED: [{ ...retryableNotSent, phase: "queue" }, unknown],
      DEADLINE_EXCEEDED: [{ ...retryableNotSent, phase: "queue" }, unknown],
      ADMISSION_CAPACITY_EXCEEDED: [{ ...retryableNotSent, phase: "queue" }],
      MUTATION_OUTCOME_UNKNOWN: [unknown],
      PARTIAL_VERIFICATION: [
        applied,
        { ...applied, outcome: "already_applied" },
      ],
      REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT: [notSent],
    } as const satisfies Record<ErrorCode, readonly Policy[]>;

    const toolsByCode: Partial<Record<ErrorCode, JetKvmToolName>> = {
      SESSION_NOT_FOUND: "jetkvm_session_reconnect",
      STALE_SESSION_GENERATION: "jetkvm_session_reconnect",
      SESSION_TAKEN_OVER: "jetkvm_session_reconnect",
      CONTROL_BUSY: "jetkvm_session_connect",
      SESSION_DRAINED: "jetkvm_session_reconnect",
      INVALID_KEY: "jetkvm_input_keyboard",
      PASTE_BUSY: "jetkvm_input_paste",
      PASTE_REJECTED: "jetkvm_input_paste",
      PASTE_FAILED: "jetkvm_input_paste",
      PASTE_CANCELLED: "jetkvm_input_paste",
      EVENT_GAP: "jetkvm_input_paste",
      POWER_ACTION_REJECTED: "jetkvm_power_control",
      ATX_EXTENSION_INACTIVE: "jetkvm_power_control",
      ATX_SERIAL_UNAVAILABLE: "jetkvm_power_control",
      ATX_BUSY: "jetkvm_power_control",
      POWER_STATE_UNVERIFIED: "jetkvm_power_control",
    };

    const candidate = (code: ErrorCode, policy: Policy) => ({
      ok: false,
      tool: toolsByCode[code] ?? "jetkvm_input_mouse",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code,
        message: "Canonical public error.",
        phase: policy.phase,
        outcome: policy.outcome,
        verification: policy.verification,
        safe_to_retry: policy.safe_to_retry,
        required_next_step: policy.required_next_step,
        details: {
          permission:
            code === "PERMISSION_DENIED" ? ("input.mouse" as const) : null,
          capability: code === "CAPABILITY_MISSING" ? ("mouse" as const) : null,
          failed_action_index: policy.outcome === "unknown" ? 0 : null,
          dispatched_action_count: policy.outcome === "not_sent" ? null : 1,
          completed_action_count:
            policy.outcome === "unknown"
              ? 0
              : policy.outcome === "not_sent"
                ? null
                : 1,
          downstream_stage: policy.downstream_stage,
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    });
    const outcomes = [
      "applied",
      "already_applied",
      "not_sent",
      "unknown",
    ] as const;

    expect(Object.keys(policies).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const allowed = policies[code];
      for (const policy of allowed) {
        expect(
          toolErrorSchema.safeParse(candidate(code, policy)).success,
          `${code} ${JSON.stringify(policy)}`,
        ).toBe(true);
        const valid = candidate(code, policy);
        const invalidErrors = [
          {
            ...valid.error,
            verification:
              policy.verification === "none" ? "device_ack_only" : "none",
          },
          { ...valid.error, safe_to_retry: !policy.safe_to_retry },
          {
            ...valid.error,
            required_next_step:
              policy.required_next_step === "none"
                ? "grant_permission"
                : "none",
          },
        ];
        if (policy.outcome === "not_sent") {
          invalidErrors.push({
            ...valid.error,
            details: {
              ...valid.error.details,
              dispatched_action_count: 1,
            },
          });
        }
        for (const error of invalidErrors) {
          expect(
            toolErrorSchema.safeParse({ ...valid, error }).success,
            `${code} must reject ${JSON.stringify(error)}`,
          ).toBe(false);
        }
      }
      for (const outcome of outcomes) {
        if (allowed.some((policy) => policy.outcome === outcome)) continue;
        const fallback =
          outcome === "applied" || outcome === "already_applied"
            ? { ...applied, outcome }
            : outcome === "unknown"
              ? unknown
              : notSent;
        expect(
          toolErrorSchema.safeParse(candidate(code, fallback)).success,
          `${code} must reject ${outcome}`,
        ).toBe(false);
      }
    }
    for (const [code, tool] of [
      ["INVALID_KEY", "jetkvm_input_mouse"],
      ["ATX_BUSY", "jetkvm_input_keyboard"],
      ["PASTE_FAILED", "jetkvm_power_control"],
      ["CONTROL_BUSY", "jetkvm_input_mouse"],
      ["STALE_SESSION_GENERATION", "jetkvm_session_connect"],
      ["POWER_STATE_UNVERIFIED", "jetkvm_input_mouse"],
      ["VIDEO_UNAVAILABLE", "jetkvm_power_control"],
    ] as const) {
      const policy = policies[code][0]!;
      expect(
        toolErrorSchema.safeParse({ ...candidate(code, policy), tool }).success,
        `${tool} must reject ${code}`,
      ).toBe(false);
    }
    for (const code of [
      "MUTATION_OUTCOME_UNKNOWN",
      "CONNECTION_LOST",
      "DOWNSTREAM_MALFORMED_RESPONSE",
    ] as const) {
      const policy = policies[code].find(
        ({ outcome }) => outcome === "unknown",
      )!;
      const connectPhase = candidate(code, policy);
      connectPhase.tool = "jetkvm_session_reconnect";
      connectPhase.error.phase = "connect";
      connectPhase.error.details.downstream_stage = "acknowledgement";
      expect(
        toolErrorSchema.safeParse(connectPhase).success,
        `${code} connect/acknowledgement`,
      ).toBe(true);
      expect(
        toolErrorSchema.safeParse({
          ...connectPhase,
          error: {
            ...connectPhase.error,
            details: {
              ...connectPhase.error.details,
              downstream_stage: "admission",
            },
          },
        }).success,
        `${code} unknown cannot be admission-stage`,
      ).toBe(false);
    }

    const malformedNotSent = candidate(
      "DOWNSTREAM_MALFORMED_RESPONSE",
      policies.DOWNSTREAM_MALFORMED_RESPONSE.find(
        ({ outcome }) => outcome === "not_sent",
      )!,
    );
    malformedNotSent.tool = "jetkvm_session_connect";
    malformedNotSent.error.phase = "connect";
    malformedNotSent.error.details.downstream_stage = "admission";
    malformedNotSent.error.required_next_step = "none";
    expect(toolErrorSchema.safeParse(malformedNotSent).success).toBe(true);
  });

  it("uses dedicated compatibility codes for connect and reconnect", () => {
    const compatibilityCodes = [
      "AUTH_FAILED",
      "UNSUPPORTED_UI_VERSION",
      "FIRMWARE_INCOMPATIBLE",
      "BROWSER_UNSUPPORTED",
      "DEVICE_UNREACHABLE",
    ] as const;
    for (const tool of [
      "jetkvm_session_connect",
      "jetkvm_session_reconnect",
    ] as const) {
      for (const code of compatibilityCodes) {
        const error = {
          ok: false,
          tool,
          operation_id: "operation-connect",
          session_id: "session-1",
          session_generation: 1,
          duration_ms: 1,
          error: {
            code,
            message: "The connection is not compatible.",
            phase: "connect",
            outcome: "not_sent",
            verification: "none",
            safe_to_retry: code === "DEVICE_UNREACHABLE",
            required_next_step: "none",
            details: {
              permission: null,
              capability: null,
              failed_action_index: null,
              dispatched_action_count: null,
              completed_action_count: null,
              downstream_stage: "admission",
              expected_generation: null,
              actual_generation: null,
              observation_id: null,
            },
          },
        };
        expect(
          TOOL_RESULT_SCHEMAS[tool].safeParse(error).success,
          `${tool} ${code}`,
        ).toBe(true);
      }

      const unrelatedCapabilityError = {
        ok: false,
        tool,
        operation_id: "operation-connect",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        error: {
          code: "CAPABILITY_MISSING",
          message: "A capability is missing.",
          phase: "validate",
          outcome: "not_sent",
          verification: "none",
          safe_to_retry: false,
          required_next_step: "enable_capability",
          details: {
            permission: null,
            capability: "power_control",
            failed_action_index: null,
            dispatched_action_count: null,
            completed_action_count: null,
            downstream_stage: "none",
            expected_generation: null,
            actual_generation: null,
            observation_id: null,
          },
        },
      };
      expect(
        TOOL_RESULT_SCHEMAS[tool].safeParse(unrelatedCapabilityError).success,
      ).toBe(false);
    }
  });

  it("binds safety-critical error codes to exact mutation recovery claims", () => {
    const base = {
      ok: false as const,
      tool: "jetkvm_input_mouse" as const,
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN" as const,
        message: "The mutation outcome is unknown.",
        phase: "execute" as const,
        outcome: "unknown" as const,
        verification: "none" as const,
        safe_to_retry: false as const,
        required_next_step: "inspect_device_state_before_retry" as const,
        details: {
          permission: null,
          capability: null,
          failed_action_index: 0,
          dispatched_action_count: 1,
          completed_action_count: 0,
          downstream_stage: "write" as const,
          expected_generation: 1,
          actual_generation: null,
          observation_id: "observation-1",
        },
      },
    };
    const legal = [
      base,
      {
        ...base,
        error: {
          ...base.error,
          code: "PARTIAL_VERIFICATION",
          phase: "verify",
          outcome: "applied",
          verification: "device_ack_only",
          required_next_step: "none",
          details: {
            ...base.error.details,
            failed_action_index: null,
            dispatched_action_count: 1,
            completed_action_count: 1,
            downstream_stage: "verification",
          },
        },
      },
      {
        ...base,
        error: {
          ...base.error,
          code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
          phase: "validate",
          outcome: "not_sent",
          verification: "none",
          required_next_step: "none",
          details: {
            ...base.error.details,
            failed_action_index: null,
            dispatched_action_count: null,
            completed_action_count: null,
            downstream_stage: "none",
          },
        },
      },
      {
        ...base,
        tool: "jetkvm_session_connect",
        error: {
          ...base.error,
          code: "CONTROL_BUSY",
          phase: "authorize",
          outcome: "not_sent",
          verification: "none",
          safe_to_retry: true,
          required_next_step: "wait_or_request_takeover",
          details: {
            ...base.error.details,
            failed_action_index: null,
            dispatched_action_count: null,
            completed_action_count: null,
            downstream_stage: "admission",
          },
        },
      },
    ];
    for (const candidate of legal) {
      expect(
        toolErrorSchema.safeParse(candidate).success,
        JSON.stringify(candidate.error),
      ).toBe(true);
    }

    const illegal = [
      { ...base.error, outcome: "not_sent" },
      { ...base.error, safe_to_retry: true },
      { ...base.error, phase: "authorize" },
      {
        ...legal[1]!.error,
        outcome: "unknown",
        verification: "none",
        required_next_step: "inspect_device_state_before_retry",
      },
      { ...legal[1]!.error, phase: "execute" },
      { ...legal[2]!.error, safe_to_retry: true },
      {
        ...legal[2]!.error,
        required_next_step: "capture_then_retry",
      },
      { ...legal[2]!.error, phase: "queue" },
      { ...legal[3]!.error, safe_to_retry: false },
      { ...legal[3]!.error, required_next_step: "none" },
      { ...legal[3]!.error, phase: "queue" },
    ];
    for (const error of illegal) {
      expect(
        toolErrorSchema.safeParse({ ...base, error }).success,
        JSON.stringify(error),
      ).toBe(false);
    }
  });

  it("preserves definitive acknowledgement after failed post-read", () => {
    expect(
      mutationStateSchema.safeParse({
        request_id: "request-1",
        outcome: "applied",
        verification: "device_ack_only",
        safe_to_retry: false,
        required_next_step: "none",
      }).success,
    ).toBe(true);
    expect(
      mutationStateSchema.safeParse({
        request_id: "request-1",
        outcome: "unknown",
        verification: "device_ack_only",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
      }).success,
    ).toBe(false);
  });

  it("validates strict result payloads and exact success envelopes", () => {
    expect(Object.keys(TOOL_RESULT_PAYLOAD_SCHEMAS)).toEqual(JETKVM_TOOL_NAMES);
    expect(Object.keys(TOOL_RESULT_SCHEMAS)).toEqual(JETKVM_TOOL_NAMES);
    for (const tool of JETKVM_TOOL_NAMES) {
      const payload = validPayloads[tool];
      expect(TOOL_RESULT_PAYLOAD_SCHEMAS[tool].safeParse(payload).success).toBe(
        true,
      );
      expect(
        TOOL_RESULT_PAYLOAD_SCHEMAS[tool].safeParse({
          ...(payload as object),
          unexpected: true,
        }).success,
      ).toBe(false);
      expect(
        TOOL_RESULT_SCHEMAS[tool].safeParse(successEnvelope(tool, payload))
          .success,
      ).toBe(true);
      expect(
        TOOL_RESULT_SCHEMAS[tool].safeParse(
          successEnvelope("jetkvm_session_status", payload),
        ).success,
      ).toBe(tool === "jetkvm_session_status");
    }
  });

  it("requires a positive session identity on every success envelope", () => {
    const documents = generateJsonSchemaDocuments();
    const ajv = new Ajv({ strict: false });
    for (const tool of JETKVM_TOOL_NAMES) {
      const envelope = successEnvelope(tool, validPayloads[tool]);
      const validate = ajv.compile(documents[`${tool}.result.schema.json`]!);
      expect(TOOL_RESULT_SCHEMAS[tool].safeParse(envelope).success).toBe(true);
      expect(validate(envelope)).toBe(true);
      for (const invalid of [
        { ...envelope, session_id: null },
        { ...envelope, session_generation: null },
        { ...envelope, session_generation: 0 },
      ]) {
        expect(
          TOOL_RESULT_SCHEMAS[tool].safeParse(invalid).success,
          `runtime ${tool} ${JSON.stringify(invalid)}`,
        ).toBe(false);
        expect(
          validate(invalid),
          `JSON Schema ${tool} ${JSON.stringify(invalid)}`,
        ).toBe(false);
      }
    }

    expect(
      successEnvelopeSchema.safeParse({
        ...successEnvelope(
          "jetkvm_session_status",
          validPayloads.jetkvm_session_status,
        ),
        session_id: null,
      }).success,
    ).toBe(false);

    const reconnect = successEnvelope(
      "jetkvm_session_reconnect",
      validPayloads.jetkvm_session_reconnect,
    );
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_session_reconnect.safeParse(reconnect).success,
    ).toBe(true);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_session_reconnect.safeParse({
        ...reconnect,
        session_generation: 3,
      }).success,
    ).toBe(false);
  });

  it("separates read errors from mutation write-boundary outcomes", () => {
    const error = {
      ok: false,
      tool: "jetkvm_input_mouse",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "CONNECTION_LOST",
        message: "Connection lost.",
        phase: "execute",
        outcome: null,
        verification: "none",
        safe_to_retry: true,
        required_next_step: "reconnect_then_capture",
        details: {
          permission: null,
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage: "none",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    };
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse(error).success,
    ).toBe(false);
    expect(toolErrorSchema.safeParse(error).success).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_display_capture.safeParse({
        ...error,
        tool: "jetkvm_display_capture",
      }).success,
    ).toBe(true);
    expect(
      toolErrorSchema.safeParse({
        ...error,
        tool: "jetkvm_display_capture",
      }).success,
    ).toBe(true);
  });

  it("scopes every read error code and predispatch detail in runtime and JSON Schema", () => {
    const sharedCodes = [
      "CONFIG_INVALID",
      "AUTH_FAILED",
      "AUTH_RATE_LIMITED",
      "AUTH_EXPIRED",
      "OBSERVE_ONLY",
      "SAFETY_DENIED",
      "UNSUPPORTED_UI_VERSION",
      "FIRMWARE_INCOMPATIBLE",
      "BROWSER_UNSUPPORTED",
      "SESSION_NOT_FOUND",
      "STALE_SESSION_GENERATION",
      "SESSION_TAKEN_OVER",
      "SESSION_DRAINED",
      "DEVICE_UNREACHABLE",
      "CONNECTION_LOST",
      "DOWNSTREAM_MALFORMED_RESPONSE",
      "CANCELLED",
      "DEADLINE_EXCEEDED",
      "PERMISSION_DENIED",
      "CAPABILITY_MISSING",
    ] as const satisfies readonly ErrorCode[];
    const readTools = {
      jetkvm_display_capture: {
        permission: "display.capture",
        capability: "display_capture",
        extraCodes: [
          "VIDEO_UNAVAILABLE",
          "VIDEO_STALLED",
          "FRAME_TIMEOUT",
          "DISPLAY_CHANGED",
        ],
      },
      jetkvm_display_status: {
        permission: "display.status",
        capability: "display_status",
        extraCodes: ["EDID_READ_FAILED", "DISPLAY_STATUS_STALE"],
      },
      jetkvm_session_status: {
        permission: "session.status",
        capability: "session_status",
        extraCodes: [],
      },
    } as const;
    const policyFor = (code: ErrorCode) => {
      if (code === "PERMISSION_DENIED") {
        return {
          phase: "authorize",
          safe_to_retry: false,
          required_next_step: "grant_permission",
          downstream_stage: "none",
        } as const;
      }
      if (code === "CAPABILITY_MISSING") {
        return {
          phase: "validate",
          safe_to_retry: false,
          required_next_step: "enable_capability",
          downstream_stage: "none",
        } as const;
      }
      if (code === "OBSERVE_ONLY" || code === "SAFETY_DENIED") {
        return {
          phase: "authorize",
          safe_to_retry: false,
          required_next_step: "none",
          downstream_stage: "none",
        } as const;
      }
      if (
        code === "AUTH_FAILED" ||
        code === "AUTH_RATE_LIMITED" ||
        code === "AUTH_EXPIRED" ||
        code === "UNSUPPORTED_UI_VERSION" ||
        code === "FIRMWARE_INCOMPATIBLE" ||
        code === "BROWSER_UNSUPPORTED" ||
        code === "DEVICE_UNREACHABLE"
      ) {
        return {
          phase: "connect",
          safe_to_retry:
            code === "AUTH_RATE_LIMITED" || code === "DEVICE_UNREACHABLE",
          required_next_step:
            code === "DEVICE_UNREACHABLE" ? "reconnect_then_capture" : "none",
          downstream_stage: "admission",
        } as const;
      }
      if (
        code === "CONNECTION_LOST" ||
        code === "DOWNSTREAM_MALFORMED_RESPONSE"
      ) {
        return {
          phase: "execute",
          safe_to_retry: code === "CONNECTION_LOST",
          required_next_step: "reconnect_then_capture",
          downstream_stage: "acknowledgement",
        } as const;
      }
      if (
        code === "VIDEO_UNAVAILABLE" ||
        code === "VIDEO_STALLED" ||
        code === "FRAME_TIMEOUT" ||
        code === "DISPLAY_CHANGED"
      ) {
        return {
          phase: "execute",
          safe_to_retry: true,
          required_next_step: "capture_then_retry",
          downstream_stage: "verification",
        } as const;
      }
      if (code === "EDID_READ_FAILED" || code === "DISPLAY_STATUS_STALE") {
        return {
          phase: "execute",
          safe_to_retry: true,
          required_next_step: "none",
          downstream_stage: "verification",
        } as const;
      }
      if (code === "CANCELLED" || code === "DEADLINE_EXCEEDED") {
        return {
          phase: "execute",
          safe_to_retry: true,
          required_next_step: "none",
          downstream_stage: "none",
        } as const;
      }
      if (code === "SESSION_TAKEN_OVER" || code === "SESSION_DRAINED") {
        return {
          phase: "execute",
          safe_to_retry: false,
          required_next_step: "reconnect_then_capture",
          downstream_stage: "admission",
        } as const;
      }
      return {
        phase: "validate",
        safe_to_retry: false,
        required_next_step:
          code === "SESSION_NOT_FOUND" || code === "STALE_SESSION_GENERATION"
            ? "reconnect_then_capture"
            : "none",
        downstream_stage:
          code === "SESSION_NOT_FOUND" || code === "STALE_SESSION_GENERATION"
            ? "admission"
            : "none",
      } as const;
    };
    const readError = (tool: keyof typeof readTools, code: ErrorCode) => {
      const policy = policyFor(code);
      const config = readTools[tool];
      return {
        ok: false,
        tool,
        operation_id: "operation-read",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        error: {
          code,
          message: "Canonical read error.",
          phase: policy.phase,
          outcome: null,
          verification: "none",
          safe_to_retry: policy.safe_to_retry,
          required_next_step: policy.required_next_step,
          details: {
            permission: code === "PERMISSION_DENIED" ? config.permission : null,
            capability:
              code === "CAPABILITY_MISSING" ? config.capability : null,
            failed_action_index: null,
            dispatched_action_count: null,
            completed_action_count: null,
            downstream_stage: policy.downstream_stage,
            expected_generation: null,
            actual_generation: null,
            observation_id: null,
          },
        },
      };
    };
    const documents = generateJsonSchemaDocuments();
    const ajv = new Ajv({ strict: false });

    for (const [tool, config] of Object.entries(readTools) as [
      keyof typeof readTools,
      (typeof readTools)[keyof typeof readTools],
    ][]) {
      const allowed = new Set<ErrorCode>([
        ...sharedCodes,
        ...config.extraCodes,
      ]);
      const validate = ajv.compile(documents[`${tool}.result.schema.json`]!);
      for (const code of ERROR_CODES) {
        const candidate = readError(tool, code);
        const expected = allowed.has(code);
        expect(
          TOOL_RESULT_SCHEMAS[tool].safeParse(candidate).success,
          `runtime ${tool} ${code}`,
        ).toBe(expected);
        expect(validate(candidate), `JSON Schema ${tool} ${code}`).toBe(
          expected,
        );
      }

      const permissionError = readError(tool, "PERMISSION_DENIED");
      const zeroCounts = {
        ...permissionError,
        error: {
          ...permissionError.error,
          details: {
            ...permissionError.error.details,
            dispatched_action_count: 0,
            completed_action_count: 0,
          },
        },
      };
      expect(TOOL_RESULT_SCHEMAS[tool].safeParse(zeroCounts).success).toBe(
        true,
      );
      expect(validate(zeroCounts)).toBe(true);
      const invalidPredispatch = {
        ...permissionError,
        error: {
          ...permissionError.error,
          details: {
            ...permissionError.error.details,
            dispatched_action_count: 1,
            downstream_stage: "write",
          },
        },
      };
      expect(
        TOOL_RESULT_SCHEMAS[tool].safeParse(invalidPredispatch).success,
      ).toBe(false);
      expect(validate(invalidPredispatch)).toBe(false);
    }
  });

  it("requires exact permission and capability error recovery details", () => {
    const permissionError = {
      ok: false,
      tool: "jetkvm_input_mouse",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "PERMISSION_DENIED",
        message: "Permission denied.",
        phase: "authorize",
        outcome: "not_sent",
        verification: "none",
        safe_to_retry: false,
        required_next_step: "grant_permission",
        details: {
          permission: "input.mouse",
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage: "none",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    };
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse(permissionError).success,
    ).toBe(true);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...permissionError,
        error: {
          ...permissionError.error,
          details: { ...permissionError.error.details, permission: null },
        },
      }).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...permissionError,
        error: {
          ...permissionError.error,
          details: {
            ...permissionError.error.details,
            permission: "power.control",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...permissionError,
        error: {
          ...permissionError.error,
          required_next_step: "none",
        },
      }).success,
    ).toBe(false);
    const capabilityError = {
      ...permissionError,
      error: {
        ...permissionError.error,
        code: "CAPABILITY_MISSING",
        phase: "validate",
        required_next_step: "enable_capability",
        details: {
          ...permissionError.error.details,
          permission: null,
          capability: "mouse",
        },
      },
    };
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse(capabilityError).success,
    ).toBe(true);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...capabilityError,
        error: {
          ...capabilityError.error,
          details: { ...capabilityError.error.details, capability: null },
        },
      }).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...capabilityError,
        error: {
          ...capabilityError.error,
          details: {
            ...capabilityError.error.details,
            capability: "keyboard",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...capabilityError,
        error: {
          ...capabilityError.error,
          phase: "authorize",
        },
      }).success,
    ).toBe(false);
  });

  it("requires positive equal keyboard and mouse success counts in runtime and generated schemas", () => {
    const documents = generateJsonSchemaDocuments();
    const ajv = new Ajv({ strict: false });
    for (const config of [
      {
        tool: "jetkvm_input_keyboard",
        maximum: 64,
        payload: validPayloads.jetkvm_input_keyboard,
      },
      {
        tool: "jetkvm_input_mouse",
        maximum: 16,
        payload: validPayloads.jetkvm_input_mouse,
      },
    ] as const) {
      const validate = ajv.compile(
        documents[`${config.tool}.result.schema.json`]!,
      );
      for (const count of [1, config.maximum]) {
        const envelope = successEnvelope(config.tool, {
          ...(config.payload as object),
          dispatched_action_count: count,
          completed_action_count: count,
        });
        expect(
          TOOL_RESULT_SCHEMAS[config.tool].safeParse(envelope).success,
          `runtime ${config.tool} count ${count}`,
        ).toBe(true);
        expect(
          validate(envelope),
          `JSON Schema ${config.tool} count ${count}`,
        ).toBe(true);
      }
      for (const [dispatched_action_count, completed_action_count] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [config.maximum, config.maximum - 1],
        [config.maximum + 1, config.maximum + 1],
      ] as const) {
        const envelope = successEnvelope(config.tool, {
          ...(config.payload as object),
          dispatched_action_count,
          completed_action_count,
        });
        expect(
          TOOL_RESULT_SCHEMAS[config.tool].safeParse(envelope).success,
          `runtime ${config.tool} ${dispatched_action_count}/${completed_action_count}`,
        ).toBe(false);
        expect(
          validate(envelope),
          `JSON Schema ${config.tool} ${dispatched_action_count}/${completed_action_count}`,
        ).toBe(false);
      }
    }
  });

  it("requires a correlated succeeded paste lifecycle in runtime and generated schemas", () => {
    const document =
      generateJsonSchemaDocuments()["jetkvm_input_paste.result.schema.json"]!;
    const validate = new Ajv({ strict: false }).compile(document);
    const valid = successEnvelope(
      "jetkvm_input_paste",
      validPayloads.jetkvm_input_paste,
    );
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_input_paste.safeParse(valid).success,
    ).toBe(true);
    expect(validate(valid)).toBe(true);

    for (const invalidResult of [
      { terminal_state: "failed" },
      { terminal_state: "cancelled" },
      { terminal_state: "unknown" },
      { accepted_at: null },
      { completed_at: null },
    ]) {
      const invalid = successEnvelope("jetkvm_input_paste", {
        ...(validPayloads.jetkvm_input_paste as object),
        ...invalidResult,
      });
      expect(
        TOOL_RESULT_SCHEMAS.jetkvm_input_paste.safeParse(invalid).success,
        `runtime ${JSON.stringify(invalidResult)}`,
      ).toBe(false);
      expect(
        validate(invalid),
        `JSON Schema ${JSON.stringify(invalidResult)}`,
      ).toBe(false);
    }
  });

  it("correlates ATX observation freshness with observation presence in runtime and generated schemas", () => {
    const document =
      generateJsonSchemaDocuments()["jetkvm_power_control.result.schema.json"]!;
    const validate = new Ajv({ strict: false }).compile(document);
    const power = validPayloads.jetkvm_power_control as Record<string, unknown>;
    for (const observation of [
      {
        power: true,
        hdd: false,
        observed_at: "2026-07-13T00:00:00.000Z",
        freshness: "fresh",
      },
      {
        power: null,
        hdd: true,
        observed_at: "2026-07-13T00:00:00.000Z",
        freshness: "stale",
      },
      {
        power: null,
        hdd: null,
        observed_at: null,
        freshness: "unknown",
      },
    ]) {
      const envelope = successEnvelope("jetkvm_power_control", {
        ...power,
        atx_led_observation: observation,
      });
      expect(
        TOOL_RESULT_SCHEMAS.jetkvm_power_control.safeParse(envelope).success,
        `runtime ${JSON.stringify(observation)}`,
      ).toBe(true);
      expect(
        validate(envelope),
        `JSON Schema ${JSON.stringify(observation)}`,
      ).toBe(true);
    }
    for (const observation of [
      {
        power: true,
        hdd: false,
        observed_at: null,
        freshness: "fresh",
      },
      {
        power: true,
        hdd: false,
        observed_at: null,
        freshness: "stale",
      },
      {
        power: null,
        hdd: null,
        observed_at: "2026-07-13T00:00:00.000Z",
        freshness: "unknown",
      },
      {
        power: true,
        hdd: null,
        observed_at: null,
        freshness: "unknown",
      },
    ]) {
      const envelope = successEnvelope("jetkvm_power_control", {
        ...power,
        atx_led_observation: observation,
      });
      expect(
        TOOL_RESULT_SCHEMAS.jetkvm_power_control.safeParse(envelope).success,
        `runtime ${JSON.stringify(observation)}`,
      ).toBe(false);
      expect(
        validate(envelope),
        `JSON Schema ${JSON.stringify(observation)}`,
      ).toBe(false);
    }
  });

  it("requires reconnect generation advancement and documents cross-field invariants", () => {
    const schema = TOOL_RESULT_SCHEMAS.jetkvm_session_reconnect;
    const document =
      generateJsonSchemaDocuments()[
        "jetkvm_session_reconnect.result.schema.json"
      ]!;
    const validate = new Ajv({ strict: false }).compile(document);
    for (const [previous_session_generation, new_session_generation] of [
      [0, 1],
      [1, 2],
      [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const envelope = {
        ...successEnvelope("jetkvm_session_reconnect", {
          ...(validPayloads.jetkvm_session_reconnect as object),
          previous_session_generation,
          new_session_generation,
        }),
        session_generation: new_session_generation,
      };
      expect(
        schema.safeParse(envelope).success,
        `runtime ${previous_session_generation}->${new_session_generation}`,
      ).toBe(true);
      expect(
        validate(envelope),
        `JSON Schema scalar bounds ${previous_session_generation}->${new_session_generation}`,
      ).toBe(true);
    }
    for (const [previous_session_generation, new_session_generation] of [
      [0, 0],
      [1, 1],
      [2, 1],
    ] as const) {
      const envelope = {
        ...successEnvelope("jetkvm_session_reconnect", {
          ...(validPayloads.jetkvm_session_reconnect as object),
          previous_session_generation,
          new_session_generation,
        }),
        session_generation: new_session_generation,
      };
      expect(
        schema.safeParse(envelope).success,
        `runtime rejects ${previous_session_generation}->${new_session_generation}`,
      ).toBe(false);
    }
    const validPayload = validPayloads.jetkvm_session_reconnect as Record<
      string,
      unknown
    >;
    expect(
      schema.safeParse({
        ...successEnvelope("jetkvm_session_reconnect", validPayload),
        session_generation: 3,
      }).success,
    ).toBe(false);
    expect(
      validate({
        ...successEnvelope("jetkvm_session_reconnect", {
          ...validPayload,
          new_session_generation: 0,
        }),
        session_generation: 0,
      }),
    ).toBe(false);
    expect(JSON.stringify(document)).toContain(
      "strictly greater than previous_session_generation",
    );
    expect(JSON.stringify(document)).toContain(
      "must equal result.new_session_generation",
    );
  });

  it("requires exact bounded keyboard and mouse error count tuples in runtime and generated schemas", () => {
    const documents = generateJsonSchemaDocuments();
    const ajv = new Ajv({ strict: false });
    const errorEnvelope = (
      tool: "jetkvm_input_keyboard" | "jetkvm_input_mouse",
      kind: "unknown" | "applied",
      failed_action_index: number | null,
      dispatched_action_count: number | null,
      completed_action_count: number | null,
    ) => ({
      ok: false,
      tool,
      operation_id: "operation-action-error",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code:
          kind === "unknown"
            ? "MUTATION_OUTCOME_UNKNOWN"
            : "PARTIAL_VERIFICATION",
        message: "Canonical action error.",
        phase: kind === "unknown" ? "execute" : "verify",
        outcome: kind,
        verification: kind === "unknown" ? "none" : "device_ack_only",
        safe_to_retry: false,
        required_next_step:
          kind === "unknown" ? "inspect_device_state_before_retry" : "none",
        details: {
          permission: null,
          capability: null,
          failed_action_index,
          dispatched_action_count,
          completed_action_count,
          downstream_stage: kind === "unknown" ? "write" : "verification",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    });

    for (const [tool, maximum] of [
      ["jetkvm_input_keyboard", 64],
      ["jetkvm_input_mouse", 16],
    ] as const) {
      const validate = ajv.compile(documents[`${tool}.result.schema.json`]!);
      for (const candidate of [
        errorEnvelope(tool, "unknown", 0, 1, 0),
        errorEnvelope(tool, "unknown", maximum - 1, maximum, maximum - 1),
        errorEnvelope(tool, "applied", null, 1, 1),
        errorEnvelope(tool, "applied", null, maximum, maximum),
      ]) {
        expect(
          TOOL_RESULT_SCHEMAS[tool].safeParse(candidate).success,
          `runtime legal ${tool} ${JSON.stringify(candidate.error.details)}`,
        ).toBe(true);
        expect(
          validate(candidate),
          `JSON Schema legal ${tool} ${JSON.stringify(candidate.error.details)}`,
        ).toBe(true);
      }
      for (const candidate of [
        errorEnvelope(tool, "unknown", null, 1, 0),
        errorEnvelope(tool, "unknown", 0, null, null),
        errorEnvelope(tool, "unknown", 0, 0, 0),
        errorEnvelope(tool, "unknown", 0, 1, 1),
        errorEnvelope(tool, "unknown", 0, 2, 0),
        errorEnvelope(tool, "unknown", 1, 1, 0),
        errorEnvelope(tool, "unknown", maximum, maximum + 1, maximum),
        errorEnvelope(tool, "applied", null, null, null),
        errorEnvelope(tool, "applied", null, 1, 0),
        errorEnvelope(tool, "applied", 0, 1, 1),
        errorEnvelope(tool, "applied", null, 0, 0),
      ]) {
        expect(
          TOOL_RESULT_SCHEMAS[tool].safeParse(candidate).success,
          `runtime rejects ${tool} ${JSON.stringify(candidate.error.details)}`,
        ).toBe(false);
        expect(
          validate(candidate),
          `JSON Schema rejects ${tool} ${JSON.stringify(candidate.error.details)}`,
        ).toBe(false);
      }
    }
  });

  it("uses exact reconnect recovery and admission-capacity policies in runtime and generated schemas", () => {
    const documents = generateJsonSchemaDocuments();
    const ajv = new Ajv({ strict: false });
    const errorEnvelope = (
      tool: JetKvmToolName,
      code:
        | "SESSION_NOT_FOUND"
        | "STALE_SESSION_GENERATION"
        | "ADMISSION_CAPACITY_EXCEEDED",
    ) => ({
      ok: false,
      tool,
      operation_id: "operation-policy",
      session_id: tool === "jetkvm_session_connect" ? null : "session-1",
      session_generation: tool === "jetkvm_session_connect" ? null : 1,
      duration_ms: 1,
      error: {
        code,
        message: "Canonical policy error.",
        phase: code === "ADMISSION_CAPACITY_EXCEEDED" ? "queue" : "validate",
        outcome: "not_sent",
        verification: "none",
        safe_to_retry: code === "ADMISSION_CAPACITY_EXCEEDED",
        required_next_step:
          code === "ADMISSION_CAPACITY_EXCEEDED"
            ? "none"
            : "reconnect_then_capture",
        details: {
          permission: null,
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage:
            code === "ADMISSION_CAPACITY_EXCEEDED" ? "none" : "admission",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    });
    const mutationTools = JETKVM_TOOL_NAMES.filter(
      (tool) =>
        tool !== "jetkvm_display_capture" &&
        tool !== "jetkvm_display_status" &&
        tool !== "jetkvm_session_status",
    );
    for (const tool of mutationTools) {
      const candidate = errorEnvelope(tool, "ADMISSION_CAPACITY_EXCEEDED");
      const validate = ajv.compile(documents[`${tool}.result.schema.json`]!);
      expect(
        TOOL_RESULT_SCHEMAS[tool].safeParse(candidate).success,
        `runtime ${tool} capacity`,
      ).toBe(true);
      expect(validate(candidate), `JSON Schema ${tool} capacity`).toBe(true);
      for (const invalidError of [
        { phase: "execute" },
        { safe_to_retry: false },
        {
          details: {
            ...candidate.error.details,
            dispatched_action_count: 1,
          },
        },
      ]) {
        const invalid = {
          ...candidate,
          error: { ...candidate.error, ...invalidError },
        };
        expect(TOOL_RESULT_SCHEMAS[tool].safeParse(invalid).success).toBe(
          false,
        );
        expect(validate(invalid)).toBe(false);
      }
    }
    for (const tool of [
      "jetkvm_display_capture",
      "jetkvm_display_status",
      "jetkvm_session_status",
    ] as const) {
      const candidate = errorEnvelope(tool, "ADMISSION_CAPACITY_EXCEEDED");
      const validate = ajv.compile(documents[`${tool}.result.schema.json`]!);
      expect(TOOL_RESULT_SCHEMAS[tool].safeParse(candidate).success).toBe(
        false,
      );
      expect(validate(candidate)).toBe(false);
    }
    for (const code of [
      "SESSION_NOT_FOUND",
      "STALE_SESSION_GENERATION",
    ] as const) {
      const candidate = errorEnvelope("jetkvm_session_reconnect", code);
      const validate = ajv.compile(
        documents["jetkvm_session_reconnect.result.schema.json"]!,
      );
      expect(
        TOOL_RESULT_SCHEMAS.jetkvm_session_reconnect.safeParse(candidate)
          .success,
      ).toBe(true);
      expect(validate(candidate)).toBe(true);
      const wrongRecovery = {
        ...candidate,
        error: { ...candidate.error, required_next_step: "none" },
      };
      expect(
        TOOL_RESULT_SCHEMAS.jetkvm_session_reconnect.safeParse(wrongRecovery)
          .success,
      ).toBe(false);
      expect(validate(wrongRecovery)).toBe(false);
    }
  });

  it("allows only definitive mutation success payloads", () => {
    const mouse = validPayloads.jetkvm_input_mouse;
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_input_mouse.safeParse({
        ...(mouse as object),
        outcome: "unknown",
        verification: "none",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
      }).success,
    ).toBe(false);
  });

  it("requires fully verified emergency release success", () => {
    const release = validPayloads.jetkvm_input_release;
    for (const invalid of [
      { verification: "device_ack_only" },
      { mutation_gate_closed: false },
      { deferred_producers_joined: false },
      { paste_terminal: "unknown" },
      { ordinary_leases_zero: null },
      { keyboard_zero: false },
      { pointer_zero: null },
      { generation_drained: false },
    ]) {
      expect(
        TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_input_release.safeParse({
          ...(release as object),
          ...invalid,
        }).success,
      ).toBe(false);
    }
  });

  it("requires exact power mappings, receipts, and acknowledgement strength", () => {
    const power = validPayloads.jetkvm_power_control;
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_power_control.safeParse({
        ...(power as object),
        action: "hold_power",
        wire_action: "power-long",
        fixed_press_ms: 5000,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { action: "hold_power", wire_action: "reset", fixed_press_ms: 200 },
      { verification: "device_state_verified" },
      { serial_sequence_completed: false },
    ]) {
      expect(
        TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_power_control.safeParse({
          ...(power as object),
          ...invalid,
        }).success,
      ).toBe(false);
    }
    const powerError = {
      ok: false,
      tool: "jetkvm_power_control",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "PARTIAL_VERIFICATION",
        message: "Power receipt was only partially verified.",
        phase: "verify",
        outcome: "applied",
        verification: "device_state_verified",
        safe_to_retry: false,
        required_next_step: "none",
        details: {
          permission: null,
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage: "verification",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    };
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_power_control.safeParse(powerError).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_SCHEMAS.jetkvm_power_control.safeParse({
        ...powerError,
        error: {
          ...powerError.error,
          verification: "device_ack_only",
        },
      }).success,
    ).toBe(true);
  });

  it("caps JPEG at 2 MiB and PNG at 8 MiB before base64", () => {
    for (const [mime_type, maximum] of [
      ["image/jpeg", 2 * 1024 * 1024],
      ["image/png", 8 * 1024 * 1024],
    ] as const) {
      expect(
        TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
          ...captureResult,
          image: {
            ...captureResult.image,
            mime_type,
            byte_length: maximum,
          },
        }).success,
      ).toBe(true);
      expect(
        TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
          ...captureResult,
          image: {
            ...captureResult.image,
            mime_type,
            byte_length: maximum + 1,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("validates strict errors and rejects incoherent mutation claims", () => {
    const error = {
      ok: false,
      tool: "jetkvm_input_mouse",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 2,
      error: {
        code: "CONNECTION_LOST",
        message: "The device connection was lost.",
        phase: "execute",
        outcome: "unknown",
        verification: "none",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
        details: {
          permission: null,
          capability: null,
          failed_action_index: 0,
          dispatched_action_count: 1,
          completed_action_count: 0,
          downstream_stage: "write",
          expected_generation: 1,
          actual_generation: null,
          observation_id: "observation-1",
        },
      },
    };
    expect(toolErrorSchema.safeParse(error).success).toBe(true);
    expect(
      toolErrorSchema.safeParse({ ...error, unexpected: true }).success,
    ).toBe(false);
    expect(
      toolErrorSchema.safeParse({
        ...error,
        error: { ...error.error, verification: "device_ack_only" },
      }).success,
    ).toBe(false);
  });
});

describe("tracked generated JSON Schema", () => {
  it("generates exactly one input and one result schema per canonical tool", () => {
    const documents = generateJsonSchemaDocuments();
    expect(Object.keys(documents)).toEqual(SCHEMA_FILE_NAMES);
    expect(SCHEMA_FILE_NAMES).toHaveLength(JETKVM_TOOL_NAMES.length * 2);
  });

  it("emits strict object roots and preserves canonical bounds/defaults", () => {
    const documents = generateJsonSchemaDocuments();
    const connect = documents[
      "jetkvm_session_connect.input.schema.json"
    ] as Record<string, unknown>;
    expect(connect).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["request_id", "timeout_ms"],
      properties: {
        takeover: { type: "boolean", default: false },
        timeout_ms: { type: "integer", minimum: 100, maximum: 60_000 },
      },
    });
    const paste = JSON.stringify(
      documents["jetkvm_input_paste.input.schema.json"],
    );
    expect(paste).toContain('"x-utf8-byte-max":262144');
    const scroll = JSON.stringify(
      documents["jetkvm_input_mouse.input.schema.json"],
    );
    expect(scroll).toContain('"minimum":-127');
    expect(scroll).toContain('"maximum":127');
    expect(scroll).toContain('"not":{"const":0}');
  });

  it("rejects unknown fields and invalid bounds through generated JSON Schema", () => {
    const validator = new Ajv({ allErrors: true, strict: false });
    const documents = generateJsonSchemaDocuments();
    for (const tool of JETKVM_TOOL_NAMES) {
      const inputDocument = documents[`${tool}.input.schema.json`];
      const resultDocument = documents[`${tool}.result.schema.json`];
      if (inputDocument === undefined || resultDocument === undefined) {
        throw new Error(`Missing generated schema for ${tool}`);
      }
      const validateInput = validator.compile(inputDocument);
      const validateResult = validator.compile(resultDocument);
      const input = validInputs[tool] as Record<string, unknown>;
      const result = successEnvelope(tool, validPayloads[tool]);

      expect(validateInput(input), `${tool} valid input`).toBe(true);
      expect(
        validateInput({ ...input, unexpected: true }),
        `${tool} extra input`,
      ).toBe(false);
      expect(
        validateInput({ ...input, timeout_ms: 99 }),
        `${tool} timeout bound`,
      ).toBe(false);
      expect(validateResult(result), `${tool} valid result`).toBe(true);
      expect(
        validateResult({ ...result, unexpected: true }),
        `${tool} extra result`,
      ).toBe(false);
    }
    const keyboardDocument =
      documents["jetkvm_input_keyboard.input.schema.json"];
    const captureDocument =
      documents["jetkvm_display_capture.result.schema.json"];
    if (keyboardDocument === undefined || captureDocument === undefined) {
      throw new Error("Missing nested strictness schema fixture");
    }
    const validateKeyboard = validator.compile(keyboardDocument);
    const validateCapture = validator.compile(captureDocument);
    expect(
      validateKeyboard({
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-1",
        actions: [{ type: "key_press", key: "KeyA", unexpected: true }],
        timeout_ms: 1_000,
      }),
    ).toBe(false);
    expect(
      validateCapture(
        successEnvelope("jetkvm_display_capture", {
          ...captureResult,
          image: { ...captureResult.image, data: "forbidden-base64" },
        }),
      ),
    ).toBe(false);
    const captureError = {
      ok: false,
      tool: "jetkvm_display_capture",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "FRAME_TIMEOUT",
        message: "Timed out waiting for a fresh frame.",
        phase: "execute",
        outcome: null,
        verification: "none",
        safe_to_retry: true,
        required_next_step: "capture_then_retry",
        details: {
          permission: null,
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage: "none",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
        },
      },
    };
    expect(validateCapture(captureError)).toBe(true);
    expect(
      validateCapture({
        ...captureError,
        error: {
          ...captureError.error,
          details: {
            ...captureError.error.details,
            evidence: "forbidden",
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps image bytes out of every generated schema", () => {
    const capture =
      generateJsonSchemaDocuments()[
        "jetkvm_display_capture.result.schema.json"
      ];
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain('"base64"');
    expect(serialized).not.toContain('"bytes"');
    expect(serialized).not.toContain('"data":{"type":"string"');
    expect(serialized).toContain('"content_index"');
    expect(serialized).toContain('"byte_length"');
  });

  it("matches the complete tracked schema directory without missing, extra, or stale files", () => {
    const schemaDirectory = fileURLToPath(
      new URL("../../schemas", import.meta.url),
    );
    const documents = generateJsonSchemaDocuments();
    const tracked = readdirSync(schemaDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const owned = tracked.filter((name) => SCHEMA_FILE_NAMES.includes(name));
    const unknown = tracked.filter(
      (name) =>
        !SCHEMA_FILE_NAMES.includes(name) &&
        name !== "story-manifest.schema.json",
    );
    expect(owned).toEqual(SCHEMA_FILE_NAMES);
    expect(unknown).toEqual([]);
    for (const fileName of SCHEMA_FILE_NAMES) {
      const actual = `${JSON.stringify(JSON.parse(readFileSync(join(schemaDirectory, fileName), "utf8")), null, 2)}\n`;
      const expected = `${JSON.stringify(documents[fileName], null, 2)}\n`;
      expect(actual, fileName).toBe(expected);
    }
  });
});
