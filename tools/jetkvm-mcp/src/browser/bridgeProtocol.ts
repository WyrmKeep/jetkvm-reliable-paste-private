import { z } from "zod";

import type { ErrorCode, RequiredNextStep } from "../errors.js";
import { OPAQUE_ID_PATTERN } from "../device/DeviceRpcAdapter.js";

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
  | { readonly kind: "wheel"; readonly delta_y: number };
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
export interface ReadBridgeResult {
  readonly operation_id: string;
  readonly lifecycle_generation: number;
  readonly channel_generation: number;
  readonly acknowledged_at: string;
  readonly result: JsonValue;
}

export const AUTOMATION_BRIDGE_ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_READY",
  "UNMOUNTED",
  "CLOSED",
  "GENERATION_MISMATCH",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "CHANNEL_LOST",
  "DISPLAY_CHANGED",
  "DISPATCH_REPLACED",
  "DOWNSTREAM_ERROR",
  "EDID_READ_FAILED",
  "MALFORMED_ACKNOWLEDGEMENT",
  "VIDEO_STALLED",
  "CAPTURE_FAILED",
  "CAPTURE_TOO_LARGE",
  "MIME_MISMATCH",
  "PASTE_UNSUPPORTED",
  "PASTE_LIFECYCLE",
  "RELEASE_FAILED",
] as const;
export type AutomationBridgeErrorCode =
  (typeof AUTOMATION_BRIDGE_ERROR_CODES)[number];
export const AUTOMATION_BRIDGE_STAGES = [
  "admission",
  "queue",
  "write",
  "acknowledgement",
  "verification",
] as const;
export type AutomationBridgeStage = (typeof AUTOMATION_BRIDGE_STAGES)[number];
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

export interface BridgeCallSuccessEnvelope {
  readonly ok: true;
  readonly value: unknown;
}
export interface BridgeCallErrorEnvelope {
  readonly ok: false;
  readonly error: AutomationBridgeError;
}
export type BridgeCallEnvelope =
  | BridgeCallSuccessEnvelope
  | BridgeCallErrorEnvelope;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const positiveSafeIntegerSchema = z.number().int().min(1).max(MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SAFE_INTEGER);
const operationIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const keyboardLayoutSchema = z.string().min(1).max(128).nullable();
const imageDimensionSchema = z.number().int().min(1).max(16_384);
const CAPTURE_BASE64_MAX_LENGTH = 4 * Math.ceil((8 * 1024 * 1024) / 3);
const MAX_JSON_WIRE_CHARACTERS = 1024 * 1024;

const bridgeRequestShape = {
  operation_id: operationIdSchema,
  expected_lifecycle_generation: positiveSafeIntegerSchema,
  expected_channel_generation: positiveSafeIntegerSchema,
  timeout_ms: z.number().int().min(100).max(300_000),
} as const;
const inputBridgeRequestShape = {
  ...bridgeRequestShape,
  expected_display_generation: positiveSafeIntegerSchema,
  expected_dispatch_generation: positiveSafeIntegerSchema,
} as const;

const automationSnapshotSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["ready", "not_ready", "unmounted", "closed"]),
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema,
    dispatch_generation: positiveSafeIntegerSchema,
    rpc_ready: z.boolean(),
    hid_ready: z.boolean(),
    video_ready: z.boolean(),
    absolute_pointer: z.boolean(),
    scroll_throttling_disabled: z.boolean(),
    keyboard_layout: keyboardLayoutSchema,
    reliable_paste: z.boolean(),
    source_width: imageDimensionSchema.nullable(),
    source_height: imageDimensionSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      (snapshot.source_width === null) !==
      (snapshot.source_height === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_width"],
        message: "Source dimensions must both be present or both be null.",
      });
    }
  });

const captureBridgeRequestSchema = z
  .object({
    ...bridgeRequestShape,
    timeout_ms: z.number().int().min(100).max(60_000),
    format: z.enum(["jpeg", "png"]),
    max_width: z.number().int().min(64).max(1920),
    max_height: z.number().int().min(64).max(1080),
  })
  .strict();

