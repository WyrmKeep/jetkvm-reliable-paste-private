import { createHash } from "node:crypto";
import { z } from "zod";

export interface SessionRef {
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface Deadline {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}
const CANONICAL_OPAQUE_ID_MAX_CODE_UNITS = 128;
export const OPAQUE_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,${CANONICAL_OPAQUE_ID_MAX_CODE_UNITS - 1}}$`,
);

export function isCanonicalOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

/** The sole internal device/RPC ownership tuple. */
export interface DeviceRpcBinding extends SessionRef {
  readonly connectionEpoch: number;
  readonly browserChannelGeneration: number;
}

export interface DeviceRpcWireBinding {
  readonly session_id: string;
  readonly session_generation: number;
  readonly connection_epoch: number;
  readonly browser_channel_generation: number;
}

export type DeviceRpcChannelMessageListener = (payload: string) => void;
export type DeviceRpcChannelCloseListener = () => void;
export interface DeviceRpcChannelWriteResult {
  readonly written: boolean;
}

/** A handle to the one RPC data channel owned by BrowserPlane. */
export interface BrowserOwnedRpcChannel {
  readonly readyState: "open" | "closed";
  listen(
    onMessage: DeviceRpcChannelMessageListener,
    onClose: DeviceRpcChannelCloseListener,
  ): () => void;
  write(payload: string): DeviceRpcChannelWriteResult;
  close(): void;
}

export type FactFreshness = "fresh" | "stale" | "unknown";
export type FactSource = "cached_event" | "none";

export interface QualifiedFact<T> {
  readonly value: T;
  readonly observedAt: string | null;
  readonly ageMs: number | null;
  readonly freshness: FactFreshness;
  readonly source: FactSource;
}

export type NativeSignal =
  | "present"
  | "no_signal"
  | "no_lock"
  | "out_of_range"
  | "unknown";
export interface NativeResolution {
  readonly width: number;
  readonly height: number;
  readonly refreshHz: number | null;
}

export interface CachedDisplayState {
  readonly signal: QualifiedFact<NativeSignal>;
  readonly resolution: QualifiedFact<NativeResolution | null>;
  readonly fps: QualifiedFact<number | null>;
  readonly qualification: "current_binding" | "binding_lost_cached_only";
}

export type QualifiedEdidRead =
  | {
      readonly status: "unsupported";
      readonly readCompleted: false;
      readonly reason: "edid_read_capability_absent";
      readonly observedAt: null;
      readonly data: null;
    }
  | {
      readonly status: "unavailable";
      readonly readCompleted: true;
      readonly reason: "successful_read_reported_no_edid";
      readonly observedAt: string;
      readonly data: null;
    }
  | {
      readonly status: "available";
      readonly readCompleted: true;
      readonly reason: null;
      readonly observedAt: string;
      readonly data: {
        readonly sha256: string;
        readonly manufacturerId: string | null;
        readonly productCode: number | null;
        readonly serialNumber: string | null;
        readonly displayName: string | null;
        readonly preferredResolution: NativeResolution | null;
      };
    };

export type AtxAction = "press_power" | "hold_power" | "press_reset";
export type AtxWireAction = "power-short" | "power-long" | "reset";
export type AtxLedObservation =
  | {
      readonly power: boolean | null;
      readonly hdd: boolean | null;
      readonly observedAt: string;
      readonly freshness: "fresh" | "stale";
    }
  | {
      readonly power: null;
      readonly hdd: null;
      readonly observedAt: null;
      readonly freshness: "unknown";
    };

export interface AtxWireReceipt {
  readonly requestId: string;
  readonly action: AtxAction;
  readonly wireAction: AtxWireAction;
  readonly fixedPressMs: 200 | 5000;
  readonly serialSequenceCompleted: true;
  readonly acknowledgedAt: string;
  readonly atxLedObservation: AtxLedObservation;
  readonly verification: "device_ack_only";
  readonly postRead: { readonly status: "available" | "unavailable" };
}

export interface DeviceRpcAdapter {
  readonly binding: DeviceRpcBinding;
  readDisplayState(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState>;
  readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead>;
  performAtx(
    ref: DeviceRpcBinding,
    request: { readonly requestId: string; readonly action: AtxAction },
    deadline: Deadline,
  ): Promise<AtxWireReceipt>;
}

export type DeviceRpcErrorCode =
  | "INVALID_BINDING"
  | "INVALID_DEADLINE"
  | "INVALID_REQUEST"
  | "STALE_BINDING"
  | "BINDING_REPLACED"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "CONNECTION_LOST"
  | "WRITE_REJECTED"
  | "MALFORMED_RESPONSE"
  | "DUPLICATE_RESPONSE"
  | "DOWNSTREAM_ERROR"
  | "INCOMPATIBLE_DOWNSTREAM";
export type DeviceRpcBoundary = "admission" | "queue" | "send" | "ack";
export type DeviceRpcOutcome = "not_sent" | "unknown" | "applied";

const SAFE_ERROR_MESSAGES: Record<DeviceRpcErrorCode, string> = {
  INVALID_BINDING: "The device RPC binding is invalid.",
  INVALID_DEADLINE: "The device RPC deadline is invalid.",
  INVALID_REQUEST: "The typed device RPC request is invalid.",
  STALE_BINDING: "The device RPC binding is stale.",
  BINDING_REPLACED: "The device RPC binding was replaced.",
  CANCELLED: "The device RPC operation was cancelled.",
  DEADLINE_EXCEEDED: "The device RPC deadline elapsed.",
  CONNECTION_LOST: "The browser-owned RPC channel was lost.",
  WRITE_REJECTED: "The browser-owned RPC channel rejected the write.",
  MALFORMED_RESPONSE: "The device RPC response was malformed.",
  DUPLICATE_RESPONSE: "The device RPC response was duplicated.",
  DOWNSTREAM_ERROR: "The device RPC operation failed downstream.",
  INCOMPATIBLE_DOWNSTREAM:
    "The current device RPC router cannot provide the required receipt.",
};

export class DeviceRpcError extends Error {
  public readonly name = "DeviceRpcError";

  public constructor(
    public readonly code: DeviceRpcErrorCode,
    public readonly boundary: DeviceRpcBoundary,
    public readonly outcome: DeviceRpcOutcome,
    public readonly writeBegan: boolean,
    public readonly acknowledged: boolean,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
  }

  public toJSON(): Record<string, string | boolean> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      boundary: this.boundary,
      outcome: this.outcome,
      writeBegan: this.writeBegan,
      acknowledged: this.acknowledged,
    };
  }
}

const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const nativeVideoStateSchema = z
  .object({
    ready: z.boolean(),
    streaming: z.number().int().min(0).max(2),
    error: z.string().optional().default(""),
    width: nonNegativeSafeIntegerSchema,
    height: nonNegativeSafeIntegerSchema,
    fps: z.number().nonnegative().finite(),
  })
  .strict();

const rawEdidResultSchema = z.string().nullable();
// EDID 1.4 byte 126 is an unsigned extension-block count.
const EDID_BLOCK_BYTES = 128;
const EDID_EXTENSION_COUNT_OFFSET = 126;
const EDID_MAX_EXTENSION_COUNT = 0xff;
const EDID_MAX_BYTES = (EDID_MAX_EXTENSION_COUNT + 1) * EDID_BLOCK_BYTES;
const EDID_MAX_HEX_CHARACTERS = EDID_MAX_BYTES * 2;

function hexNibbleAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

const eventEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const responseEnvelopeSchema = z.union([
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.string().min(1),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.string().min(1),
      error: z
        .object({
          code: z
            .number()
            .int()
            .min(Number.MIN_SAFE_INTEGER)
            .max(Number.MAX_SAFE_INTEGER),
          message: z.string(),
        })
        .passthrough(),
    })
    .strict(),
]);

const atxActionSchema = z.enum(["press_power", "hold_power", "press_reset"]);

const CORRELATION_ID_PREFIX = "device-rpc";
const MAX_SAFE_INTEGER_CODE_UNITS = String(Number.MAX_SAFE_INTEGER).length;
const PRIVATE_CORRELATION_ID_MAX_CODE_UNITS =
  CORRELATION_ID_PREFIX.length +
  3 +
  CANONICAL_OPAQUE_ID_MAX_CODE_UNITS +
  MAX_SAFE_INTEGER_CODE_UNITS * 2;
const WORST_CASE_JSON_ESCAPE_CODE_UNITS = 6;
// 23 leading envelope units + 173 fully escaped ID units + its closing quote.
const OVERSIZED_CORRELATION_PREFIX_CODE_UNITS =
  '{"jsonrpc":"2.0","id":"'.length +
  PRIVATE_CORRELATION_ID_MAX_CODE_UNITS * WORST_CASE_JSON_ESCAPE_CODE_UNITS +
  1;
// Accommodates the 64 KiB maximum EDID hex result with over 15x envelope headroom.
const SHARED_CHANNEL_MAX_UTF8_BYTES = 1_048_576;
// Any string over this equal code-unit ceiling is necessarily over the UTF-8 ceiling.
const SHARED_CHANNEL_MAX_CODE_UNITS = SHARED_CHANNEL_MAX_UTF8_BYTES;

function findJsonStringEnd(payload: string, start: number): number {
  for (let index = start + 1; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 0x22) return index;
    if (code === 0x5c) {
      index += 1;
      if (index >= payload.length) return -1;
    } else if (code < 0x20) {
      return -1;
    }
  }
  return -1;
}

function jsonStringTokenMatches(
  payload: string,
  start: number,
  end: number,
  target: string,
  mode: "exact" | "prefix",
): boolean {
  let targetIndex = 0;
  for (let index = start + 1; index < end; ) {
    let code = payload.charCodeAt(index);
    index += 1;
    if (code === 0x5c) {
      if (index >= end) return false;
      const escape = payload.charCodeAt(index);
      index += 1;
      if (escape === 0x75) {
        if (index + 4 > end) return false;
        code = 0;
        for (let offset = 0; offset < 4; offset += 1) {
          const hex = payload.charCodeAt(index + offset);
          const nibble =
            hex >= 0x30 && hex <= 0x39
              ? hex - 0x30
              : hex >= 0x41 && hex <= 0x46
                ? hex - 0x41 + 10
                : hex >= 0x61 && hex <= 0x66
                  ? hex - 0x61 + 10
                  : -1;
          if (nibble < 0) return false;
          code = code * 16 + nibble;
        }
        index += 4;
      } else {
        code =
          escape === 0x22 || escape === 0x5c || escape === 0x2f
            ? escape
            : escape === 0x62
              ? 0x08
              : escape === 0x66
                ? 0x0c
                : escape === 0x6e
                  ? 0x0a
                  : escape === 0x72
                    ? 0x0d
                    : escape === 0x74
                      ? 0x09
                      : -1;
        if (code < 0) return false;
      }
    } else if (code < 0x20) {
      return false;
    }
    if (targetIndex < target.length) {
      if (code !== target.charCodeAt(targetIndex)) return false;
      targetIndex += 1;
    } else if (mode === "exact") {
      return false;
    }
  }
  return targetIndex === target.length;
}

function decodeBoundedJsonString(
  payload: string,
  start: number,
  end: number,
  maxCodeUnits: number,
): string | undefined {
  let value = "";
  for (let index = start + 1; index < end; ) {
    let code = payload.charCodeAt(index);
    index += 1;
    if (code === 0x5c) {
      if (index >= end) return undefined;
      const escape = payload.charCodeAt(index);
      index += 1;
      if (escape === 0x75) {
        if (index + 4 > end) return undefined;
        code = 0;
        for (let offset = 0; offset < 4; offset += 1) {
          const hex = payload.charCodeAt(index + offset);
          const nibble =
            hex >= 0x30 && hex <= 0x39
              ? hex - 0x30
              : hex >= 0x41 && hex <= 0x46
                ? hex - 0x41 + 10
                : hex >= 0x61 && hex <= 0x66
                  ? hex - 0x61 + 10
                  : -1;
          if (nibble < 0) return undefined;
          code = code * 16 + nibble;
        }
        index += 4;
      } else {
        code =
          escape === 0x22 || escape === 0x5c || escape === 0x2f
            ? escape
            : escape === 0x62
              ? 0x08
              : escape === 0x66
                ? 0x0c
                : escape === 0x6e
                  ? 0x0a
                  : escape === 0x72
                    ? 0x0d
                    : escape === 0x74
                      ? 0x09
                      : -1;
        if (code < 0) return undefined;
      }
    } else if (code < 0x20) {
      return undefined;
    }
    if (value.length >= maxCodeUnits) return undefined;
    value += String.fromCharCode(code);
  }
  return value;
}

function isIssuedNoncurrentCorrelationId(
  candidate: string,
  issuedPrefix: string,
  currentSequence: number,
): boolean {
  const correlationPrefix = `${issuedPrefix}:`;
  if (!candidate.startsWith(correlationPrefix)) return false;
  const sequenceText = candidate.slice(correlationPrefix.length);
  const candidateSequence = Number(sequenceText);
  return (
    Number.isSafeInteger(candidateSequence) &&
    candidateSequence >= 1 &&
    String(candidateSequence) === sequenceText &&
    candidateSequence < currentSequence
  );
}

type OversizedCorrelationClassification =
  | "current"
  | "retired"
  | "owned_other"
  | "other";

function classifyOversizedPayloadPrefix(
  payload: string,
  currentId: string,
  ownedPrefix: string,
  issuedPrefix: string,
  currentSequence: number,
): OversizedCorrelationClassification {
  let index = 0;
  while (
    index < payload.length &&
    (payload.charCodeAt(index) === 0x09 ||
      payload.charCodeAt(index) === 0x0a ||
      payload.charCodeAt(index) === 0x0d ||
      payload.charCodeAt(index) === 0x20)
  ) {
    index += 1;
  }
  if (payload.charCodeAt(index) !== 0x7b) return "other";
  index += 1;
  let depth = 1;
  let classification: OversizedCorrelationClassification = "other";
  while (index < payload.length && depth > 0) {
    const code = payload.charCodeAt(index);
    if (code === 0x22) {
      const end = findJsonStringEnd(payload, index);
      if (end < 0) return classification;
      if (
        depth === 1 &&
        jsonStringTokenMatches(payload, index, end, "id", "exact")
      ) {
        let valueStart = end + 1;
        while (
          valueStart < payload.length &&
          (payload.charCodeAt(valueStart) === 0x09 ||
            payload.charCodeAt(valueStart) === 0x0a ||
            payload.charCodeAt(valueStart) === 0x0d ||
            payload.charCodeAt(valueStart) === 0x20)
        ) {
          valueStart += 1;
        }
        if (payload.charCodeAt(valueStart) === 0x3a) {
          valueStart += 1;
          while (
            valueStart < payload.length &&
            (payload.charCodeAt(valueStart) === 0x09 ||
              payload.charCodeAt(valueStart) === 0x0a ||
              payload.charCodeAt(valueStart) === 0x0d ||
              payload.charCodeAt(valueStart) === 0x20)
          ) {
            valueStart += 1;
          }
          if (payload.charCodeAt(valueStart) === 0x22) {
            const valueEnd = findJsonStringEnd(payload, valueStart);
            const tokenEnd = valueEnd < 0 ? payload.length : valueEnd;
            if (
              valueEnd >= 0 &&
              jsonStringTokenMatches(
                payload,
                valueStart,
                valueEnd,
                currentId,
                "exact",
              )
            ) {
              return "current";
            }
            const candidate =
              valueEnd < 0
                ? undefined
                : decodeBoundedJsonString(
                    payload,
                    valueStart,
                    valueEnd,
                    PRIVATE_CORRELATION_ID_MAX_CODE_UNITS,
                  );
            const retired =
              candidate !== undefined &&
              isIssuedNoncurrentCorrelationId(
                candidate,
                issuedPrefix,
                currentSequence,
              );
            if (retired) {
              if (classification === "other") classification = "retired";
            } else if (
              jsonStringTokenMatches(
                payload,
                valueStart,
                tokenEnd,
                ownedPrefix,
                "prefix",
              )
            ) {
              classification = "owned_other";
            }
            if (valueEnd < 0) return classification;
            index = valueEnd + 1;
            continue;
          }
        }
      }
      index = end + 1;
      continue;
    }
    if (code === 0x7b || code === 0x5b) depth += 1;
    else if (code === 0x7d || code === 0x5d) depth -= 1;
    index += 1;
  }
  return classification;
}

export function mapDeviceRpcBindingToWire(
  binding: DeviceRpcBinding,
): DeviceRpcWireBinding {
  assertValidBinding(binding);
  return {
    session_id: binding.sessionId,
    session_generation: binding.sessionGeneration,
    connection_epoch: binding.connectionEpoch,
    browser_channel_generation: binding.browserChannelGeneration,
  };
}

function assertValidBinding(binding: DeviceRpcBinding): void {
  if (
    typeof binding.sessionId !== "string" ||
    !isCanonicalOpaqueId(binding.sessionId) ||
    !Number.isSafeInteger(binding.sessionGeneration) ||
    binding.sessionGeneration < 1 ||
    !Number.isSafeInteger(binding.connectionEpoch) ||
    binding.connectionEpoch < 1 ||
    !Number.isSafeInteger(binding.browserChannelGeneration) ||
    binding.browserChannelGeneration < 1
  ) {
    throw new Error("Invalid device RPC binding.");
  }
}

function bindingsEqual(
  left: DeviceRpcBinding,
  right: DeviceRpcBinding,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionGeneration === right.sessionGeneration &&
    left.connectionEpoch === right.connectionEpoch &&
    left.browserChannelGeneration === right.browserChannelGeneration
  );
}

export function validateDeviceRpcBindingReplacement(
  current: DeviceRpcBinding,
  next: DeviceRpcBinding,
): void {
  assertValidBinding(current);
  assertValidBinding(next);
  if (current.sessionId !== next.sessionId) return;
  const componentsDoNotRegress =
    next.sessionGeneration >= current.sessionGeneration &&
    next.connectionEpoch >= current.connectionEpoch &&
    next.browserChannelGeneration >= current.browserChannelGeneration;
  const atLeastOneComponentAdvances =
    next.sessionGeneration > current.sessionGeneration ||
    next.connectionEpoch > current.connectionEpoch ||
    next.browserChannelGeneration > current.browserChannelGeneration;
  if (!componentsDoNotRegress || !atLeastOneComponentAdvances) {
    throw new Error("Replacement binding must advance monotonically.");
  }
}

function freezeBinding(binding: DeviceRpcBinding): DeviceRpcBinding {
  return Object.freeze({
    sessionId: binding.sessionId,
    sessionGeneration: binding.sessionGeneration,
    connectionEpoch: binding.connectionEpoch,
    browserChannelGeneration: binding.browserChannelGeneration,
  });
}

type RpcMethod = "getVideoState" | "getEDID";
type CancelKind = "cancelled" | "deadline" | "replaced";

interface CallCancellation {
  readonly promise: Promise<CancelKind>;
  readonly current: () => CancelKind | undefined;
  readonly dispose: () => void;
}

interface ExchangeResult {
  readonly result: unknown;
  readonly writeBegan: true;
}

interface PendingExchange {
  readonly ref: DeviceRpcBinding;
  readonly expectedRevision: number;
  readonly expectedChannel: BrowserOwnedRpcChannel;
  readonly correlationId: string;
  readonly correlationPrefix: string;
  readonly correlationSequence: number;
  readonly resolve: (result: ExchangeResult) => void;
  readonly reject: (error: DeviceRpcError) => void;
  settled: boolean;
  responseSeen: boolean;
  writeBegan: boolean;
  receivedResult: unknown;
}

export class GenerationFencedDeviceRpcAdapter implements DeviceRpcAdapter {
  private currentBinding: DeviceRpcBinding;
  private channel: BrowserOwnedRpcChannel;
  private revision = 1;
  private revisionAbort = new AbortController();
  private queueTail: Promise<void> = Promise.resolve();
  private cachedDisplay: CachedDisplayState | undefined;
  private sequence = 0;
  private cachedDisplayAtMs: number | undefined;
  private readonly correlationNamespace: string;
  private stopChannelListening: () => void = () => {};
  private pendingExchange: PendingExchange | undefined;

  public constructor(
    binding: DeviceRpcBinding,
    channel: BrowserOwnedRpcChannel,
    private readonly options: {
      readonly idNamespace?: string;
      readonly now?: () => number;
      readonly observedAt?: () => string;
    } = {},
  ) {
    assertValidBinding(binding);
    const correlationNamespace = options.idNamespace ?? crypto.randomUUID();
    if (!isCanonicalOpaqueId(correlationNamespace)) {
      throw new DeviceRpcError(
        "INVALID_REQUEST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    this.currentBinding = freezeBinding(binding);
    this.channel = channel;
    this.correlationNamespace = correlationNamespace;
    this.attachChannel(channel, this.revision);
  }

  public get binding(): DeviceRpcBinding {
    return this.currentBinding;
  }

  public replaceBinding(
    next: DeviceRpcBinding,
    nextChannel: BrowserOwnedRpcChannel,
    publish?: () => void,
  ): void {
    validateDeviceRpcBindingReplacement(this.currentBinding, next);
    if (nextChannel === this.channel) {
      throw new Error(
        "Binding replacement requires a distinct replacement channel.",
      );
    }
    if (nextChannel.readyState !== "open") {
      throw new Error("Replacement channel is closed.");
    }
    this.revision += 1;
    this.revisionAbort.abort();
    this.stopChannelListening();
    this.stopChannelListening = () => {};
    this.channel.close();
    if (nextChannel.readyState !== "open") {
      throw new Error("Replacement channel closed during takeover.");
    }
    this.currentBinding = freezeBinding(next);
    this.channel = nextChannel;
    this.cachedDisplay = undefined;
    this.cachedDisplayAtMs = undefined;
    this.revisionAbort = new AbortController();
    this.attachChannel(nextChannel, this.revision);
    publish?.();
  }

  public close(): void {
    this.revisionAbort.abort();
    this.stopChannelListening();
    this.stopChannelListening = () => {};
    this.channel.close();
  }

  public async readDisplayState(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState> {
    this.validateAdmission(ref, deadline, 30_000);
    if (
      this.channel.readyState === "closed" &&
      this.cachedDisplay !== undefined
    ) {
      return this.cachedDisplayResult("binding_lost_cached_only");
    }
    const expectedRevision = this.revision;
    const expectedChannel = this.channel;
    const result = await this.enqueue(
      ref,
      deadline,
      "getVideoState",
      {},
      30_000,
    );
    const parsed = nativeVideoStateSchema.safeParse(result);
    if (!parsed.success) throw this.protocolError("MALFORMED_RESPONSE", true);
    this.validateReadContinuation(ref, expectedRevision, expectedChannel);
    return this.cachedDisplay === undefined
      ? this.unobservedDisplay()
      : this.cachedDisplayResult("current_binding");
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.validateAdmission(ref, deadline, 30_000);
    const expectedRevision = this.revision;
    const expectedChannel = this.channel;
    const result = await this.enqueue(ref, deadline, "getEDID", {}, 30_000);
    const parsed = rawEdidResultSchema.safeParse(result);
    if (!parsed.success) throw this.protocolError("MALFORMED_RESPONSE", true);
    this.validateReadContinuation(ref, expectedRevision, expectedChannel);
    return this.mapEdidResult(parsed.data);
  }

  public async performAtx(
    ref: DeviceRpcBinding,
    request: { readonly requestId: string; readonly action: AtxAction },
    deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    this.validateAdmission(ref, deadline, 60_000);
    if (
      !isCanonicalOpaqueId(request.requestId) ||
      !atxActionSchema.safeParse(request.action).success
    ) {
      throw new DeviceRpcError(
        "INVALID_REQUEST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    throw new DeviceRpcError(
      "INCOMPATIBLE_DOWNSTREAM",
      "admission",
      "not_sent",
      false,
      false,
    );
  }

  private validateAdmission(
    ref: DeviceRpcBinding,
    deadline: Deadline,
    maximumMs: number,
  ): void {
    try {
      assertValidBinding(ref);
    } catch {
      throw new DeviceRpcError(
        "INVALID_BINDING",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    if (!bindingsEqual(ref, this.currentBinding)) {
      throw new DeviceRpcError(
        "STALE_BINDING",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    if (
      !Number.isSafeInteger(deadline.timeoutMs) ||
      deadline.timeoutMs < 1 ||
      deadline.timeoutMs > maximumMs
    ) {
      throw new DeviceRpcError(
        "INVALID_DEADLINE",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    if (deadline.signal.aborted) {
      throw new DeviceRpcError(
        "CANCELLED",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    if (
      this.channel.readyState !== "open" &&
      this.cachedDisplay === undefined
    ) {
      throw new DeviceRpcError(
        "CONNECTION_LOST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
  }

  private async enqueue(
    ref: DeviceRpcBinding,
    deadline: Deadline,
    method: RpcMethod,
    params: Readonly<Record<string, unknown>>,
    maximumMs: number,
  ): Promise<unknown> {
    this.validateAdmission(ref, deadline, maximumMs);
    const expectedRevision = this.revision;
    const expectedChannel = this.channel;
    const replacementSignal = this.revisionAbort.signal;
    const cancellation = this.createCancellation(deadline, replacementSignal);
    const previous = this.queueTail;
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    this.queueTail = previous.then(() => slot);
    let writeBegan = false;
    try {
      const queuedCancellation = await Promise.race([
        previous.then(() => undefined),
        cancellation.promise,
      ]);
      if (queuedCancellation !== undefined) {
        throw this.cancellationError(queuedCancellation, "queue", false);
      }
      this.validateCurrent(ref, expectedRevision, expectedChannel, "queue");
      const beforeSendCancellation = cancellation.current();
      if (beforeSendCancellation !== undefined) {
        throw this.cancellationError(beforeSendCancellation, "send", false);
      }
      this.validateCurrent(ref, expectedRevision, expectedChannel, "send");
      const exchange = await this.exchange(
        ref,
        expectedRevision,
        expectedChannel,
        method,
        params,
        cancellation,
      );
      writeBegan = exchange.writeBegan;
      return exchange.result;
    } catch (error) {
      if (error instanceof DeviceRpcError) throw error;
      throw new DeviceRpcError(
        "MALFORMED_RESPONSE",
        writeBegan ? "ack" : "send",
        writeBegan ? "unknown" : "not_sent",
        writeBegan,
        false,
      );
    } finally {
      cancellation.dispose();
      releaseSlot();
    }
  }

  private exchange(
    ref: DeviceRpcBinding,
    expectedRevision: number,
    expectedChannel: BrowserOwnedRpcChannel,
    method: RpcMethod,
    params: Readonly<Record<string, unknown>>,
    cancellation: CallCancellation,
  ): Promise<ExchangeResult> {
    const correlationSequence = ++this.sequence;
    const correlationPrefix = `${CORRELATION_ID_PREFIX}:${this.correlationNamespace}:${expectedRevision}`;
    const correlationId = `${correlationPrefix}:${correlationSequence}`;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: correlationId,
      method,
      params: { binding: mapDeviceRpcBindingToWire(ref), ...params },
    });
    return new Promise<ExchangeResult>((resolve, reject) => {
      if (this.pendingExchange !== undefined) {
        reject(this.protocolError("MALFORMED_RESPONSE", false));
        return;
      }
      const exchange: PendingExchange = {
        ref,
        expectedRevision,
        expectedChannel,
        correlationId,
        correlationPrefix,
        correlationSequence,
        resolve,
        reject,
        settled: false,
        responseSeen: false,
        writeBegan: false,
        receivedResult: undefined,
      };
      this.pendingExchange = exchange;

      const writeResult = expectedChannel.write(payload);
      exchange.writeBegan = writeResult.written;
      if (!writeResult.written) {
        const replaced =
          this.revision !== expectedRevision ||
          this.channel !== expectedChannel ||
          !bindingsEqual(ref, this.currentBinding);
        this.finishExchangeError(
          exchange,
          new DeviceRpcError(
            replaced ? "BINDING_REPLACED" : "WRITE_REJECTED",
            "send",
            "not_sent",
            false,
            false,
          ),
        );
        return;
      }
      if (
        this.revision !== expectedRevision ||
        this.channel !== expectedChannel ||
        !bindingsEqual(ref, this.currentBinding)
      ) {
        this.finishExchangeError(
          exchange,
          new DeviceRpcError("BINDING_REPLACED", "ack", "unknown", true, false),
        );
        return;
      }
      void cancellation.promise.then((kind) => {
        this.finishExchangeError(
          exchange,
          this.cancellationError(kind, "ack", true),
        );
      });
    });
  }

  private attachChannel(
    channel: BrowserOwnedRpcChannel,
    revision: number,
  ): void {
    this.stopChannelListening = channel.listen(
      (rawPayload) => this.handleChannelMessage(channel, revision, rawPayload),
      () => this.handleChannelClose(channel, revision),
    );
  }

  private handleChannelMessage(
    source: BrowserOwnedRpcChannel,
    sourceRevision: number,
    rawPayload: string,
  ): void {
    if (source !== this.channel || sourceRevision !== this.revision) return;
    const oversized =
      rawPayload.length > SHARED_CHANNEL_MAX_CODE_UNITS ||
      Buffer.byteLength(rawPayload, "utf8") > SHARED_CHANNEL_MAX_UTF8_BYTES;
    if (oversized) {
      const pending = this.pendingExchange;
      if (pending !== undefined && !pending.settled) {
        const classification = classifyOversizedPayloadPrefix(
          rawPayload.slice(0, OVERSIZED_CORRELATION_PREFIX_CODE_UNITS),
          pending.correlationId,
          `${CORRELATION_ID_PREFIX}:${this.correlationNamespace}:`,
          pending.correlationPrefix,
          pending.correlationSequence,
        );
        if (classification === "current" || classification === "owned_other") {
          this.finishExchangeError(
            pending,
            this.protocolError("MALFORMED_RESPONSE", pending.writeBegan),
          );
        }
      }
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawPayload) as unknown;
    } catch {
      return;
    }

    const event = eventEnvelopeSchema.safeParse(decoded);
    if (event.success) {
      if (event.data.method === "videoInputState") {
        const state = nativeVideoStateSchema.safeParse(event.data.params);
        if (state.success) {
          this.cachedDisplay = this.mapVideoState(state.data);
          this.cachedDisplayAtMs = this.now();
        }
      }
      return;
    }

    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      return;
    }
    const candidateId = (decoded as Record<string, unknown>).id;
    if (!this.isOwnedCorrelationId(candidateId)) return;

    const pending = this.pendingExchange;
    if (pending === undefined || pending.settled) return;
    if (
      pending.expectedRevision !== this.revision ||
      pending.expectedChannel !== this.channel ||
      !bindingsEqual(pending.ref, this.currentBinding)
    ) {
      this.finishExchangeError(
        pending,
        new DeviceRpcError("BINDING_REPLACED", "ack", "unknown", true, false),
      );
      return;
    }

    const envelope = responseEnvelopeSchema.safeParse(decoded);
    if (!envelope.success) {
      this.finishExchangeError(
        pending,
        this.protocolError("MALFORMED_RESPONSE", pending.writeBegan),
      );
      return;
    }
    if (envelope.data.id !== pending.correlationId) {
      if (
        isIssuedNoncurrentCorrelationId(
          envelope.data.id,
          pending.correlationPrefix,
          pending.correlationSequence,
        )
      ) {
        return;
      }
      this.finishExchangeError(
        pending,
        this.protocolError("MALFORMED_RESPONSE", pending.writeBegan),
      );
      return;
    }
    if (pending.responseSeen) {
      this.finishExchangeError(
        pending,
        this.protocolError("DUPLICATE_RESPONSE", pending.writeBegan),
      );
      return;
    }
    pending.responseSeen = true;
    if ("error" in envelope.data) {
      this.finishExchangeError(
        pending,
        new DeviceRpcError("DOWNSTREAM_ERROR", "ack", "unknown", true, false),
      );
      return;
    }
    pending.receivedResult = envelope.data.result;
    queueMicrotask(() => this.finishExchangeSuccess(pending));
  }

  private handleChannelClose(
    source: BrowserOwnedRpcChannel,
    sourceRevision: number,
  ): void {
    if (source !== this.channel || sourceRevision !== this.revision) return;
    const pending = this.pendingExchange;
    if (pending === undefined) return;
    const replaced =
      pending.expectedRevision !== this.revision ||
      pending.expectedChannel !== this.channel ||
      !bindingsEqual(pending.ref, this.currentBinding);
    this.finishExchangeError(
      pending,
      new DeviceRpcError(
        replaced ? "BINDING_REPLACED" : "CONNECTION_LOST",
        pending.writeBegan ? "ack" : "send",
        pending.writeBegan ? "unknown" : "not_sent",
        pending.writeBegan,
        false,
      ),
    );
  }

  private finishExchangeError(
    exchange: PendingExchange,
    error: DeviceRpcError,
  ): void {
    if (exchange.settled) return;
    exchange.settled = true;
    if (this.pendingExchange === exchange) this.pendingExchange = undefined;
    exchange.reject(error);
  }

  private finishExchangeSuccess(exchange: PendingExchange): void {
    if (exchange.settled || !exchange.responseSeen) return;
    exchange.settled = true;
    if (this.pendingExchange === exchange) this.pendingExchange = undefined;
    exchange.resolve({ result: exchange.receivedResult, writeBegan: true });
  }

  private validateReadContinuation(
    ref: DeviceRpcBinding,
    expectedRevision: number,
    expectedChannel: BrowserOwnedRpcChannel,
  ): void {
    if (
      this.revision !== expectedRevision ||
      this.channel !== expectedChannel ||
      !bindingsEqual(ref, this.currentBinding)
    ) {
      throw new DeviceRpcError(
        "BINDING_REPLACED",
        "ack",
        "unknown",
        true,
        false,
      );
    }
  }

  private validateCurrent(
    ref: DeviceRpcBinding,
    expectedRevision: number,
    expectedChannel: BrowserOwnedRpcChannel,
    boundary: "queue" | "send",
  ): void {
    if (
      this.revision !== expectedRevision ||
      this.channel !== expectedChannel ||
      !bindingsEqual(ref, this.currentBinding)
    ) {
      throw new DeviceRpcError(
        "BINDING_REPLACED",
        boundary,
        "not_sent",
        false,
        false,
      );
    }
    if (expectedChannel.readyState !== "open") {
      throw new DeviceRpcError(
        "CONNECTION_LOST",
        boundary,
        "not_sent",
        false,
        false,
      );
    }
  }

  private createCancellation(
    deadline: Deadline,
    replacementSignal: AbortSignal,
  ): CallCancellation {
    let current: CancelKind | undefined;
    let resolve!: (kind: CancelKind) => void;
    const promise = new Promise<CancelKind>((resolver) => {
      resolve = resolver;
    });
    const finish = (kind: CancelKind) => {
      if (current !== undefined) return;
      current = kind;
      resolve(kind);
    };
    const onAbort = () => finish("cancelled");
    const onReplacement = () => finish("replaced");
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    replacementSignal.addEventListener("abort", onReplacement, { once: true });
    const timer = setTimeout(() => finish("deadline"), deadline.timeoutMs);
    return {
      promise,
      current: () => current,
      dispose: () => {
        clearTimeout(timer);
        deadline.signal.removeEventListener("abort", onAbort);
        replacementSignal.removeEventListener("abort", onReplacement);
      },
    };
  }

  private cancellationError(
    kind: CancelKind,
    boundary: "queue" | "send" | "ack",
    writeBegan: boolean,
  ): DeviceRpcError {
    return new DeviceRpcError(
      kind === "replaced"
        ? "BINDING_REPLACED"
        : kind === "deadline"
          ? "DEADLINE_EXCEEDED"
          : "CANCELLED",
      boundary,
      writeBegan ? "unknown" : "not_sent",
      writeBegan,
      false,
    );
  }

  private protocolError(
    code: "MALFORMED_RESPONSE" | "DUPLICATE_RESPONSE",
    writeBegan: boolean,
  ): DeviceRpcError {
    return new DeviceRpcError(
      code,
      writeBegan ? "ack" : "send",
      writeBegan ? "unknown" : "not_sent",
      writeBegan,
      false,
    );
  }

  private isOwnedCorrelationId(candidate: unknown): candidate is string {
    return (
      typeof candidate === "string" &&
      candidate.startsWith(
        `${CORRELATION_ID_PREFIX}:${this.correlationNamespace}:`,
      )
    );
  }

  private cachedDisplayResult(
    qualification: CachedDisplayState["qualification"],
  ): CachedDisplayState {
    const elapsedMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(
        0,
        Math.floor(this.now() - (this.cachedDisplayAtMs ?? this.now())),
      ),
    );
    const cached = this.cachedDisplay;
    if (cached === undefined) return this.unobservedDisplay();
    const ageFact = <T>(fact: QualifiedFact<T>): QualifiedFact<T> => ({
      ...fact,
      ageMs:
        fact.ageMs === null
          ? null
          : Math.min(Number.MAX_SAFE_INTEGER, fact.ageMs + elapsedMs),
      freshness:
        qualification === "binding_lost_cached_only" || elapsedMs > 0
          ? "stale"
          : fact.freshness,
    });
    return {
      signal: ageFact(cached.signal),
      resolution: ageFact(cached.resolution),
      fps: ageFact(cached.fps),
      qualification,
    };
  }

  private unobservedDisplay(): CachedDisplayState {
    return {
      signal: {
        value: "unknown",
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      resolution: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      fps: {
        value: null,
        observedAt: null,
        ageMs: null,
        freshness: "unknown",
        source: "none",
      },
      qualification: "current_binding",
    };
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private observationTimestamp(): string {
    return this.options.observedAt?.() ?? new Date().toISOString();
  }

  private mapVideoState(
    state: z.infer<typeof nativeVideoStateSchema>,
  ): CachedDisplayState {
    const observedAt = this.observationTimestamp();
    const fact = <T>(value: T): QualifiedFact<T> => ({
      value,
      observedAt,
      ageMs: 0,
      freshness: "fresh",
      source: "cached_event",
    });
    const signal: NativeSignal = state.ready
      ? "present"
      : state.error === "no_signal" ||
          state.error === "no_lock" ||
          state.error === "out_of_range"
        ? state.error
        : "unknown";
    const resolution =
      state.width > 0 && state.height > 0
        ? {
            width: state.width,
            height: state.height,
            refreshHz: null,
          }
        : null;
    return {
      signal: fact(signal),
      resolution: fact(resolution),
      fps: fact(state.fps > 0 ? state.fps : null),
      qualification: "current_binding",
    };
  }

  private mapEdidResult(raw: string | null): QualifiedEdidRead {
    const observedAt = this.observationTimestamp();
    if (raw === null || raw.length === 0) {
      return {
        status: "unavailable",
        readCompleted: true,
        reason: "successful_read_reported_no_edid",
        observedAt,
        data: null,
      };
    }
    if (
      raw.length > EDID_MAX_HEX_CHARACTERS ||
      raw.length < EDID_BLOCK_BYTES * 2 ||
      raw.length % (EDID_BLOCK_BYTES * 2) !== 0
    ) {
      throw this.protocolError("MALFORMED_RESPONSE", true);
    }
    if (!/^[a-fA-F0-9]+$/.test(raw)) {
      throw this.protocolError("MALFORMED_RESPONSE", true);
    }
    const extensionCountOffset = EDID_EXTENSION_COUNT_OFFSET * 2;
    const extensionCount =
      hexNibbleAt(raw, extensionCountOffset) * 16 +
      hexNibbleAt(raw, extensionCountOffset + 1);
    const expectedBytes = (extensionCount + 1) * EDID_BLOCK_BYTES;
    if (raw.length !== expectedBytes * 2) {
      throw this.protocolError("MALFORMED_RESPONSE", true);
    }
    const byteLength = raw.length / 2;
    const bytes = Uint8Array.from(
      { length: byteLength } as ArrayLike<undefined>,
      (_value, index) =>
        hexNibbleAt(raw, index * 2) * 16 + hexNibbleAt(raw, index * 2 + 1),
    );
    const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    if (header.some((value, index) => bytes[index] !== value)) {
      throw this.protocolError("MALFORMED_RESPONSE", true);
    }
    for (let offset = 0; offset < bytes.length; offset += 128) {
      let checksum = 0;
      for (let index = offset; index < offset + 128; index += 1) {
        checksum = (checksum + bytes[index]!) & 0xff;
      }
      if (checksum !== 0) {
        throw this.protocolError("MALFORMED_RESPONSE", true);
      }
    }

    const manufacturerCode = bytes[8]! * 256 + bytes[9]!;
    const manufacturerCharacters = [
      (manufacturerCode >> 10) & 0x1f,
      (manufacturerCode >> 5) & 0x1f,
      manufacturerCode & 0x1f,
    ];
    const manufacturerId = manufacturerCharacters.every(
      (value) => value >= 1 && value <= 26,
    )
      ? String.fromCharCode(
          ...manufacturerCharacters.map((value) => value + 64),
        )
      : null;
    const productCode = bytes[10]! + bytes[11]! * 256;
    const serial =
      bytes[12]! +
      bytes[13]! * 256 +
      bytes[14]! * 65_536 +
      bytes[15]! * 16_777_216;

    let displayName: string | null = null;
    for (const offset of [54, 72, 90, 108]) {
      if (
        bytes[offset] === 0 &&
        bytes[offset + 1] === 0 &&
        bytes[offset + 2] === 0 &&
        bytes[offset + 3] === 0xfc
      ) {
        const value = String.fromCharCode(
          ...bytes.slice(offset + 5, offset + 18),
        )
          .replace(/[\0\r\n]/g, "")
          .trim();
        displayName = value.length === 0 ? null : value;
        break;
      }
    }

    let preferredResolution: NativeResolution | null = null;
    const pixelClock10Khz = bytes[54]! + bytes[55]! * 256;
    if (pixelClock10Khz > 0) {
      const width = bytes[56]! + ((bytes[58]! & 0xf0) << 4);
      const horizontalBlanking = bytes[57]! + ((bytes[58]! & 0x0f) << 8);
      const height = bytes[59]! + ((bytes[61]! & 0xf0) << 4);
      const verticalBlanking = bytes[60]! + ((bytes[61]! & 0x0f) << 8);
      const horizontalTotal = width + horizontalBlanking;
      const verticalTotal = height + verticalBlanking;
      const refreshHz =
        horizontalTotal > 0 && verticalTotal > 0
          ? Math.round(
              (pixelClock10Khz * 10_000 * 100) /
                horizontalTotal /
                verticalTotal,
            ) / 100
          : null;
      if (width > 0 && height > 0) {
        preferredResolution = {
          width,
          height,
          refreshHz: refreshHz !== null && refreshHz > 0 ? refreshHz : null,
        };
      }
    }

    return {
      status: "available",
      readCompleted: true,
      reason: null,
      observedAt,
      data: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        manufacturerId,
        productCode,
        serialNumber: serial === 0 ? null : String(serial),
        displayName,
        preferredResolution,
      },
    };
  }
}
