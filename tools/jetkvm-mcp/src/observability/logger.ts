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
const MALFORMED_QUOTED_FIELD = /\\?["']((?:\\.|[^"'\\\r\n])+?)\\?["']\s*:/gu;

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

function redactValue(
  value: unknown,
  ancestors: Set<object>,
  errorContext = false,
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, ancestors, errorContext);
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
    return {
      name: redactErrorName(value.name),
      message: REDACTED,
    };
  }
  if (ancestors.has(value)) {
    return REDACTED;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors, errorContext));
    }

    const redactData = isEncodedBinaryDataContainer(value);
    const errorRecord = isErrorRecord(value, errorContext);
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = normalizeFieldName(key);
      if (
        (key === "data" && redactData) ||
        SENSITIVE_FIELD.test(normalizedKey) ||
        (errorRecord && isErrorDiagnosticField(normalizedKey))
      ) {
        redacted[key] = REDACTED;
      } else if (errorRecord && normalizedKey === "name") {
        redacted[key] = redactErrorName(nested);
      } else {
        redacted[key] = redactValue(
          nested,
          ancestors,
          isErrorContextField(normalizedKey),
        );
      }
    }
    return redacted;
  } finally {
    ancestors.delete(value);
  }
}

function redactString(
  value: string,
  ancestors: Set<object>,
  errorContext: boolean,
): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(redactValue(parsed, ancestors, errorContext));
  } catch {
    return SENSITIVE_STRING.test(value) || hasMalformedSensitiveField(value)
      ? REDACTED
      : value;
  }
}
function redactErrorName(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(SAFE_ERROR_NAMES, value)
    ? value
    : "Error";
}

function isErrorRecord(value: object, errorContext: boolean): boolean {
  if (!isPlainObject(value)) {
    return false;
  }

  let diagnosticFieldCount = 0;
  let hasName = false;
  let hasStack = false;
  for (const key of Object.keys(value)) {
    const normalizedKey = normalizeFieldName(key);
    if (isErrorDiagnosticField(normalizedKey)) {
      diagnosticFieldCount += 1;
      hasStack ||= normalizedKey === "stack";
    } else {
      hasName ||= normalizedKey === "name";
    }
  }
  return (
    diagnosticFieldCount > 0 &&
    (errorContext || hasName || hasStack || diagnosticFieldCount > 1)
  );
}

function isErrorDiagnosticField(normalizedKey: string): boolean {
  return (
    normalizedKey === "message" ||
    normalizedKey === "stack" ||
    normalizedKey === "cause" ||
    normalizedKey === "reason"
  );
}

function isErrorContextField(normalizedKey: string): boolean {
  return (
    normalizedKey === "err" ||
    normalizedKey.endsWith("error") ||
    normalizedKey.endsWith("errors") ||
    normalizedKey.endsWith("exception") ||
    normalizedKey.endsWith("exceptions")
  );
}

function hasMalformedSensitiveField(value: string): boolean {
  const trimmed = value.trimStart();
  const jsonLike = trimmed.startsWith("{") || trimmed.startsWith("[");
  for (const match of value.matchAll(MALFORMED_QUOTED_FIELD)) {
    const key = match[1];
    if (
      key !== undefined &&
      ((jsonLike && key.includes("\\")) ||
        SENSITIVE_FIELD.test(normalizeFieldName(key)))
    ) {
      return true;
    }
  }
  return false;
}

function normalizeFieldName(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
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
