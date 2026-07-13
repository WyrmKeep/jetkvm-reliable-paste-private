import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  PERMISSION_NAMES,
  PHYSICAL_KEYS,
  type JetKvmToolName,
} from "../domain.ts";
import { ERROR_CODES, ERROR_PHASES } from "../errors.ts";

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const nonNegativeIntegerSchema = z.number().int().min(0).max(MAX_JSON_INTEGER);
const nonNegativeDimensionSchema = nonNegativeIntegerSchema;
const timestampSchema = z.string().min(1);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const permissionSchema = z.enum(PERMISSION_NAMES);
const capabilityNameSchema = z.enum(CAPABILITY_NAMES);
const toolNameSchema = z.enum(JETKVM_TOOL_NAMES);
const errorCodeSchema = z.enum(ERROR_CODES);
const errorPhaseSchema = z.enum(ERROR_PHASES);

const capabilityShape = Object.fromEntries(
  CAPABILITY_NAMES.map((name) => [name, z.boolean()]),
) as Record<(typeof CAPABILITY_NAMES)[number], z.ZodBoolean>;
export const capabilitySnapshotSchema = z.object(capabilityShape).strict();

const definitiveMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.enum(["applied", "already_applied"]),
  verification: z.enum(["device_state_verified", "device_ack_only"]),
  safe_to_retry: z.literal(false),
  required_next_step: z.literal("none"),
} as const;
const notSentMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.literal("not_sent"),
  verification: z.literal("none"),
  safe_to_retry: z.boolean(),
  required_next_step: z.enum([
    "none",
    "capture_then_retry",
    "reconnect_then_capture",
    "wait_or_request_takeover",
    "grant_permission",
    "enable_capability",
  ]),
} as const;
const unknownMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.literal("unknown"),
  verification: z.literal("none"),
  safe_to_retry: z.literal(false),
  required_next_step: z.enum([
    "release_then_reconnect_then_capture",
    "inspect_device_state_before_retry",
  ]),
} as const;

export const mutationStateSchema = z.union([
  z.object(definitiveMutationShape).strict(),
  z.object(notSentMutationShape).strict(),
  z.object(unknownMutationShape).strict(),
]);

const errorDetailsShape = {
  permission: permissionSchema.nullable(),
  capability: capabilityNameSchema.nullable(),
  failed_action_index: nonNegativeIntegerSchema.nullable(),
  dispatched_action_count: nonNegativeIntegerSchema.nullable(),
  completed_action_count: nonNegativeIntegerSchema.nullable(),
  downstream_stage: z.enum([
    "none",
    "admission",
    "write",
    "acknowledgement",
    "verification",
  ]),
  expected_generation: nonNegativeIntegerSchema.nullable(),
  actual_generation: nonNegativeIntegerSchema.nullable(),
  observation_id: opaqueIdSchema.nullable(),
} as const;
const errorDetailsSchema = z.object(errorDetailsShape).strict();
const permissionErrorDetails = (permission: z.ZodTypeAny) =>
  z
    .object({
      ...errorDetailsShape,
      permission,
      capability: z.null(),
    })
    .strict();
const capabilityErrorDetails = (capability: z.ZodTypeAny) =>
  z
    .object({
      ...errorDetailsShape,
      permission: z.null(),
      capability,
    })
    .strict();

const genericErrorCodeSchema = errorCodeSchema.exclude([
  "PERMISSION_DENIED",
  "CAPABILITY_MISSING",
]);
const commonErrorShape = {
  message: z.string().min(1).max(512),
  phase: errorPhaseSchema,
} as const;
const genericCommonErrorShape = {
  ...commonErrorShape,
  code: genericErrorCodeSchema,
  details: errorDetailsSchema,
} as const;
const readErrorOutcomeShape = {
  outcome: z.null(),
  verification: z.literal("none"),
  safe_to_retry: z.boolean(),
} as const;
const notSentErrorOutcomeShape = {
  outcome: z.literal("not_sent"),
  verification: z.literal("none"),
  safe_to_retry: z.boolean(),
  required_next_step: z.enum([
    "none",
    "capture_then_retry",
    "reconnect_then_capture",
    "wait_or_request_takeover",
  ]),
} as const;
const unknownErrorOutcomeShape = {
  outcome: z.literal("unknown"),
  verification: z.literal("none"),
  safe_to_retry: z.literal(false),
  required_next_step: z.enum([
    "release_then_reconnect_then_capture",
    "inspect_device_state_before_retry",
  ]),
} as const;

