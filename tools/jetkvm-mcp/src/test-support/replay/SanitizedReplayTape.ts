import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { PHYSICAL_KEYS } from "../../domain.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const sessionRefSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    sessionGeneration: z.number().int().positive(),
  })
  .strict();
const bindingSchema = sessionRefSchema
  .extend({
    connectionEpoch: z.number().int().positive(),
    browserChannelGeneration: z.number().int().positive(),
  })
  .strict();
const refRequestSchema = z.object({ ref: sessionRefSchema }).strict();
const bindingRequestSchema = z.object({ ref: bindingSchema }).strict();
const requestIdSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();

const factMetadata = {
  observedAt: timestampSchema.nullable(),
  ageMs: z.number().int().nonnegative().nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  source: z.enum(["cached_snapshot", "cached_event", "none"]),
} as const;
const displaySchema = z
  .object({
    signal: z
      .object({
        value: z.enum([
          "present",
          "no_signal",
          "no_lock",
          "out_of_range",
          "unknown",
        ]),
        ...factMetadata,
      })
      .strict(),
    resolution: z
      .object({
        value: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            refreshHz: z.number().positive().nullable(),
          })
          .strict()
          .nullable(),
        ...factMetadata,
      })
      .strict(),
    fps: z
      .object({ value: z.number().nonnegative().nullable(), ...factMetadata })
      .strict(),
    qualification: z.enum(["current_binding", "binding_lost_cached_only"]),
  })
  .strict();
const edidSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unsupported"),
      readCompleted: z.literal(false),
      reason: z.literal("edid_read_capability_absent"),
      observedAt: z.null(),
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      readCompleted: z.literal(true),
      reason: z.literal("successful_read_reported_no_edid"),
      observedAt: timestampSchema,
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      readCompleted: z.literal(true),
      reason: z.null(),
      observedAt: timestampSchema,
      data: z
        .object({
          sha256: sha256Schema,
          manufacturerId: z.string().nullable(),
          productCode: z.number().int().nonnegative().nullable(),
          serialNumber: z.string().nullable(),
          displayName: z.string().nullable(),
          preferredResolution: z
            .object({
              width: z.number().int().positive(),
              height: z.number().int().positive(),
              refreshHz: z.number().positive().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
]);
const atxActionSchema = z.enum(["press_power", "hold_power", "press_reset"]);
type ReplayAtxAction = z.infer<typeof atxActionSchema>;
type ReplayAtxWireAction = "power-short" | "power-long" | "reset";
const ATX_REPLAY_SEMANTICS: Readonly<
  Record<
    ReplayAtxAction,
    {
      readonly wireAction: ReplayAtxWireAction;
      readonly fixedPressMs: 200 | 5000;
    }
  >
> = {
  press_power: { wireAction: "power-short", fixedPressMs: 200 },
  hold_power: { wireAction: "power-long", fixedPressMs: 5000 },
  press_reset: { wireAction: "reset", fixedPressMs: 200 },
};

export function atxReplayReceiptMatchesRequest(
  request: { readonly requestId: string; readonly action: ReplayAtxAction },
  receipt: {
    readonly requestId: string;
    readonly action: ReplayAtxAction;
    readonly wireAction: ReplayAtxWireAction;
    readonly fixedPressMs: 200 | 5000;
  },
): boolean {
  const expected = ATX_REPLAY_SEMANTICS[request.action];
  return (
    receipt.requestId === request.requestId &&
    receipt.action === request.action &&
    receipt.wireAction === expected.wireAction &&
    receipt.fixedPressMs === expected.fixedPressMs
  );
}

const atxSchema = z
  .object({
    requestId: requestIdSchema,
    action: atxActionSchema,
    wireAction: z.enum(["power-short", "power-long", "reset"]),
    fixedPressMs: z.union([z.literal(200), z.literal(5000)]),
    serialSequenceCompleted: z.literal(true),
    acknowledgedAt: timestampSchema,
    atxLedObservation: z
      .object({
        power: z.boolean().nullable(),
        hdd: z.boolean().nullable(),
        observedAt: timestampSchema.nullable(),
        freshness: z.enum(["fresh", "stale", "unknown"]),
      })
      .strict(),
    verification: z.literal("device_ack_only"),
    postRead: z
      .object({ status: z.enum(["available", "unavailable"]) })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (!atxReplayReceiptMatchesRequest(receipt, receipt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Replay ATX action does not match its fixed wire semantics.",
      });
    }
  });

const connectionSchema = z
  .object({
    state: z.literal("ready"),
    ref: sessionRefSchema,
    binding: bindingSchema,
    connectionEpoch: z.number().int().positive(),
    browserChannelGeneration: z.number().int().positive(),
    displayGeneration: z.number().int().positive(),
  })
  .strict();
const observationArtifactSchema = z.discriminatedUnion("mimeType", [
  z
    .object({
      mimeType: z.literal("image/jpeg"),
      sha256: sha256Schema,
      byteLength: z
        .number()
        .int()
        .positive()
        .max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      mimeType: z.literal("image/png"),
      sha256: sha256Schema,
      byteLength: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    })
    .strict(),
]);
const observationSchema = z
  .object({
    observationId: z.string().min(1).max(256),
    sessionGeneration: z.number().int().positive(),
    connectionEpoch: z.number().int().positive(),
    displayGeneration: z.number().int().positive(),
    frameId: z.string().min(1).max(256),
    capturedAt: timestampSchema,
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    imageWidth: z.number().int().positive(),
    imageHeight: z.number().int().positive(),
    rotation: z.union([
      z.literal(0),
      z.literal(90),
      z.literal(180),
      z.literal(270),
    ]),
    geometry: z
      .object({
        contentX: z.number().nonnegative(),
        contentY: z.number().nonnegative(),
        contentWidth: z.number().positive(),
        contentHeight: z.number().positive(),
      })
      .strict(),
    artifact: observationArtifactSchema,
  })
  .strict();
const mutationReceiptSchema = z
  .object({
    requestId: requestIdSchema,
    outcome: z.enum(["applied", "already_applied"]),
    verification: z.enum(["device_ack_only", "device_state_verified"]),
    dispatchedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    acknowledgedAt: timestampSchema,
  })
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);
const pasteReceiptSchema = z
  .object({
    requestId: requestIdSchema,
    outcome: z.enum(["applied", "already_applied"]),
    verification: z.enum(["device_ack_only", "device_state_verified"]),
    dispatchedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    acknowledgedAt: timestampSchema,
    originalByteCount: z.number().int().nonnegative(),
    normalizedByteCount: z.number().int().nonnegative(),
    normalizedSha256: sha256Schema,
    acceptedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    terminalState: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    measuredCharsPerSecond: z.number().nonnegative().nullable(),
  })
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);
const releaseReceiptSchema = z
  .object({
    requestId: requestIdSchema,
    outcome: z.enum(["applied", "already_applied"]),
    verification: z.enum(["device_ack_only", "device_state_verified"]),
    dispatchedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    acknowledgedAt: timestampSchema,
    mutationGateClosed: z.boolean(),
    deferredProducersJoined: z.boolean(),
    pasteTerminal: z.enum(["cancelled", "inactive", "unknown"]),
    ordinaryLeasesZero: z.boolean().nullable(),
    keyboardZero: z.boolean().nullable(),
    pointerZero: z.boolean().nullable(),
    generationDrained: z.boolean(),
    heldKeys: z.array(z.enum(PHYSICAL_KEYS)),
  })
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);

const pointSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const mouseActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["click", "double_click"]),
      x: z.number().finite(),
      y: z.number().finite(),
      button: z.enum(["left", "middle", "right"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      button: z.enum(["left", "middle", "right"]),
      path: z.array(pointSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().finite(),
      y: z.number().finite(),
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
const keyboardActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["key_down", "key_up", "key_press"]),
      key: z.enum(PHYSICAL_KEYS),
    })
    .strict(),
  z
    .object({ type: z.literal("chord"), keys: z.array(z.enum(PHYSICAL_KEYS)) })
    .strict(),
]);
const browserMutationRequest = <T extends z.ZodTypeAny>(request: T) =>
  z.object({ ref: sessionRefSchema, request }).strict();
const mouseRequestSchema = browserMutationRequest(
  z
    .object({
      observationId: z.string().min(1).max(256),
      requestId: requestIdSchema,
      actions: z.array(mouseActionSchema),
    })
    .strict(),
);
const keyboardRequestSchema = browserMutationRequest(
  z
    .object({
      observationId: z.string().min(1).max(256),
      requestId: requestIdSchema,
      actions: z.array(keyboardActionSchema),
    })
    .strict(),
);
const pasteRequestSchema = browserMutationRequest(
  z
    .object({
      observationId: z.string().min(1).max(256),
      requestId: requestIdSchema,
      textByteLength: z.number().int().nonnegative(),
      sourceCharacterCount: z.number().int().nonnegative(),
      textSha256: sha256Schema,
    })
    .strict(),
);
const releaseRequestSchema = browserMutationRequest(
  z.object({ requestId: requestIdSchema }).strict(),
);
const captureRequestSchema = browserMutationRequest(
  z
    .object({
      format: z.enum(["jpeg", "png"]),
      maxWidth: z.number().int().positive(),
      maxHeight: z.number().int().positive(),
    })
    .strict(),
);
const powerRequestSchema = z
  .object({
    ref: sessionRefSchema,
    request: z
      .object({ requestId: requestIdSchema, action: atxActionSchema })
      .strict(),
  })
  .strict();