const captureBridgeResultSchema = z
  .object({
    operation_id: operationIdSchema,
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema,
    frame_sequence: positiveSafeIntegerSchema,
    captured_at: timestampSchema,
    source_width: imageDimensionSchema,
    source_height: imageDimensionSchema,
    image_width: imageDimensionSchema,
    image_height: imageDimensionSchema,
    rotation: z.literal(0),
    geometry: z
      .object({
        x: z.literal(0),
        y: z.literal(0),
        width: imageDimensionSchema,
        height: imageDimensionSchema,
      })
      .strict(),
    format: z.enum(["jpeg", "png"]),
    mime_type: z.enum(["image/jpeg", "image/png"]),
    byte_length: positiveSafeIntegerSchema.max(8 * 1024 * 1024),
    sha256: sha256Schema,
    base64: z.string().min(4).max(CAPTURE_BASE64_MAX_LENGTH),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedMime = result.format === "jpeg" ? "image/jpeg" : "image/png";
    if (result.mime_type !== expectedMime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mime_type"],
        message: "Capture format and MIME type must agree.",
      });
    }
    if (
      result.geometry.width !== result.image_width ||
      result.geometry.height !== result.image_height
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["geometry"],
        message: "Capture geometry must cover the complete returned image.",
      });
    }
  });

const mouseBridgeOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("absolute"),
      x: z.number().int().min(0).max(32_767),
      y: z.number().int().min(0).max(32_767),
      buttons: z.number().int().min(0).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wheel"),
      delta_y: z
        .number()
        .int()
        .min(-127)
        .max(127)
        .refine((value) => value !== 0),
    })
    .strict(),
]);
const mouseBridgeRequestSchema = z
  .object({
    ...inputBridgeRequestShape,
    timeout_ms: z.number().int().min(100).max(60_000),
    operations: z.array(mouseBridgeOperationSchema).min(1).max(1056),
  })
  .strict();
const keyboardBridgeOperationSchema = z
  .object({
    key: z.number().int().min(0).max(255),
    press: z.boolean(),
  })
  .strict();
const keyboardBridgeRequestSchema = z
  .object({
    ...inputBridgeRequestShape,
    timeout_ms: z.number().int().min(100).max(60_000),
    operations: z.array(keyboardBridgeOperationSchema).min(1).max(1024),
  })
  .strict();

const mutationBridgeReceiptSchema = z
  .object({
    operation_id: operationIdSchema,
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema,
    dispatch_generation: positiveSafeIntegerSchema,
    queued_at: timestampSchema,
    acknowledged_at: timestampSchema,
    dispatched_count: positiveSafeIntegerSchema,
    completed_count: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.completed_count > receipt.dispatched_count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_count"],
        message: "Completed count cannot exceed dispatched count.",
      });
    }
    if (Date.parse(receipt.queued_at) > Date.parse(receipt.acknowledged_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acknowledged_at"],
        message: "Mutation acknowledgement cannot precede queue admission.",
      });
    }
  });

const pasteBridgeRequestSchema = z
  .object({
    ...inputBridgeRequestShape,
    text: z.string().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    const withoutBom = request.text.startsWith("\uFEFF")
      ? request.text.slice(1)
      : request.text;
    const normalized = withoutBom
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .normalize("NFC");
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes < 1 || bytes > 262_144) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message:
          "Normalized paste text must contain 1 through 262144 UTF-8 bytes.",
      });
    }
  });
const pasteBridgeReceiptSchema = z
  .object({
    operation_id: operationIdSchema,
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema,
    dispatch_generation: positiveSafeIntegerSchema,
    original_byte_count: positiveSafeIntegerSchema,
    normalized_byte_count: positiveSafeIntegerSchema.max(262_144),
    normalized_sha256: sha256Schema,
    accepted_at: timestampSchema,
    completed_at: timestampSchema,
    terminal_state: z.literal("succeeded"),
    measured_source_cps: z.number().positive().finite(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.accepted_at) > Date.parse(receipt.completed_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_at"],
        message: "Paste completion cannot precede acceptance.",
      });
    }
  });