const readErrorBody = (permission: z.ZodTypeAny, capability: z.ZodTypeAny) =>
  z.union([
    z
      .object({
        ...genericCommonErrorShape,
        ...readErrorOutcomeShape,
        required_next_step: z.enum([
          "none",
          "capture_then_retry",
          "reconnect_then_capture",
          "release_then_reconnect_then_capture",
          "inspect_device_state_before_retry",
          "wait_or_request_takeover",
        ]),
      })
      .strict(),
    z
      .object({
        ...commonErrorShape,
        code: z.literal("PERMISSION_DENIED"),
        details: permissionErrorDetails(permission),
        ...readErrorOutcomeShape,
        required_next_step: z.literal("grant_permission"),
      })
      .strict(),
    z
      .object({
        ...commonErrorShape,
        code: z.literal("CAPABILITY_MISSING"),
        details: capabilityErrorDetails(capability),
        ...readErrorOutcomeShape,
        required_next_step: z.literal("enable_capability"),
      })
      .strict(),
  ]);

const mutationErrorBody = (
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  definitiveVerification: z.ZodTypeAny = z.enum([
    "device_state_verified",
    "device_ack_only",
  ]),
) =>
  z.union([
    z
      .object({
        ...genericCommonErrorShape,
        outcome: z.enum(["applied", "already_applied"]),
        verification: definitiveVerification,
        safe_to_retry: z.literal(false),
        required_next_step: z.literal("none"),
      })
      .strict(),
    z
      .object({
        ...genericCommonErrorShape,
        ...notSentErrorOutcomeShape,
      })
      .strict(),
    z
      .object({
        ...genericCommonErrorShape,
        ...unknownErrorOutcomeShape,
      })
      .strict(),
    z
      .object({
        ...commonErrorShape,
        code: z.literal("PERMISSION_DENIED"),
        details: permissionErrorDetails(permission),
        outcome: z.literal("not_sent"),
        verification: z.literal("none"),
        safe_to_retry: z.boolean(),
        required_next_step: z.literal("grant_permission"),
      })
      .strict(),
    z
      .object({
        ...commonErrorShape,
        code: z.literal("CAPABILITY_MISSING"),
        details: capabilityErrorDetails(capability),
        outcome: z.literal("not_sent"),
        verification: z.literal("none"),
        safe_to_retry: z.boolean(),
        required_next_step: z.literal("enable_capability"),
      })
      .strict(),
  ]);

const displayCaptureErrorBodySchema = readErrorBody(
  z.literal("display.capture"),
  z.literal("display_capture"),
);
const displayStatusErrorBodySchema = readErrorBody(
  z.literal("display.status"),
  z.literal("display_status"),
);
const sessionStatusErrorBodySchema = readErrorBody(
  z.literal("session.status"),
  z.literal("session_status"),
);
const inputKeyboardErrorBodySchema = mutationErrorBody(
  z.literal("input.keyboard"),
  z.literal("keyboard"),
);
const inputMouseErrorBodySchema = mutationErrorBody(
  z.literal("input.mouse"),
  z.enum(["mouse", "absolute_pointer"]),
);
const inputPasteErrorBodySchema = mutationErrorBody(
  z.literal("input.paste"),
  z.literal("reliable_paste"),
);
const inputReleaseErrorBodySchema = mutationErrorBody(
  z.literal("input.release"),
  z.literal("input_release"),
);
const powerControlErrorBodySchema = mutationErrorBody(
  z.literal("power.control"),
  z.literal("power_control"),
  z.literal("device_ack_only"),
);
const sessionConnectErrorBodySchema = mutationErrorBody(
  z.enum(["session.connect", "session.takeover"]),
  z.never(),
);
const sessionReconnectErrorBodySchema = mutationErrorBody(
  z.enum(["session.reconnect", "session.takeover"]),
  z.never(),
);

