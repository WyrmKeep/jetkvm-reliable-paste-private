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
import {
  SCHEMA_FILE_NAMES,
  TOOL_INPUT_SCHEMAS,
  TOOL_RESULT_PAYLOAD_SCHEMAS,
  TOOL_RESULT_SCHEMAS,
  generateJsonSchemaDocuments,
  mutationStateSchema,
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
    session_generation: 1,
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

  it("enforces every mutation-error outcome/verification/retry/next-step combination", () => {
    const outcomes = [
      "applied",
      "already_applied",
      "not_sent",
      "unknown",
      null,
    ] as const;
    const verifications = [
      "device_state_verified",
      "device_ack_only",
      "none",
    ] as const;
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
        for (const safe_to_retry of [false, true] as const) {
          for (const required_next_step of nextSteps) {
            const definitive =
              outcome === "applied" || outcome === "already_applied";
            const genericRecovery =
              required_next_step !== "grant_permission" &&
              required_next_step !== "enable_capability";
            const legal =
              outcome === null
                ? false
                : definitive
                  ? verification !== "none" &&
                    !safe_to_retry &&
                    required_next_step === "none"
                  : outcome === "unknown"
                    ? verification === "none" &&
                      !safe_to_retry &&
                      (required_next_step ===
                        "inspect_device_state_before_retry" ||
                        required_next_step ===
                          "release_then_reconnect_then_capture")
                    : verification === "none" &&
                      genericRecovery &&
                      required_next_step !==
                        "inspect_device_state_before_retry" &&
                      required_next_step !==
                        "release_then_reconnect_then_capture";
            const candidate = {
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
                outcome,
                verification,
                safe_to_retry,
                required_next_step,
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
              toolErrorSchema.safeParse(candidate).success,
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

  it("caps JPEG bytes without imposing the JPEG limit on PNG", () => {
    const oversized = 2 * 1024 * 1024 + 1;
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
        ...captureResult,
        image: {
          ...captureResult.image,
          mime_type: "image/jpeg",
          byte_length: oversized,
        },
      }).success,
    ).toBe(false);
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
        ...captureResult,
        image: {
          ...captureResult.image,
          mime_type: "image/png",
          byte_length: oversized,
        },
      }).success,
    ).toBe(true);
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
          failed_action_index: null,
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