const devicePowerRequestSchema = z
  .object({
    ref: bindingSchema,
    request: z
      .object({ requestId: requestIdSchema, action: atxActionSchema })
      .strict(),
  })
  .strict();

type ReplayErrorCode =
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "CONNECTION_LOST"
  | "POST_ACK_READ_FAILED"
  | "TERMINAL_RESULT_PRESERVED"
  | "MALFORMED_RESPONSE"
  | "PERMISSION_DENIED"
  | "AUTH_FAILED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_EXPIRED"
  | "UNSUPPORTED_UI_VERSION"
  | "FIRMWARE_INCOMPATIBLE"
  | "BROWSER_UNSUPPORTED"
  | "DEVICE_UNREACHABLE"
  | "CAPABILITY_MISSING"
  | "CONTROL_BUSY"
  | "SESSION_TAKEN_OVER"
  | "STALE_SESSION_GENERATION"
  | "PARTIAL_DISPATCH"
  | "CLEANUP_FAILED"
  | "FRESH_CAPTURE_REQUIRED"
  | "EVENT_GAP"
  | "ALREADY_APPLIED"
  | "INVALID_BINDING"
  | "INVALID_DEADLINE"
  | "INVALID_REQUEST"
  | "STALE_BINDING"
  | "BINDING_REPLACED"
  | "WRITE_REJECTED"
  | "DUPLICATE_RESPONSE"
  | "DOWNSTREAM_ERROR";
type ReplayErrorBoundary =
  | "admission"
  | "queue"
  | "send"
  | "ack"
  | "post_ack"
  | "persisted";
type ReplayErrorOutcome =
  | "not_sent"
  | "unknown"
  | "applied"
  | "already_applied";
type ReplayErrorVerification =
  | "none"
  | "device_ack_only"
  | "device_state_verified";
type ReplayCountRule =
  | "zero"
  | "partial"
  | "partial_dispatch"
  | "complete"
  | "bounded";
interface ReplayErrorRule {
  readonly code: ReplayErrorCode;
  readonly boundary: ReplayErrorBoundary;
  readonly outcome: ReplayErrorOutcome;
  readonly writeBegan: boolean;
  readonly acknowledged: boolean;
  readonly verification: ReplayErrorVerification;
  readonly counts: ReplayCountRule;
}