const toolErrorEnvelopeShape = {
  ok: z.literal(false),
  operation_id: opaqueIdSchema,
  session_id: opaqueIdSchema.nullable(),
  session_generation: nonNegativeIntegerSchema.nullable(),
  duration_ms: nonNegativeIntegerSchema,
} as const;
const errorForTool = (tool: JetKvmToolName, error: z.ZodTypeAny) =>
  z
    .object({
      ...toolErrorEnvelopeShape,
      tool: z.literal(tool),
      error,
    })
    .strict();

export const toolErrorSchema = z.union([
  errorForTool("jetkvm_display_capture", displayCaptureErrorBodySchema),
  errorForTool("jetkvm_display_status", displayStatusErrorBodySchema),
  errorForTool("jetkvm_session_status", sessionStatusErrorBodySchema),
  errorForTool("jetkvm_input_keyboard", inputKeyboardErrorBodySchema),
  errorForTool("jetkvm_input_mouse", inputMouseErrorBodySchema),
  errorForTool("jetkvm_input_paste", inputPasteErrorBodySchema),
  errorForTool("jetkvm_input_release", inputReleaseErrorBodySchema),
  errorForTool("jetkvm_power_control", powerControlErrorBodySchema),
  errorForTool("jetkvm_session_connect", sessionConnectErrorBodySchema),
  errorForTool("jetkvm_session_reconnect", sessionReconnectErrorBodySchema),
]);

export const successEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    tool: toolNameSchema,
    operation_id: opaqueIdSchema,
    session_id: opaqueIdSchema.nullable(),
    session_generation: nonNegativeIntegerSchema.nullable(),
    duration_ms: nonNegativeIntegerSchema,
    result: z.unknown(),
  })
  .strict();

const sessionIdentityShape = {
  session_id: opaqueIdSchema,
  session_generation: nonNegativeIntegerSchema,
} as const;
const requestIdentityShape = {
  request_id: opaqueIdSchema,
} as const;
const observationIdentityShape = {
  observation_id: opaqueIdSchema,
} as const;
const timeout = (maximum: number) => z.number().int().min(100).max(maximum);

export const sessionConnectInputSchema = z
  .object({
    ...requestIdentityShape,
    takeover: z.boolean().default(false),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const sessionStatusInputSchema = z
  .object({
    ...sessionIdentityShape,
    timeout_ms: timeout(30_000),
  })
  .strict();
export const sessionReconnectInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    takeover: z.boolean().default(false),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const displayCaptureInputSchema = z
  .object({
    ...sessionIdentityShape,
    format: z.enum(["jpeg", "png"]).default("jpeg"),
    max_width: z.number().int().min(64).max(1920).default(1280),
    max_height: z.number().int().min(64).max(1080).default(720),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const displayStatusInputSchema = z
  .object({
    ...sessionIdentityShape,
    timeout_ms: timeout(30_000),
  })
  .strict();

const pointSchema = z
  .object({ x: nonNegativeIntegerSchema, y: nonNegativeIntegerSchema })
  .strict();
const mouseButtonSchema = z.enum(["left", "middle", "right"]);
const mouseActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      button: mouseButtonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("double_click"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      button: mouseButtonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      button: mouseButtonSchema,
      path: z.array(pointSchema).min(2).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      delta_y: z
        .number()
        .int()
        .min(-127)
        .max(127)
        .refine((value) => value !== 0),
      delta_x: z.literal(0).optional(),
    })
    .strict(),
]);
export const inputMouseInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    actions: z.array(mouseActionSchema).min(1).max(16),
    timeout_ms: timeout(60_000),
  })
  .strict();