const releaseBridgeRequestSchema = z
  .object({
    ...inputBridgeRequestShape,
    timeout_ms: z.number().int().min(100).max(60_000),
  })
  .strict();
const releaseBridgeReceiptSchema = z
  .object({
    operation_id: operationIdSchema,
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema,
    dispatch_generation: positiveSafeIntegerSchema,
    device_generation: positiveSafeIntegerSchema,
    outcome: z.literal("released"),
    draining: z.literal(true),
    producers_joined: z.literal(true),
    macro_inactive: z.literal(true),
    paste_inactive: z.literal(true),
    ordinary_leases_zero: z.literal(true),
    keyboard_zero: z.literal(true),
    pointer_zero: z.literal(true),
    released_at: timestampSchema,
  })
  .strict();
const readBridgeRequestSchema = z
  .object({
    ...bridgeRequestShape,
    timeout_ms: z.number().int().min(100).max(30_000),
  })
  .strict();

const jsonPrimitiveSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(262_144),
  z.null(),
]);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema).max(4096),
    z.record(z.string().min(1).max(128), jsonValueSchema),
  ]),
);
const readBridgeResultSchema = z
  .object({
    operation_id: operationIdSchema,
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    acknowledged_at: timestampSchema,
    result: jsonValueSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (!Object.hasOwn(result, "result")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Read result is required.",
      });
      return;
    }
    if (JSON.stringify(result.result).length > MAX_JSON_WIRE_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Read result exceeds its wire bound.",
      });
    }
  });

const SAFE_BRIDGE_MESSAGES: Readonly<
  Record<AutomationBridgeErrorCode, string>
> = Object.freeze({
  INVALID_REQUEST: "The automation request is invalid.",
  NOT_READY: "The managed device route is not ready.",
  UNMOUNTED: "The managed device route is unmounted.",
  CLOSED: "The automation mutation gate is closed.",
  GENERATION_MISMATCH: "The automation generation is stale.",
  DEADLINE_EXCEEDED: "The automation deadline elapsed.",
  CANCELLED: "The automation operation was cancelled.",
  CHANNEL_LOST: "The managed product channel was lost.",
  DISPLAY_CHANGED: "The decoded display changed.",
  DISPATCH_REPLACED: "The input dispatch generation changed.",
  DOWNSTREAM_ERROR: "The product operation failed.",
  EDID_READ_FAILED: "The native EDID read failed.",
  MALFORMED_ACKNOWLEDGEMENT: "The product acknowledgement was invalid.",
  VIDEO_STALLED: "The decoded video did not advance.",
  CAPTURE_FAILED: "The decoded frame could not be captured.",
  CAPTURE_TOO_LARGE: "The captured frame exceeds the byte limit.",
  MIME_MISMATCH: "The captured frame MIME type is invalid.",
  PASTE_UNSUPPORTED: "Reliable Paste is unavailable.",
  PASTE_LIFECYCLE: "Reliable Paste completion could not be verified.",
  RELEASE_FAILED: "The correlated input release could not be verified.",
});
const automationBridgeErrorSchema = z
  .object({
    version: z.literal(1),
    name: z.literal("JetKvmAutomationError"),
    code: z.enum(AUTOMATION_BRIDGE_ERROR_CODES),
    stage: z.enum(AUTOMATION_BRIDGE_STAGES),
    outcome: z.enum(["not_sent", "unknown"]),
    operation_id: operationIdSchema.nullable(),
    lifecycle_generation: positiveSafeIntegerSchema,
    channel_generation: positiveSafeIntegerSchema,
    display_generation: positiveSafeIntegerSchema.nullable(),
    dispatch_generation: positiveSafeIntegerSchema.nullable(),
    write_began: z.boolean(),
    acknowledged: z.boolean(),
    dispatched_count: nonNegativeSafeIntegerSchema,
    completed_count: nonNegativeSafeIntegerSchema,
    message: z.string(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.message !== SAFE_BRIDGE_MESSAGES[error.code]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "Bridge error message is not the fixed sanitized value.",
      });
    }
    if (error.outcome !== (error.write_began ? "unknown" : "not_sent")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Bridge error outcome does not match its write boundary.",
      });
    }
    if (error.completed_count > error.dispatched_count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_count"],
        message: "Completed count cannot exceed dispatched count.",
      });
    }
    if (
      !error.write_began &&
      (error.acknowledged ||
        error.dispatched_count !== 0 ||
        error.completed_count !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["write_began"],
        message: "A not-written bridge error cannot report write progress.",
      });
    }
  });

const bridgeCallEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({ ok: z.literal(false), error: automationBridgeErrorSchema })
    .strict(),
]);

export function parseAutomationSnapshot(value: unknown): AutomationSnapshot {
  return automationSnapshotSchema.parse(value);
}
export function parseCaptureBridgeRequest(
  value: unknown,
): CaptureBridgeRequest {
  return captureBridgeRequestSchema.parse(value);
}
export function parseCaptureBridgeResult(value: unknown): CaptureBridgeResult {
  return captureBridgeResultSchema.parse(value);
}
export function parseMouseBridgeRequest(value: unknown): MouseBridgeRequest {
  return mouseBridgeRequestSchema.parse(value);
}
export function parseKeyboardBridgeRequest(
  value: unknown,
): KeyboardBridgeRequest {
  return keyboardBridgeRequestSchema.parse(value);
}
export function parseMutationBridgeReceipt(
  value: unknown,
): MutationBridgeReceipt {
  return mutationBridgeReceiptSchema.parse(value);
}
export function parsePasteBridgeRequest(value: unknown): PasteBridgeRequest {
  return pasteBridgeRequestSchema.parse(value);
}
export function parsePasteBridgeReceipt(value: unknown): PasteBridgeReceipt {
  return pasteBridgeReceiptSchema.parse(value);
}
export function parseReleaseBridgeRequest(
  value: unknown,
): ReleaseBridgeRequest {
  return releaseBridgeRequestSchema.parse(value);
}
export function parseReleaseBridgeReceipt(
  value: unknown,
): ReleaseBridgeReceipt {
  return releaseBridgeReceiptSchema.parse(value);
}
export function parseReadBridgeRequest(value: unknown): ReadBridgeRequest {
  return readBridgeRequestSchema.parse(value);
}
export function parseReadBridgeResult(value: unknown): ReadBridgeResult {
  return readBridgeResultSchema.parse(value);
}
export function parseAutomationBridgeError(
  value: unknown,
): AutomationBridgeError {
  return automationBridgeErrorSchema.parse(value);
}
export function parseBridgeCallEnvelope(value: unknown): BridgeCallEnvelope {
  const parsed = bridgeCallEnvelopeSchema.parse(value);
  if (parsed.ok) {
    if (!Object.hasOwn(parsed, "value")) {
      throw new TypeError("Bridge success envelope is missing its value.");
    }
    return { ok: true, value: parsed.value };
  }
  return { ok: false, error: parsed.error };
}

export type BrowserPlaneErrorOutcome = "not_sent" | "unknown" | "applied";
export type BrowserPlaneErrorBoundary =
  | "admission"
  | "queue"
  | "send"
  | "ack"
  | "post_ack";

export interface BrowserPlaneErrorInit {
  readonly code: ErrorCode;
  readonly outcome: BrowserPlaneErrorOutcome;
  readonly stage: AutomationBridgeStage;
  readonly writeBegan: boolean;
  readonly acknowledged: boolean;
  readonly dispatchedCount: number;
  readonly completedCount: number;
  readonly requestedCount: number;
  readonly failedIndex?: number;
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
  readonly suffixSuppressed: boolean;
}

