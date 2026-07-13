const REDACTED = "[REDACTED]";
const SAFE_EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SAFE_ERROR_NAMES: Readonly<Record<string, true>> = {
  AggregateError: true,
  Error: true,
  EvalError: true,
  RangeError: true,
  ReferenceError: true,
  SyntaxError: true,
  TypeError: true,
  URIError: true,
};
const SENSITIVE_FIELD =
  /(?:address|authorization|authority|base64|bearer|bytes|clipboard|cookie|credential|endpoint|frame|host|ice|image|origin|password|paste|payload|proof|screenshot|sdp|secret|text|token|uri|url)/u;
const SENSITIVE_STRING =
  /(?:\b(?:https?|wss?|file):\/\/|\bBearer\s+\S+|\b(?:[a-z0-9_]*(?:authorization|bearer|cookie|credential|password|secret|token)[a-z0-9_]*)\s*[:=]\s*\S+|\bcandidate:\d+|\ba=fingerprint:|(?:^|\r?\n)v=0(?:\r?\n|$)|data:image\/)/iu;
const MALFORMED_QUOTED_SENSITIVE_FIELD =
  /(?:\\?["'])[a-z0-9_.-]*(?:authorization|cookie|password|token|url)[a-z0-9_.-]*(?:\\?["'])\s*:/iu;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogSink {
  write(line: string): void;
  now?: () => Date;
}

export interface StructuredLogger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function redactStructuredData(value: unknown): unknown {
  return redactValue(value, new Set<object>());
}

export function createStructuredLogger(
  sink: StructuredLogSink = {
    write(line: string): void {
      process.stderr.write(line);
    },
  },
): StructuredLogger {
  const write = (
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (!isPlainObject(fields)) {
      throw new TypeError("Structured log fields must be a plain object");
    }

    const redactedFields = redactStructuredData(fields);
    if (!isPlainObject(redactedFields)) {
      throw new TypeError("Structured log fields must be a plain object");
    }

    const record: StructuredLogRecord = {
      timestamp: (sink.now ?? (() => new Date()))().toISOString(),
      level,
      event: SAFE_EVENT_NAME.test(event) ? event : REDACTED,
      fields: redactedFields,
    };
    sink.write(`${JSON.stringify(record)}\n`);
  };

  return Object.freeze({
    debug(event: string, fields?: Readonly<Record<string, unknown>>): void {
      write("debug", event, fields);
    },
    info(event: string, fields?: Readonly<Record<string, unknown>>): void {
      write("info", event, fields);
    },
    warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
      write("warn", event, fields);
    },
    error(event: string, fields?: Readonly<Record<string, unknown>>): void {
      write("error", event, fields);
    },
  });
}

function redactValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, ancestors);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return REDACTED;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return REDACTED;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    const name = value.name;
    return {
      name: Object.hasOwn(SAFE_ERROR_NAMES, name) ? name : "Error",
      message: REDACTED,
    };
  }
  if (ancestors.has(value)) {
    return REDACTED;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }

    const redactData = isEncodedBinaryDataContainer(value);

    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
      redacted[key] =
        (key === "data" && redactData) || SENSITIVE_FIELD.test(normalizedKey)
          ? REDACTED
          : redactValue(nested, ancestors);
    }
    return redacted;
  } finally {
    ancestors.delete(value);
  }
}

function redactString(value: string, ancestors: Set<object>): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(redactValue(parsed, ancestors));
  } catch {
    return SENSITIVE_STRING.test(value) ||
      MALFORMED_QUOTED_SENSITIVE_FIELD.test(value)
      ? REDACTED
      : value;
  }
}

function isEncodedBinaryDataContainer(value: object): boolean {
  if (!Object.hasOwn(value, "data")) {
    return false;
  }
  const type = "type" in value ? value.type : undefined;
  const mimeType = "mimeType" in value ? value.mimeType : undefined;
  return (
    type === "image" ||
    type === "Buffer" ||
    (typeof mimeType === "string" && /^image\/(?:jpeg|png)$/iu.test(mimeType))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