const physicalKeySchema = z.enum(PHYSICAL_KEYS);
const keyboardActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key_down"), key: physicalKeySchema }).strict(),
  z.object({ type: z.literal("key_up"), key: physicalKeySchema }).strict(),
  z.object({ type: z.literal("key_press"), key: physicalKeySchema }).strict(),
  z
    .object({
      type: z.literal("chord"),
      keys: z.array(physicalKeySchema).min(1).max(8),
    })
    .strict(),
]);
export const inputKeyboardInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    actions: z.array(keyboardActionSchema).min(1).max(64),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const inputPasteInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    text: z
      .string()
      .min(1)
      .refine((value) => {
        const withoutBom = value.startsWith("\uFEFF") ? value.slice(1) : value;
        const normalized = withoutBom
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .normalize("NFC");
        const byteLength = Buffer.byteLength(normalized, "utf8");
        return byteLength >= 1 && byteLength <= 262_144;
      }),
    timeout_ms: timeout(300_000),
  })
  .strict();
export const inputReleaseInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    timeout_ms: timeout(60_000),
  })
  .strict();
export const powerControlInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    timeout_ms: timeout(60_000),
  })
  .strict();

const observedFactSchema = <T extends z.ZodTypeAny, U extends z.ZodTypeAny>(
  valueSchema: T,
  noObservationValueSchema: U,
) =>
  z.union([
    z
      .object({
        value: valueSchema,
        observed_at: timestampSchema,
        age_ms: nonNegativeIntegerSchema,
        freshness: z.enum(["fresh", "stale"]),
        source: z.enum(["cached_snapshot", "cached_event"]),
      })
      .strict(),
    z
      .object({
        value: noObservationValueSchema,
        observed_at: z.null(),
        age_ms: z.null(),
        freshness: z.literal("unknown"),
        source: z.literal("none"),
      })
      .strict(),
  ]);

const imageMetadataSchema = z.discriminatedUnion("mime_type", [
  z
    .object({
      content_index: z.literal(1),
      mime_type: z.literal("image/jpeg"),
      sha256: sha256Schema,
      byte_length: z
        .number()
        .int()
        .min(0)
        .max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      content_index: z.literal(1),
      mime_type: z.literal("image/png"),
      sha256: sha256Schema,
      byte_length: nonNegativeIntegerSchema,
    })
    .strict(),
]);

const displayCaptureResultShape = {
  observation_id: opaqueIdSchema,
  connection_epoch: nonNegativeIntegerSchema,
  display_generation: nonNegativeIntegerSchema,
  frame_id: opaqueIdSchema,
  captured_at: timestampSchema,
  source_width: nonNegativeDimensionSchema,
  source_height: nonNegativeDimensionSchema,
  image_width: nonNegativeDimensionSchema,
  image_height: nonNegativeDimensionSchema,
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
  geometry: z
    .object({
      content_x: nonNegativeIntegerSchema,
      content_y: nonNegativeIntegerSchema,
      content_width: nonNegativeDimensionSchema,
      content_height: nonNegativeDimensionSchema,
    })
    .strict(),
  image: imageMetadataSchema,
} as const;
export const displayCaptureResultSchema = z
  .object(displayCaptureResultShape)
  .strict();

const signalValueSchema = z.enum([
  "present",
  "no_signal",
  "no_lock",
  "out_of_range",
  "unknown",
]);
const resolutionSchema = z
  .object({
    width: nonNegativeDimensionSchema,
    height: nonNegativeDimensionSchema,
  })
  .strict();
const nativeResolutionSchema = z
  .object({
    width: nonNegativeDimensionSchema,
    height: nonNegativeDimensionSchema,
    refresh_hz: z.number().nonnegative().finite().nullable(),
  })
  .strict();
const fpsValueSchema = z.number().nonnegative().finite().nullable();

const mutationResult = (extraShape: z.ZodRawShape) =>
  z.object({ ...definitiveMutationShape, ...extraShape }).strict();