const SAFE_PLANE_MESSAGES: Partial<Record<ErrorCode, string>> = Object.freeze({
  CANCELLED: "The browser operation was cancelled.",
  DEADLINE_EXCEEDED: "The browser operation deadline elapsed.",
  CONNECTION_LOST: "The managed browser connection was lost.",
  SESSION_DRAINED: "The browser input generation is closed.",
  STALE_SESSION_GENERATION: "The browser session generation is stale.",
  DISPLAY_CHANGED: "The decoded display changed.",
  DOWNSTREAM_MALFORMED_RESPONSE: "The browser bridge response was invalid.",
  VIDEO_STALLED: "The decoded video did not advance.",
  VIDEO_UNAVAILABLE: "The decoded frame is unavailable.",
  CAPABILITY_MISSING: "The browser capability is unavailable.",
  EVENT_GAP: "The correlated input lifecycle is incomplete.",
  MUTATION_OUTCOME_UNKNOWN: "The browser mutation outcome is unknown.",
  PARTIAL_VERIFICATION:
    "The browser mutation was acknowledged but verification failed.",
  INVALID_COORDINATE: "The input coordinate is invalid.",
  INVALID_KEY: "The physical key transition is invalid.",
  STALE_OBSERVATION: "The observation is stale.",
  OBSERVATION_CONSUMED: "The observation was already consumed.",
});

function bridgeStageToBoundary(
  stage: AutomationBridgeStage,
): BrowserPlaneErrorBoundary {
  switch (stage) {
    case "admission":
      return "admission";
    case "queue":
      return "queue";
    case "write":
      return "send";
    case "acknowledgement":
      return "ack";
    case "verification":
      return "post_ack";
  }
}

function mapBridgeCode(error: AutomationBridgeError): {
  readonly code: ErrorCode;
  readonly requiredNextStep: RequiredNextStep;
} {
  if (error.acknowledged) {
    return { code: "PARTIAL_VERIFICATION", requiredNextStep: "none" };
  }
  switch (error.code) {
    case "DEADLINE_EXCEEDED":
      return { code: "DEADLINE_EXCEEDED", requiredNextStep: "none" };
    case "CANCELLED":
      return { code: "CANCELLED", requiredNextStep: "none" };
    case "CLOSED":
    case "DISPATCH_REPLACED":
      return {
        code: "SESSION_DRAINED",
        requiredNextStep: "reconnect_then_capture",
      };
    case "GENERATION_MISMATCH":
      return {
        code: "CONNECTION_LOST",
        requiredNextStep: "reconnect_then_capture",
      };
    case "DISPLAY_CHANGED":
      return {
        code: "DISPLAY_CHANGED",
        requiredNextStep: "capture_then_retry",
      };
    case "EDID_READ_FAILED":
      return { code: "EDID_READ_FAILED", requiredNextStep: "none" };
    case "VIDEO_STALLED":
      return { code: "VIDEO_STALLED", requiredNextStep: "capture_then_retry" };
    case "CAPTURE_FAILED":
    case "CAPTURE_TOO_LARGE":
      return {
        code: "VIDEO_UNAVAILABLE",
        requiredNextStep: "capture_then_retry",
      };
    case "PASTE_UNSUPPORTED":
      return {
        code: "CAPABILITY_MISSING",
        requiredNextStep: "enable_capability",
      };
    case "PASTE_LIFECYCLE":
      return {
        code: "EVENT_GAP",
        requiredNextStep: "release_then_reconnect_then_capture",
      };
    case "INVALID_REQUEST":
    case "MALFORMED_ACKNOWLEDGEMENT":
    case "MIME_MISMATCH":
      return {
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        requiredNextStep: error.write_began
          ? "inspect_device_state_before_retry"
          : "reconnect_then_capture",
      };
    case "NOT_READY":
    case "UNMOUNTED":
    case "CHANNEL_LOST":
      return {
        code: "CONNECTION_LOST",
        requiredNextStep: error.write_began
          ? "inspect_device_state_before_retry"
          : "reconnect_then_capture",
      };
    case "DOWNSTREAM_ERROR":
    case "RELEASE_FAILED":
      return {
        code: error.write_began
          ? "MUTATION_OUTCOME_UNKNOWN"
          : "CONNECTION_LOST",
        requiredNextStep: error.write_began
          ? "inspect_device_state_before_retry"
          : "reconnect_then_capture",
      };
  }
}

