import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

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
  | JsonValue[]
  | { [key: string]: JsonValue };

const exchangeSchema = z
  .object({
    operation: z.string().min(1).max(64),
    request: jsonValueSchema,
    response: jsonValueSchema.optional(),
    error: z
      .object({ code: z.string().min(1).max(128) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((exchange, context) => {
    if ((exchange.response === undefined) === (exchange.error === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one replay response or error is required.",
      });
    }
  });

const tapeSchema = z
  .object({
    version: z.literal(1),
    plane: z.enum(["browser", "native", "device_rpc"]),
    exchanges: z.array(exchangeSchema).max(10_000),
  })
  .strict();

export interface SanitizedReplayExchange {
  readonly operation: string;
  readonly request: JsonValue;
  readonly response?: JsonValue;
  readonly error?: { readonly code: string };
}

export interface SanitizedReplayTape {
  readonly version: 1;
  readonly plane: "browser" | "native" | "device_rpc";
  readonly exchanges: readonly SanitizedReplayExchange[];
}

const FORBIDDEN_KEY =
  /^(?:url|uri|credential|credentials|password|cookie|authorization|secret|token|sdp|ice|ice_candidate|frame|frame_bytes|image|image_bytes|media|media_payload|paste_text|text|payload)$/i;
const FORBIDDEN_VALUE =
  /(?:https?:\/\/|wss?:\/\/|\bBearer\s+|^candidate:|^v=0(?:\r?\n|$)|^data:image\/)/i;

export function validateSanitizedReplayTape(
  input: unknown,
): SanitizedReplayTape {
  const parsed = tapeSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid sanitized replay tape.");
  scanForForbiddenContent(parsed.data, "$tape");
  return {
    version: 1,
    plane: parsed.data.plane,
    exchanges: parsed.data.exchanges.map((exchange) =>
      exchange.error === undefined
        ? {
            operation: exchange.operation,
            request: exchange.request,
            response: exchange.response as JsonValue,
          }
        : {
            operation: exchange.operation,
            request: exchange.request,
            error: exchange.error,
          },
    ),
  };
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
    if (FORBIDDEN_KEY.test(key)) {
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

  public constructor(public readonly code: string) {
    super(`The replay recorded ${code}.`);
  }
}

export class SanitizedReplayCursor {
  private index = 0;

  public constructor(
    tape: unknown,
    expectedPlane: SanitizedReplayTape["plane"],
  ) {
    this.tape = validateSanitizedReplayTape(tape);
    if (this.tape.plane !== expectedPlane) {
      throw new Error(`Replay tape plane must be ${expectedPlane}.`);
    }
  }

  private readonly tape: SanitizedReplayTape;

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
      throw new ReplayRecordedError(exchange.error.code);
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