export const sessionConnectResultSchema = mutationResult({
  state: z.literal("ready"),
  connection_epoch: nonNegativeIntegerSchema,
  display_generation: nonNegativeIntegerSchema,
  takeover_performed: z.boolean(),
  fresh_capture_required: z.literal(true),
  permissions: z.array(permissionSchema),
  capabilities: capabilitySnapshotSchema,
});
export const sessionStatusResultSchema = z
  .object({
    state: z.enum([
      "connecting",
      "ready",
      "degraded",
      "drained",
      "taken_over",
      "closing",
      "failed",
    ]),
    connection_epoch: nonNegativeIntegerSchema,
    display_generation: nonNegativeIntegerSchema,
    dispatch_generation: nonNegativeIntegerSchema,
    browser_channel_generation: nonNegativeIntegerSchema.nullable(),
    device_reachable: z.boolean().nullable(),
    setup_state: z.enum(["complete", "required", "unknown"]),
    auth_mode: z.enum(["password", "no_password", "unknown"]),
    rpc_reachability: z.enum(["reachable", "unreachable", "unknown"]),
    native_process: z.enum([
      "available",
      "unavailable",
      "restarting",
      "unknown",
    ]),
    web_rtc: z.enum([
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "unknown",
    ]),
    hid: z.enum(["ready", "not_ready", "unknown"]),
    decoded_video: z.enum(["ready", "stalled", "unavailable", "unknown"]),
    native_capture_facts: z
      .object({
        signal: observedFactSchema(signalValueSchema, z.literal("unknown")),
        resolution: observedFactSchema(resolutionSchema.nullable(), z.null()),
        fps: observedFactSchema(fpsValueSchema, z.null()),
      })
      .strict(),
    active_mutation: z.boolean(),
    fresh_capture_required: z.boolean(),
    permissions: z.array(permissionSchema),
    capabilities: capabilitySnapshotSchema,
    blocked_reason: z.string().nullable(),
    versions: z
      .object({
        server: z.string(),
        protocol: z.string(),
        ui_contract: z.string().nullable(),
        firmware: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export const sessionReconnectResultSchema = mutationResult({
  previous_session_generation: nonNegativeIntegerSchema,
  new_session_generation: nonNegativeIntegerSchema,
  connection_epoch: nonNegativeIntegerSchema,
  state: z.literal("ready"),
  takeover_performed: z.boolean(),
  fresh_capture_required: z.literal(true),
});

const edidResultSchema = z.union([
  z
    .object({
      status: z.literal("unsupported"),
      read_completed: z.literal(false),
      reason: z.literal("edid_read_capability_absent"),
      observed_at: z.null(),
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      read_completed: z.literal(true),
      reason: z.literal("successful_read_reported_no_edid"),
      observed_at: timestampSchema,
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      read_completed: z.literal(true),
      reason: z.null(),
      observed_at: timestampSchema,
      data: z
        .object({
          sha256: sha256Schema,
          manufacturer_id: z.string().nullable(),
          product_code: nonNegativeIntegerSchema.nullable(),
          serial_number: z.string().nullable(),
          display_name: z.string().nullable(),
          preferred_resolution: z
            .object({
              width: nonNegativeDimensionSchema,
              height: nonNegativeDimensionSchema,
              refresh_hz: z.number().nonnegative().finite().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
]);
export const displayStatusResultSchema = z
  .object({
    signal: observedFactSchema(signalValueSchema, z.literal("unknown")),
    native_resolution: observedFactSchema(
      nativeResolutionSchema.nullable(),
      z.null(),
    ),
    fps: observedFactSchema(fpsValueSchema, z.null()),
    edid: edidResultSchema,
  })
  .strict();
export const inputMouseResultSchema = mutationResult({
  dispatched_action_count: nonNegativeIntegerSchema,
  completed_action_count: nonNegativeIntegerSchema,
  post_capture: displayCaptureResultSchema.nullable(),
});
export const inputKeyboardResultSchema = mutationResult({
  dispatched_action_count: nonNegativeIntegerSchema,
  completed_action_count: nonNegativeIntegerSchema,
  held_keys: z.array(physicalKeySchema),
  post_capture: displayCaptureResultSchema.nullable(),
});
export const inputPasteResultSchema = mutationResult({
  original_byte_count: nonNegativeIntegerSchema,
  normalized_byte_count: nonNegativeIntegerSchema,
  normalized_sha256: sha256Schema,
  accepted_at: timestampSchema.nullable(),
  completed_at: timestampSchema.nullable(),
  terminal_state: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
  measured_chars_per_second: z.number().nonnegative().finite().nullable(),
  post_capture: displayCaptureResultSchema.nullable(),
});
export const inputReleaseResultSchema = z
  .object({
    ...definitiveMutationShape,
    verification: z.literal("device_state_verified"),
    mutation_gate_closed: z.literal(true),
    deferred_producers_joined: z.literal(true),
    paste_terminal: z.enum(["cancelled", "inactive"]),
    ordinary_leases_zero: z.literal(true),
    keyboard_zero: z.literal(true),
    pointer_zero: z.literal(true),
    generation_drained: z.literal(true),
  })
  .strict();
const atxLedObservationSchema = z
  .object({
    power: z.boolean().nullable(),
    hdd: z.boolean().nullable(),
    observed_at: timestampSchema.nullable(),
    freshness: z.enum(["fresh", "stale", "unknown"]),
  })
  .strict();
const powerResultCommonShape = {
  ...definitiveMutationShape,
  verification: z.literal("device_ack_only"),
  serial_sequence_completed: z.literal(true),
  atx_led_observation: atxLedObservationSchema,
} as const;
export const powerControlResultSchema = z.union([
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("press_power"),
      wire_action: z.literal("power-short"),
      fixed_press_ms: z.literal(200),
    })
    .strict(),
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("hold_power"),
      wire_action: z.literal("power-long"),
      fixed_press_ms: z.literal(5000),
    })
    .strict(),
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("press_reset"),
      wire_action: z.literal("reset"),
      fixed_press_ms: z.literal(200),
    })
    .strict(),
]);

export const TOOL_INPUT_SCHEMAS = {
  jetkvm_display_capture: displayCaptureInputSchema,
  jetkvm_display_status: displayStatusInputSchema,
  jetkvm_input_keyboard: inputKeyboardInputSchema,
  jetkvm_input_mouse: inputMouseInputSchema,
  jetkvm_input_paste: inputPasteInputSchema,
  jetkvm_input_release: inputReleaseInputSchema,
  jetkvm_power_control: powerControlInputSchema,
  jetkvm_session_connect: sessionConnectInputSchema,
  jetkvm_session_reconnect: sessionReconnectInputSchema,
  jetkvm_session_status: sessionStatusInputSchema,
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

export const TOOL_RESULT_PAYLOAD_SCHEMAS = {
  jetkvm_display_capture: displayCaptureResultSchema,
  jetkvm_display_status: displayStatusResultSchema,
  jetkvm_input_keyboard: inputKeyboardResultSchema,
  jetkvm_input_mouse: inputMouseResultSchema,
  jetkvm_input_paste: inputPasteResultSchema,
  jetkvm_input_release: inputReleaseResultSchema,
  jetkvm_power_control: powerControlResultSchema,
  jetkvm_session_connect: sessionConnectResultSchema,
  jetkvm_session_reconnect: sessionReconnectResultSchema,
  jetkvm_session_status: sessionStatusResultSchema,
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

const successForTool = (tool: JetKvmToolName, result: z.ZodTypeAny) =>
  z
    .object({
      ok: z.literal(true),
      tool: z.literal(tool),
      operation_id: opaqueIdSchema,
      session_id: opaqueIdSchema.nullable(),
      session_generation: nonNegativeIntegerSchema.nullable(),
      duration_ms: nonNegativeIntegerSchema,
      result,
    })
    .strict();

export const TOOL_RESULT_SCHEMAS = {
  jetkvm_display_capture: z.union([
    successForTool("jetkvm_display_capture", displayCaptureResultSchema),
    errorForTool("jetkvm_display_capture", displayCaptureErrorBodySchema),
  ]),
  jetkvm_display_status: z.union([
    successForTool("jetkvm_display_status", displayStatusResultSchema),
    errorForTool("jetkvm_display_status", displayStatusErrorBodySchema),
  ]),
  jetkvm_input_keyboard: z.union([
    successForTool("jetkvm_input_keyboard", inputKeyboardResultSchema),
    errorForTool("jetkvm_input_keyboard", inputKeyboardErrorBodySchema),
  ]),
  jetkvm_input_mouse: z.union([
    successForTool("jetkvm_input_mouse", inputMouseResultSchema),
    errorForTool("jetkvm_input_mouse", inputMouseErrorBodySchema),
  ]),
  jetkvm_input_paste: z.union([
    successForTool("jetkvm_input_paste", inputPasteResultSchema),
    errorForTool("jetkvm_input_paste", inputPasteErrorBodySchema),
  ]),
  jetkvm_input_release: z.union([
    successForTool("jetkvm_input_release", inputReleaseResultSchema),
    errorForTool("jetkvm_input_release", inputReleaseErrorBodySchema),
  ]),
  jetkvm_power_control: z.union([
    successForTool("jetkvm_power_control", powerControlResultSchema),
    errorForTool("jetkvm_power_control", powerControlErrorBodySchema),
  ]),
  jetkvm_session_connect: z.union([
    successForTool("jetkvm_session_connect", sessionConnectResultSchema),
    errorForTool("jetkvm_session_connect", sessionConnectErrorBodySchema),
  ]),
  jetkvm_session_reconnect: z.union([
    successForTool("jetkvm_session_reconnect", sessionReconnectResultSchema),
    errorForTool("jetkvm_session_reconnect", sessionReconnectErrorBodySchema),
  ]),
  jetkvm_session_status: z.union([
    successForTool("jetkvm_session_status", sessionStatusResultSchema),
    errorForTool("jetkvm_session_status", sessionStatusErrorBodySchema),
  ]),
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

export const SCHEMA_FILE_NAMES = JETKVM_TOOL_NAMES.flatMap((tool) => [
  `${tool}.input.schema.json`,
  `${tool}.result.schema.json`,
]).sort();

export type JsonSchemaDocument = Record<string, unknown>;

function addNonPortableConstraints(
  tool: JetKvmToolName,
  kind: "input" | "result",
  schema: JsonSchemaDocument,
): JsonSchemaDocument {
  if (tool === "jetkvm_input_paste" && kind === "input") {
    const properties = schema.properties as Record<string, JsonSchemaDocument>;
    properties.text!["x-utf8-byte-max"] = 262_144;
  }
  if (tool === "jetkvm_input_mouse" && kind === "input") {
    const serialized = JSON.stringify(schema);
    const patched = serialized.replace(
      '"minimum":-127,"maximum":127',
      '"minimum":-127,"maximum":127,"not":{"const":0}',
    );
    return JSON.parse(patched) as JsonSchemaDocument;
  }
  return schema;
}

export function generateJsonSchemaDocuments(): Record<
  string,
  JsonSchemaDocument
> {
  const documents: Record<string, JsonSchemaDocument> = {};
  for (const tool of JETKVM_TOOL_NAMES) {
    for (const [kind, schema] of [
      ["input", TOOL_INPUT_SCHEMAS[tool]],
      ["result", TOOL_RESULT_SCHEMAS[tool]],
    ] as const) {
      const document = toJsonSchemaCompat(schema, {
        strictUnions: true,
        target: "jsonSchema7",
        pipeStrategy: kind === "input" ? "input" : "output",
      });
      documents[`${tool}.${kind}.schema.json`] = addNonPortableConstraints(
        tool,
        kind,
        document,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(documents).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}