export class BrowserPlaneError extends Error {
  public readonly name = "BrowserPlaneError";
  public readonly code: ErrorCode;
  public readonly outcome: BrowserPlaneErrorOutcome;
  public readonly stage: AutomationBridgeStage;
  public readonly boundary: BrowserPlaneErrorBoundary;
  public readonly writeBegan: boolean;
  public readonly acknowledged: boolean;
  public readonly dispatchedCount: number;
  public readonly completedCount: number;
  public readonly requestedCount: number;
  public readonly failedIndex: number | undefined;
  public readonly safeToRetry: boolean;
  public readonly requiredNextStep: RequiredNextStep;
  public readonly suffixSuppressed: boolean;

  public constructor(init: BrowserPlaneErrorInit) {
    super(SAFE_PLANE_MESSAGES[init.code] ?? "The browser operation failed.");
    this.code = init.code;
    this.outcome = init.outcome;
    this.stage = init.stage;
    this.boundary = bridgeStageToBoundary(init.stage);
    this.writeBegan = init.writeBegan;
    this.acknowledged = init.acknowledged;
    this.dispatchedCount = init.dispatchedCount;
    this.completedCount = init.completedCount;
    this.requestedCount = init.requestedCount;
    this.failedIndex = init.failedIndex;
    this.safeToRetry = init.safeToRetry;
    this.requiredNextStep = init.requiredNextStep;
    this.suffixSuppressed = init.suffixSuppressed;
  }

  public static fromBridge(
    error: AutomationBridgeError,
    requestedCount: number,
  ): BrowserPlaneError {
    if (
      error.dispatched_count > requestedCount ||
      error.completed_count > requestedCount
    ) {
      return new BrowserPlaneError({
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        outcome: error.write_began ? "unknown" : "not_sent",
        stage: error.stage,
        writeBegan: error.write_began,
        acknowledged: false,
        dispatchedCount: Math.min(error.dispatched_count, requestedCount),
        completedCount: Math.min(error.completed_count, requestedCount),
        requestedCount,
        safeToRetry: false,
        requiredNextStep: error.write_began
          ? "inspect_device_state_before_retry"
          : "reconnect_then_capture",
        suffixSuppressed: error.write_began,
      });
    }
    const mapped = mapBridgeCode(error);
    const outcome: BrowserPlaneErrorOutcome = error.acknowledged
      ? "applied"
      : error.outcome;
    const failedIndex =
      !error.acknowledged &&
      error.write_began &&
      error.dispatched_count === error.completed_count + 1
        ? error.completed_count
        : undefined;
    return new BrowserPlaneError({
      code: mapped.code,
      outcome,
      stage: error.stage,
      writeBegan: error.write_began,
      acknowledged: error.acknowledged,
      dispatchedCount: error.dispatched_count,
      completedCount: error.completed_count,
      requestedCount,
      ...(failedIndex === undefined ? {} : { failedIndex }),
      safeToRetry:
        outcome === "not_sent" &&
        (mapped.code === "CANCELLED" ||
          mapped.code === "DEADLINE_EXCEEDED" ||
          mapped.code === "DISPLAY_CHANGED" ||
          mapped.code === "CONNECTION_LOST" ||
          mapped.code === "VIDEO_STALLED" ||
          mapped.code === "VIDEO_UNAVAILABLE"),
      requiredNextStep: mapped.requiredNextStep,
      suffixSuppressed: error.write_began && !error.acknowledged,
    });
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      outcome: this.outcome,
      stage: this.stage,
      boundary: this.boundary,
      writeBegan: this.writeBegan,
      acknowledged: this.acknowledged,
      dispatchedCount: this.dispatchedCount,
      completedCount: this.completedCount,
      requestedCount: this.requestedCount,
      ...(this.failedIndex === undefined
        ? {}
        : { failedIndex: this.failedIndex }),
      safeToRetry: this.safeToRetry,
      requiredNextStep: this.requiredNextStep,
      suffixSuppressed: this.suffixSuppressed,
    };
  }
}
