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
  .strict();

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
    artifact: z
      .object({
        mimeType: z.enum(["image/jpeg", "image/png"]),
        sha256: sha256Schema,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024),
      })
      .strict(),
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
      delta_y: z.number().int(),
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

const REPLAY_ERROR_CODES = [
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "CONNECTION_LOST",
  "POST_ACK_READ_FAILED",
  "TERMINAL_RESULT_PRESERVED",
  "MALFORMED_RESPONSE",
  "PERMISSION_DENIED",
  "CAPABILITY_MISSING",
  "CONTROL_BUSY",
  "SESSION_TAKEN_OVER",
  "STALE_SESSION_GENERATION",
  "PARTIAL_DISPATCH",
  "CLEANUP_FAILED",
  "FRESH_CAPTURE_REQUIRED",
  "EVENT_GAP",
  "ALREADY_APPLIED",
  "INVALID_BINDING",
  "INVALID_DEADLINE",
  "INVALID_REQUEST",
  "STALE_BINDING",
  "BINDING_REPLACED",
  "WRITE_REJECTED",
  "DUPLICATE_RESPONSE",
  "DOWNSTREAM_ERROR",
] as const;

const replayErrorFields = {
  code: z.enum(REPLAY_ERROR_CODES),
  boundary: z.enum([
    "admission",
    "queue",
    "send",
    "ack",
    "post_ack",
    "persisted",
  ]),
  outcome: z.enum(["not_sent", "unknown", "applied", "already_applied"]),
  writeBegan: z.boolean(),
  acknowledged: z.boolean(),
  verification: z.enum(["none", "device_ack_only", "device_state_verified"]),
} as const;
function replayErrorSchema(counted: boolean) {
  const schema = z
    .object({
      ...replayErrorFields,
      ...(counted
        ? {
            dispatchedCount: z.number().int().nonnegative(),
            completedCount: z.number().int().nonnegative(),
          }
        : {}),
    })
    .strict();
  return schema.superRefine((error, context) => {
    const valid =
      (error.outcome === "not_sent" &&
        !error.writeBegan &&
        !error.acknowledged &&
        error.verification === "none" &&
        ["admission", "queue", "send"].includes(error.boundary)) ||
      (error.outcome === "unknown" &&
        error.writeBegan &&
        !error.acknowledged &&
        error.verification === "none" &&
        ["ack", "post_ack"].includes(error.boundary)) ||
      (error.outcome === "applied" &&
        error.writeBegan &&
        error.acknowledged &&
        error.verification !== "none" &&
        ["ack", "post_ack", "persisted"].includes(error.boundary)) ||
      (error.outcome === "already_applied" &&
        !error.writeBegan &&
        error.acknowledged &&
        error.verification !== "none" &&
        ["admission", "persisted"].includes(error.boundary));
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recorded replay error boundary and outcome are incoherent.",
      });
    }
    if (
      "dispatchedCount" in error &&
      typeof error.dispatchedCount === "number" &&
      "completedCount" in error &&
      typeof error.completedCount === "number" &&
      error.completedCount > error.dispatchedCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recorded replay error counts are incoherent.",
      });
    }
  });
}
const uncountedErrorSchema = replayErrorSchema(false);
const countedErrorSchema = replayErrorSchema(true);

function exchangeSchema(
  operation: string,
  request: z.ZodTypeAny,
  response: z.ZodTypeAny,
  error: z.ZodTypeAny = uncountedErrorSchema,
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
    });
}

const browserExchangeSchema = z.union([
  exchangeSchema("connect", refRequestSchema, connectionSchema),
  exchangeSchema("reconnect", refRequestSchema, connectionSchema),
  exchangeSchema("capture", captureRequestSchema, observationSchema),
  exchangeSchema(
    "mouse",
    mouseRequestSchema,
    mutationReceiptSchema,
    countedErrorSchema,
  ),
  exchangeSchema(
    "keyboard",
    keyboardRequestSchema,
    mutationReceiptSchema,
    countedErrorSchema,
  ),
  exchangeSchema(
    "paste",
    pasteRequestSchema,
    pasteReceiptSchema,
    countedErrorSchema,
  ),
  exchangeSchema(
    "release",
    releaseRequestSchema,
    releaseReceiptSchema,
    countedErrorSchema,
  ),
  exchangeSchema("close", refRequestSchema, z.null()),
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
  ),
  exchangeSchema("powerControl", powerRequestSchema, atxSchema),
]);
const deviceRpcExchangeSchema = z.union([
  exchangeSchema("readDisplayState", bindingRequestSchema, displaySchema),
  exchangeSchema("readEdid", bindingRequestSchema, edidSchema),
  exchangeSchema("performAtx", devicePowerRequestSchema, atxSchema),
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

  public constructor(recorded: SanitizedReplayRecordedError) {
    super(`The replay recorded ${recorded.code}.`);
    this.code = recorded.code;
    this.boundary = recorded.boundary;
    this.outcome = recorded.outcome;
    this.writeBegan = recorded.writeBegan;
    this.acknowledged = recorded.acknowledged;
    this.verification = recorded.verification;
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