const ERROR_RULES = {
  deadlineAdmission: {
    code: "DEADLINE_EXCEEDED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  deadlineQueue: {
    code: "DEADLINE_EXCEEDED",
    boundary: "queue",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  deadlineSend: {
    code: "DEADLINE_EXCEEDED",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  deadlineAck: {
    code: "DEADLINE_EXCEEDED",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  cancelledAdmission: {
    code: "CANCELLED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  cancelledQueue: {
    code: "CANCELLED",
    boundary: "queue",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  cancelledSend: {
    code: "CANCELLED",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  cancelledAck: {
    code: "CANCELLED",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  connectionAdmission: {
    code: "CONNECTION_LOST",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  connectionQueue: {
    code: "CONNECTION_LOST",
    boundary: "queue",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  connectionSend: {
    code: "CONNECTION_LOST",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  connectionAck: {
    code: "CONNECTION_LOST",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  postAckRead: {
    code: "POST_ACK_READ_FAILED",
    boundary: "post_ack",
    outcome: "applied",
    writeBegan: true,
    acknowledged: true,
    verification: "device_ack_only",
    counts: "complete",
  },
  terminalPreserved: {
    code: "TERMINAL_RESULT_PRESERVED",
    boundary: "persisted",
    outcome: "applied",
    writeBegan: true,
    acknowledged: true,
    verification: "device_ack_only",
    counts: "complete",
  },
  malformedSend: {
    code: "MALFORMED_RESPONSE",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  malformedAck: {
    code: "MALFORMED_RESPONSE",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  permissionAdmission: {
    code: "PERMISSION_DENIED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  authFailedAdmission: {
    code: "AUTH_FAILED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  authRateLimitedAdmission: {
    code: "AUTH_RATE_LIMITED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  authExpiredAdmission: {
    code: "AUTH_EXPIRED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  unsupportedUiVersionAdmission: {
    code: "UNSUPPORTED_UI_VERSION",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  firmwareIncompatibleAdmission: {
    code: "FIRMWARE_INCOMPATIBLE",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  browserUnsupportedAdmission: {
    code: "BROWSER_UNSUPPORTED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  deviceUnreachableAdmission: {
    code: "DEVICE_UNREACHABLE",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  capabilityAdmission: {
    code: "CAPABILITY_MISSING",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  controlBusyAdmission: {
    code: "CONTROL_BUSY",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  sessionTakenAck: {
    code: "SESSION_TAKEN_OVER",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  staleGenerationAdmission: {
    code: "STALE_SESSION_GENERATION",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  partialDispatch: {
    code: "PARTIAL_DISPATCH",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial_dispatch",
  },
  cleanupFailure: {
    code: "CLEANUP_FAILED",
    boundary: "post_ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "bounded",
  },
  freshCaptureAdmission: {
    code: "FRESH_CAPTURE_REQUIRED",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  eventGap: {
    code: "EVENT_GAP",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  alreadyApplied: {
    code: "ALREADY_APPLIED",
    boundary: "admission",
    outcome: "already_applied",
    writeBegan: false,
    acknowledged: true,
    verification: "device_ack_only",
    counts: "complete",
  },
  invalidBindingAdmission: {
    code: "INVALID_BINDING",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  invalidDeadlineAdmission: {
    code: "INVALID_DEADLINE",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  invalidRequestAdmission: {
    code: "INVALID_REQUEST",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  staleBindingAdmission: {
    code: "STALE_BINDING",
    boundary: "admission",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  bindingReplacedQueue: {
    code: "BINDING_REPLACED",
    boundary: "queue",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  bindingReplacedSend: {
    code: "BINDING_REPLACED",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  bindingReplacedAck: {
    code: "BINDING_REPLACED",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  writeRejectedSend: {
    code: "WRITE_REJECTED",
    boundary: "send",
    outcome: "not_sent",
    writeBegan: false,
    acknowledged: false,
    verification: "none",
    counts: "zero",
  },
  duplicateResponseAck: {
    code: "DUPLICATE_RESPONSE",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
  downstreamErrorAck: {
    code: "DOWNSTREAM_ERROR",
    boundary: "ack",
    outcome: "unknown",
    writeBegan: true,
    acknowledged: false,
    verification: "none",
    counts: "partial",
  },
} as const satisfies Record<string, ReplayErrorRule>;

function replayErrorSchema(
  counted: boolean,
  rules: readonly ReplayErrorRule[],
): z.ZodTypeAny {
  const variants = rules.map((rule) => {
    const exactFields = {
      code: z.literal(rule.code),
      boundary: z.literal(rule.boundary),
      outcome: z.literal(rule.outcome),
      writeBegan: z.literal(rule.writeBegan),
      acknowledged: z.literal(rule.acknowledged),
      verification: z.literal(rule.verification),
    };
    if (!counted) return z.object(exactFields).strict();
    if (rule.counts === "partial_dispatch") {
      return z
        .object({
          ...exactFields,
          requestedCount: z.number().int().positive(),
          dispatchedCount: z.number().int().nonnegative(),
          completedCount: z.number().int().nonnegative(),
        })
        .strict()
        .superRefine((error, context) => {
          if (
            error.completedCount > error.dispatchedCount ||
            error.dispatchedCount >= error.requestedCount
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "Partial dispatch requires completed <= dispatched < requested.",
            });
          }
        });
    }
    return z
      .object({
        ...exactFields,
        dispatchedCount: z.number().int().nonnegative(),
        completedCount: z.number().int().nonnegative(),
      })
      .strict()
      .superRefine((error, context) => {
        const dispatchedCount = error.dispatchedCount;
        const completedCount = error.completedCount;
        const countsAreValid =
          (rule.counts === "zero" &&
            dispatchedCount === 0 &&
            completedCount === 0) ||
          (rule.counts === "partial" &&
            dispatchedCount > 0 &&
            completedCount < dispatchedCount) ||
          (rule.counts === "complete" && completedCount === dispatchedCount) ||
          (rule.counts === "bounded" &&
            dispatchedCount > 0 &&
            completedCount <= dispatchedCount);
        if (!countsAreValid) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Recorded replay error counts are incoherent.",
          });
        }
      });
  });
  const [first, second, ...rest] = variants;
  if (first === undefined || second === undefined) {
    throw new Error(
      "Replay error schemas require at least two legal variants.",
    );
  }
  return z.union([first, second, ...rest]);
}

const highLevelCommonErrorRules = [
  ERROR_RULES.deadlineAdmission,
  ERROR_RULES.cancelledAdmission,
  ERROR_RULES.connectionSend,
  ERROR_RULES.connectionAck,
  ERROR_RULES.malformedAck,
  ERROR_RULES.permissionAdmission,
  ERROR_RULES.capabilityAdmission,
  ERROR_RULES.sessionTakenAck,
  ERROR_RULES.staleGenerationAdmission,
] as const;
const browserConnectErrorSchema = replayErrorSchema(false, [
  ERROR_RULES.deadlineAdmission,
  ERROR_RULES.cancelledAdmission,
  ERROR_RULES.connectionSend,
  ERROR_RULES.connectionAck,
  ERROR_RULES.malformedAck,
  ERROR_RULES.permissionAdmission,
  ERROR_RULES.sessionTakenAck,
  ERROR_RULES.staleGenerationAdmission,
  ERROR_RULES.controlBusyAdmission,
  ERROR_RULES.authFailedAdmission,
  ERROR_RULES.authRateLimitedAdmission,
  ERROR_RULES.authExpiredAdmission,
  ERROR_RULES.unsupportedUiVersionAdmission,
  ERROR_RULES.firmwareIncompatibleAdmission,
  ERROR_RULES.browserUnsupportedAdmission,
  ERROR_RULES.deviceUnreachableAdmission,
]);
const browserReadErrorSchema = replayErrorSchema(
  false,
  highLevelCommonErrorRules,
);
const browserCloseErrorSchema = replayErrorSchema(false, [
  ERROR_RULES.connectionSend,
  ERROR_RULES.connectionAck,
  ERROR_RULES.sessionTakenAck,
  ERROR_RULES.staleGenerationAdmission,
]);
const browserMutationCommonErrorRules = [
  ...highLevelCommonErrorRules,
  ERROR_RULES.postAckRead,
  ERROR_RULES.terminalPreserved,
  ERROR_RULES.cleanupFailure,
  ERROR_RULES.alreadyApplied,
] as const;
const browserObservedMutationErrorSchema = replayErrorSchema(true, [
  ...browserMutationCommonErrorRules,
  ERROR_RULES.partialDispatch,
  ERROR_RULES.freshCaptureAdmission,
]);
const browserPasteErrorSchema = replayErrorSchema(true, [
  ...browserMutationCommonErrorRules,
  ERROR_RULES.partialDispatch,
  ERROR_RULES.eventGap,
  ERROR_RULES.freshCaptureAdmission,
]);
const browserReleaseErrorSchema = replayErrorSchema(
  true,
  browserMutationCommonErrorRules,
);
const nativeReadErrorSchema = replayErrorSchema(
  false,
  highLevelCommonErrorRules,
);
const nativePowerErrorSchema = replayErrorSchema(false, [
  ...highLevelCommonErrorRules,
  ERROR_RULES.postAckRead,
  ERROR_RULES.terminalPreserved,
  ERROR_RULES.alreadyApplied,
]);
const deviceRpcCommonErrorRules = [
  ERROR_RULES.invalidBindingAdmission,
  ERROR_RULES.invalidDeadlineAdmission,
  ERROR_RULES.staleBindingAdmission,
  ERROR_RULES.bindingReplacedQueue,
  ERROR_RULES.bindingReplacedSend,
  ERROR_RULES.bindingReplacedAck,
  ERROR_RULES.cancelledAdmission,
  ERROR_RULES.cancelledQueue,
  ERROR_RULES.cancelledSend,
  ERROR_RULES.cancelledAck,
  ERROR_RULES.deadlineQueue,
  ERROR_RULES.deadlineSend,
  ERROR_RULES.deadlineAck,
  ERROR_RULES.connectionAdmission,
  ERROR_RULES.connectionQueue,
  ERROR_RULES.connectionSend,
  ERROR_RULES.connectionAck,
  ERROR_RULES.writeRejectedSend,
  ERROR_RULES.malformedSend,
  ERROR_RULES.malformedAck,
  ERROR_RULES.duplicateResponseAck,
  ERROR_RULES.downstreamErrorAck,
] as const;
const deviceRpcReadErrorSchema = replayErrorSchema(
  false,
  deviceRpcCommonErrorRules,
);
const deviceRpcAtxErrorSchema = replayErrorSchema(false, [
  ...deviceRpcCommonErrorRules,
  ERROR_RULES.invalidRequestAdmission,
]);

type ReplayResponseCorrelation = (
  request: unknown,
  response: unknown,
) => boolean;

function exchangeSchema(
  operation: string,
  request: z.ZodTypeAny,
  response: z.ZodTypeAny,
  error: z.ZodTypeAny,
  responseMatchesRequest?: ReplayResponseCorrelation,
  errorMatchesRequest?: ReplayResponseCorrelation,
) {
  return z
    .object({
      operation: z.literal(operation),
      request,
      response: response.optional(),
      error: error.optional(),
    })
    .strict()
    .superRefine((exchange, context) => {
      if (
        (exchange.response === undefined) ===
        (exchange.error === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Exactly one replay response or error is required.",
        });
      }
      if (
        exchange.response !== undefined &&
        responseMatchesRequest !== undefined &&
        !responseMatchesRequest(exchange.request, exchange.response)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Replay response does not correlate with its request.",
        });
      }
      if (
        exchange.error !== undefined &&
        errorMatchesRequest !== undefined &&
        !errorMatchesRequest(exchange.request, exchange.error)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Replay error does not correlate with its request.",
        });
      }
    });
}

const atxResponseMatchesRequest: ReplayResponseCorrelation = (
  request,
  response,
) => {
  const typedRequest = request as {
    readonly request: {
      readonly requestId: string;
      readonly action: ReplayAtxAction;
    };
  };
  return atxReplayReceiptMatchesRequest(
    typedRequest.request,
    response as z.infer<typeof atxSchema>,
  );
};

const browserConnectionResponseMatchesRequest: ReplayResponseCorrelation = (
  request,
  response,
) => {
  const typedRequest = request as z.infer<typeof refRequestSchema>;
  const typedResponse = response as z.infer<typeof connectionSchema>;
  return (
    isDeepStrictEqual(typedResponse.ref, typedRequest.ref) &&
    isDeepStrictEqual(typedResponse.binding, {
      ...typedResponse.ref,
      connectionEpoch: typedResponse.connectionEpoch,
      browserChannelGeneration: typedResponse.browserChannelGeneration,
    })
  );
};

const browserCaptureResponseMatchesRequest: ReplayResponseCorrelation = (
  request,
  response,
) => {
  const typedRequest = request as z.infer<typeof captureRequestSchema>;
  const typedResponse = response as z.infer<typeof observationSchema>;
  const expectedMimeType =
    typedRequest.request.format === "jpeg" ? "image/jpeg" : "image/png";
  return (
    typedResponse.sessionGeneration === typedRequest.ref.sessionGeneration &&
    typedResponse.artifact.mimeType === expectedMimeType
  );
};

const browserMutationResponseMatchesRequest: ReplayResponseCorrelation = (
  request,
  response,
) => {
  const typedRequest = request as {
    readonly request: { readonly requestId: string };
  };
  const typedResponse = response as { readonly requestId: string };
  return typedResponse.requestId === typedRequest.request.requestId;
};

const browserMultiActionErrorMatchesRequest: ReplayResponseCorrelation = (
  request,
  error,
) => {
  const typedError = error as {
    readonly code: string;
    readonly requestedCount?: number;
  };
  if (typedError.code !== "PARTIAL_DISPATCH") return true;
  const typedRequest = request as {
    readonly request: { readonly actions: readonly unknown[] };
  };
  return typedError.requestedCount === typedRequest.request.actions.length;
};

const browserPasteErrorMatchesRequest: ReplayResponseCorrelation = (
  request,
  error,
) => {
  const typedError = error as {
    readonly code: string;
    readonly requestedCount?: number;
  };
  if (typedError.code !== "PARTIAL_DISPATCH") return true;
  const typedRequest = request as z.infer<typeof pasteRequestSchema>;
  return (
    typedError.requestedCount === typedRequest.request.sourceCharacterCount
  );
};

const browserExchangeSchema = z.union([
  exchangeSchema(
    "connect",
    refRequestSchema,
    connectionSchema,
    browserConnectErrorSchema,
    browserConnectionResponseMatchesRequest,
  ),
  exchangeSchema(
    "reconnect",
    refRequestSchema,
    connectionSchema,
    browserConnectErrorSchema,
    browserConnectionResponseMatchesRequest,
  ),
  exchangeSchema(
    "capture",
    captureRequestSchema,
    observationSchema,
    browserReadErrorSchema,
    browserCaptureResponseMatchesRequest,
  ),
  exchangeSchema(
    "mouse",
    mouseRequestSchema,
    mutationReceiptSchema,
    browserObservedMutationErrorSchema,
    browserMutationResponseMatchesRequest,
    browserMultiActionErrorMatchesRequest,
  ),
  exchangeSchema(
    "keyboard",
    keyboardRequestSchema,
    mutationReceiptSchema,
    browserObservedMutationErrorSchema,
    browserMutationResponseMatchesRequest,
    browserMultiActionErrorMatchesRequest,
  ),
  exchangeSchema(
    "paste",
    pasteRequestSchema,
    pasteReceiptSchema,
    browserPasteErrorSchema,
    browserMutationResponseMatchesRequest,
    browserPasteErrorMatchesRequest,
  ),
  exchangeSchema(
    "release",
    releaseRequestSchema,
    releaseReceiptSchema,
    browserReleaseErrorSchema,
    browserMutationResponseMatchesRequest,
  ),
  exchangeSchema("close", refRequestSchema, z.null(), browserCloseErrorSchema),
]);
const nativeExchangeSchema = z.union([
  exchangeSchema(
    "sessionStatus",
    refRequestSchema,
    z
      .object({
        rpcReachability: z.literal("reachable"),
        nativeProcess: z.literal("available"),
        display: displaySchema,
      })
      .strict(),
    nativeReadErrorSchema,
  ),
  exchangeSchema(
    "displayStatus",
    refRequestSchema,
    z
      .object({
        signal: displaySchema.shape.signal,
        resolution: displaySchema.shape.resolution,
        fps: displaySchema.shape.fps,
        qualification: displaySchema.shape.qualification,
        edid: edidSchema,
      })
      .strict(),
    nativeReadErrorSchema,
  ),
  exchangeSchema(
    "powerControl",
    powerRequestSchema,
    atxSchema,
    nativePowerErrorSchema,
    atxResponseMatchesRequest,
  ),
]);
const deviceRpcExchangeSchema = z.union([
  exchangeSchema(
    "readDisplayState",
    bindingRequestSchema,
    displaySchema,
    deviceRpcReadErrorSchema,
  ),
  exchangeSchema(
    "readEdid",
    bindingRequestSchema,
    edidSchema,
    deviceRpcReadErrorSchema,
  ),
  exchangeSchema(
    "performAtx",
    devicePowerRequestSchema,
    atxSchema,
    deviceRpcAtxErrorSchema,
    atxResponseMatchesRequest,
  ),
]);
const strictTapeSchema = z.discriminatedUnion("plane", [
  z
    .object({
      version: z.literal(1),
      plane: z.literal("browser"),
      exchanges: z.array(browserExchangeSchema).max(10_000),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      plane: z.literal("native"),
      exchanges: z.array(nativeExchangeSchema).max(10_000),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      plane: z.literal("device_rpc"),
      exchanges: z.array(deviceRpcExchangeSchema).max(10_000),
    })
    .strict(),
]);
const structuralTapeSchema = z
  .object({
    version: z.literal(1),
    plane: z.enum(["browser", "native", "device_rpc"]),
    exchanges: z
      .array(
        z
          .object({
            operation: z.string().min(1).max(64),
            request: jsonValueSchema,
            response: jsonValueSchema.optional(),
            error: jsonValueSchema.optional(),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export interface SanitizedReplayRecordedError {
  readonly code: string;
  readonly boundary:
    | "admission"
    | "queue"
    | "send"
    | "ack"
    | "post_ack"
    | "persisted";
  readonly outcome: "not_sent" | "unknown" | "applied" | "already_applied";
  readonly writeBegan: boolean;
  readonly acknowledged: boolean;
  readonly verification: "none" | "device_ack_only" | "device_state_verified";
  readonly dispatchedCount?: number;
  readonly completedCount?: number;
  readonly requestedCount?: number;
}
export interface SanitizedReplayExchange {
  readonly operation: string;
  readonly request: JsonValue;
  readonly response?: JsonValue;
  readonly error?: SanitizedReplayRecordedError;
}
export interface SanitizedReplayTape {
  readonly version: 1;
  readonly plane: "browser" | "native" | "device_rpc";
  readonly exchanges: readonly SanitizedReplayExchange[];
}

const SAFE_DERIVED_KEYS: Readonly<Record<string, true>> = {
  frameid: true,
  imagewidth: true,
  imageheight: true,
  textbytelength: true,
  textsha256: true,
};
const FORBIDDEN_KEY_PARTS = [
  "url",
  "uri",
  "credential",
  "password",
  "cookie",
  "authorization",
  "secret",
  "token",
  "auth",
  "header",
  "apikey",
  "privatekey",
  "authheader",
  "requestheader",
  "rawheader",
  "pastetext",
  "screenshot",
  "frame",
  "base64",
  "media",
  "sdp",
  "payload",
] as const;
const FORBIDDEN_VALUE =
  /(?:https?:\/\/|wss?:\/\/|\bBearer\s+|^candidate:|^v=0(?:\r?\n|$)|^data:image\/)/i;

export function validateSanitizedReplayTape(
  input: unknown,
): SanitizedReplayTape {
  const structural = structuralTapeSchema.safeParse(input);
  if (!structural.success) throw new Error("Invalid sanitized replay tape.");
  scanForForbiddenContent(structural.data, "$tape");
  const parsed = strictTapeSchema.safeParse(structural.data);
  if (!parsed.success) throw new Error("Invalid sanitized replay tape.");
  return parsed.data as SanitizedReplayTape;
}

function scanForForbiddenContent(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      throw new Error(`Forbidden replay tape content at ${path}.`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForForbiddenContent(entry, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const forbiddenIceKey =
      normalizedKey === "ice" ||
      normalizedKey.startsWith("ice") ||
      normalizedKey.includes("icecandidate") ||
      normalizedKey.includes("iceserver") ||
      normalizedKey.includes("iceconfig") ||
      normalizedKey.includes("webrtcice") ||
      normalizedKey.includes("localice") ||
      normalizedKey.includes("remoteice");
    if (
      SAFE_DERIVED_KEYS[normalizedKey] !== true &&
      (forbiddenIceKey ||
        normalizedKey === "text" ||
        normalizedKey === "image" ||
        FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part)))
    ) {
      throw new Error(`Forbidden replay tape content at ${path}.${key}.`);
    }
    scanForForbiddenContent(entry, `${path}.${key}`);
  }
}

export class ReplayMismatchError extends Error {
  public readonly name = "ReplayMismatchError";

  public constructor(
    public readonly index: number,
    message: string,
  ) {
    super(message);
  }
}

export class ReplayRecordedError extends Error {
  public readonly name = "ReplayRecordedError";
  public readonly code: string;
  public readonly boundary: SanitizedReplayRecordedError["boundary"];
  public readonly outcome: SanitizedReplayRecordedError["outcome"];
  public readonly writeBegan: boolean;
  public readonly acknowledged: boolean;
  public readonly verification: SanitizedReplayRecordedError["verification"];
  public readonly dispatchedCount?: number;
  public readonly completedCount?: number;
  public readonly requestedCount?: number;
  public readonly safeToRetry: boolean;
  public readonly requiredNextStep:
    | "none"
    | "reconnect_then_capture"
    | "inspect_device_state_before_retry"
    | "wait_or_request_takeover"
    | "grant_permission"
    | "enable_capability";

  public constructor(recorded: SanitizedReplayRecordedError) {
    super(`The replay recorded ${recorded.code}.`);
    this.code = recorded.code;
    this.boundary = recorded.boundary;
    this.outcome = recorded.outcome;
    this.writeBegan = recorded.writeBegan;
    this.acknowledged = recorded.acknowledged;
    this.verification = recorded.verification;
    if (recorded.outcome !== "not_sent") {
      this.safeToRetry = false;
      this.requiredNextStep = "inspect_device_state_before_retry";
    } else if (
      recorded.code === "DEVICE_UNREACHABLE" ||
      recorded.code === "CONNECTION_LOST"
    ) {
      this.safeToRetry = true;
      this.requiredNextStep = "reconnect_then_capture";
    } else if (recorded.code === "PERMISSION_DENIED") {
      this.safeToRetry = false;
      this.requiredNextStep = "grant_permission";
    } else if (recorded.code === "CAPABILITY_MISSING") {
      this.safeToRetry = false;
      this.requiredNextStep = "enable_capability";
    } else if (recorded.code === "CONTROL_BUSY") {
      this.safeToRetry = true;
      this.requiredNextStep = "wait_or_request_takeover";
    } else {
      this.safeToRetry =
        recorded.code === "AUTH_RATE_LIMITED" ||
        recorded.code === "CANCELLED" ||
        recorded.code === "DEADLINE_EXCEEDED";
      this.requiredNextStep = "none";
    }
    if (recorded.requestedCount !== undefined) {
      this.requestedCount = recorded.requestedCount;
    }
    if (recorded.dispatchedCount !== undefined) {
      this.dispatchedCount = recorded.dispatchedCount;
    }
    if (recorded.completedCount !== undefined) {
      this.completedCount = recorded.completedCount;
    }
  }
}

export class SanitizedReplayCursor {
  private index = 0;
  private readonly tape: SanitizedReplayTape;

  public constructor(
    tape: unknown,
    expectedPlane: SanitizedReplayTape["plane"],
  ) {
    this.tape = validateSanitizedReplayTape(tape);
    if (this.tape.plane !== expectedPlane) {
      throw new Error(`Replay tape plane must be ${expectedPlane}.`);
    }
  }

  public get position(): number {
    return this.index;
  }

  public consume(operation: string, request: JsonValue): JsonValue {
    const exchange = this.tape.exchanges[this.index];
    if (exchange === undefined) {
      throw new ReplayMismatchError(
        this.index,
        `Unexpected replay call ${operation}; tape is exhausted.`,
      );
    }
    if (exchange.operation !== operation) {
      throw new ReplayMismatchError(
        this.index,
        `Unexpected replay call ${operation}; expected ${exchange.operation}.`,
      );
    }
    if (!isDeepStrictEqual(exchange.request, request)) {
      throw new ReplayMismatchError(
        this.index,
        `Replay request shape mismatch for ${operation}.`,
      );
    }
    this.index += 1;
    if (exchange.error !== undefined)
      throw new ReplayRecordedError(exchange.error);
    if (exchange.response === undefined) {
      throw new ReplayMismatchError(
        this.index - 1,
        `Replay ${operation} has no response.`,
      );
    }
    return exchange.response;
  }

  public assertResult(
    operation: string,
    expected: JsonValue,
    actual: unknown,
  ): void {
    if (!isJsonValue(actual) || !isDeepStrictEqual(expected, actual)) {
      throw new ReplayMismatchError(
        this.index - 1,
        `Replay result shape mismatch for ${operation}.`,
      );
    }
  }

  public assertExhausted(): void {
    const remaining = this.tape.exchanges.length - this.index;
    if (remaining !== 0)
      throw new Error(`${remaining} replay exchange(s) remain unconsumed.`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}
