import { z } from "zod";

export interface SessionRef {
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface Deadline {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
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
export type FactSource = "cached_snapshot" | "cached_event" | "none";

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

export interface AtxWireReceipt {
  readonly requestId: string;
  readonly action: AtxAction;
  readonly wireAction: AtxWireAction;
  readonly fixedPressMs: 200 | 5000;
  readonly serialSequenceCompleted: true;
  readonly acknowledgedAt: string;
  readonly atxLedObservation: {
    readonly power: boolean | null;
    readonly hdd: boolean | null;
    readonly observedAt: string | null;
    readonly freshness: FactFreshness;
  };
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
  | "DOWNSTREAM_ERROR";
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

const wireFactMetadataSchema = z
  .object({
    observed_at: z.string().datetime().nullable(),
    age_ms: z.number().int().nonnegative().nullable(),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    source: z.enum(["cached_snapshot", "cached_event", "none"]),
  })
  .strict();
const signalFactSchema = wireFactMetadataSchema
  .extend({
    value: z.enum([
      "present",
      "no_signal",
      "no_lock",
      "out_of_range",
      "unknown",
    ]),
  })
  .strict();
const resolutionFactSchema = wireFactMetadataSchema
  .extend({
    value: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        refresh_hz: z.number().positive().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const fpsFactSchema = wireFactMetadataSchema
  .extend({ value: z.number().nonnegative().nullable() })
  .strict();
const displayStateResultSchema = z
  .object({
    signal: signalFactSchema,
    resolution: resolutionFactSchema,
    fps: fpsFactSchema,
  })
  .strict();

const edidResultSchema = z.discriminatedUnion("status", [
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
      observed_at: z.string().datetime(),
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      read_completed: z.literal(true),
      reason: z.null(),
      observed_at: z.string().datetime(),
      data: z
        .object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          manufacturer_id: z.string().nullable(),
          product_code: z.number().int().nonnegative().nullable(),
          serial_number: z.string().nullable(),
          display_name: z.string().nullable(),
          preferred_resolution: z
            .object({
              width: z.number().int().positive(),
              height: z.number().int().positive(),
              refresh_hz: z.number().positive().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
]);

const atxResultSchema = z
  .object({
    request_id: z.string().min(1),
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    wire_action: z.enum(["power-short", "power-long", "reset"]),
    fixed_press_ms: z.union([z.literal(200), z.literal(5000)]),
    serial_sequence_completed: z.literal(true),
    acknowledged_at: z.string().datetime(),
    atx_led_observation: z
      .object({
        power: z.boolean().nullable(),
        hdd: z.boolean().nullable(),
        observed_at: z.string().datetime().nullable(),
        freshness: z.enum(["fresh", "stale", "unknown"]),
      })
      .strict(),
    post_read_error: z
      .object({ code: z.string().min(1).max(128) })
      .strict()
      .optional(),
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
        .object({ code: z.number().int(), message: z.string() })
        .passthrough(),
    })
    .strict(),
]);

const ATX_WIRE_BY_ACTION: Record<
  AtxAction,
  { wireAction: AtxWireAction; fixedPressMs: 200 | 5000 }
> = {
  press_power: { wireAction: "power-short", fixedPressMs: 200 },
  hold_power: { wireAction: "power-long", fixedPressMs: 5000 },
  press_reset: { wireAction: "reset", fixedPressMs: 200 },
};

const MAX_RETIRED_CORRELATION_IDS = 256;

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
    binding.sessionId.trim().length === 0 ||
    binding.sessionId.length > 256 ||
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

function freezeBinding(binding: DeviceRpcBinding): DeviceRpcBinding {
  return Object.freeze({
    sessionId: binding.sessionId,
    sessionGeneration: binding.sessionGeneration,
    connectionEpoch: binding.connectionEpoch,
    browserChannelGeneration: binding.browserChannelGeneration,
  });
}

type RpcMethod = "getVideoState" | "getEDID" | "setATXPowerAction";
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

export class GenerationFencedDeviceRpcAdapter implements DeviceRpcAdapter {
  private currentBinding: DeviceRpcBinding;
  private channel: BrowserOwnedRpcChannel;
  private revision = 1;
  private revisionAbort = new AbortController();
  private queueTail: Promise<void> = Promise.resolve();
  private cachedDisplay: CachedDisplayState | undefined;
  private sequence = 0;
  private cachedDisplayAtMs: number | undefined;
  private readonly retiredCorrelationIds = new Set<string>();

  public constructor(
    binding: DeviceRpcBinding,
    channel: BrowserOwnedRpcChannel,
    private readonly options: {
      readonly idFactory?: () => string;
      readonly now?: () => number;
    } = {},
  ) {
    assertValidBinding(binding);
    this.currentBinding = freezeBinding(binding);
    this.channel = channel;
  }

  public get binding(): DeviceRpcBinding {
    return this.currentBinding;
  }

  public replaceBinding(
    next: DeviceRpcBinding,
    nextChannel: BrowserOwnedRpcChannel,
    publish?: () => void,
  ): void {
    assertValidBinding(next);
    this.revision += 1;
    this.revisionAbort.abort();
    this.channel.close();
    this.currentBinding = freezeBinding(next);
    this.channel = nextChannel;
    this.cachedDisplay = undefined;
    this.cachedDisplayAtMs = undefined;
    this.retiredCorrelationIds.clear();
    this.revisionAbort = new AbortController();
    publish?.();
  }

  public close(): void {
    this.revisionAbort.abort();
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
      const elapsedMs = Math.max(
        0,
        Math.floor(this.now() - (this.cachedDisplayAtMs ?? this.now())),
      );
      return {
        signal: this.staleFact(this.cachedDisplay.signal, elapsedMs),
        resolution: this.staleFact(this.cachedDisplay.resolution, elapsedMs),
        fps: this.staleFact(this.cachedDisplay.fps, elapsedMs),
        qualification: "binding_lost_cached_only",
      };
    }
    const result = await this.enqueue(
      ref,
      deadline,
      "getVideoState",
      {},
      30_000,
    );
    const parsed = displayStateResultSchema.safeParse(result);
    if (!parsed.success) throw this.protocolError("MALFORMED_RESPONSE", true);
    const mapped: CachedDisplayState = {
      signal: this.mapFact(parsed.data.signal),
      resolution: {
        ...this.mapFact(parsed.data.resolution),
        value:
          parsed.data.resolution.value === null
            ? null
            : {
                width: parsed.data.resolution.value.width,
                height: parsed.data.resolution.value.height,
                refreshHz: parsed.data.resolution.value.refresh_hz,
              },
      },
      fps: this.mapFact(parsed.data.fps),
      qualification: "current_binding",
    };
    this.cachedDisplay = mapped;
    this.cachedDisplayAtMs = this.now();
    return mapped;
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.validateAdmission(ref, deadline, 30_000);
    const result = await this.enqueue(ref, deadline, "getEDID", {}, 30_000);
    const parsed = edidResultSchema.safeParse(result);
    if (!parsed.success) throw this.protocolError("MALFORMED_RESPONSE", true);
    if (parsed.data.status !== "available") {
      return {
        status: parsed.data.status,
        readCompleted: parsed.data.read_completed,
        reason: parsed.data.reason,
        observedAt: parsed.data.observed_at,
        data: null,
      } as QualifiedEdidRead;
    }
    return {
      status: "available",
      readCompleted: true,
      reason: null,
      observedAt: parsed.data.observed_at,
      data: {
        sha256: parsed.data.data.sha256,
        manufacturerId: parsed.data.data.manufacturer_id,
        productCode: parsed.data.data.product_code,
        serialNumber: parsed.data.data.serial_number,
        displayName: parsed.data.data.display_name,
        preferredResolution:
          parsed.data.data.preferred_resolution === null
            ? null
            : {
                width: parsed.data.data.preferred_resolution.width,
                height: parsed.data.data.preferred_resolution.height,
                refreshHz: parsed.data.data.preferred_resolution.refresh_hz,
              },
      },
    };
  }

  public async performAtx(
    ref: DeviceRpcBinding,
    request: { readonly requestId: string; readonly action: AtxAction },
    deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    this.validateAdmission(ref, deadline, 60_000);
    if (
      typeof request.requestId !== "string" ||
      request.requestId.trim().length === 0 ||
      request.requestId.length > 256 ||
      !Object.hasOwn(ATX_WIRE_BY_ACTION, request.action)
    ) {
      throw new DeviceRpcError(
        "INVALID_REQUEST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    const semantic = ATX_WIRE_BY_ACTION[request.action];
    const result = await this.enqueue(
      ref,
      deadline,
      "setATXPowerAction",
      {
        request_id: request.requestId,
        action: request.action,
        wire_action: semantic.wireAction,
        fixed_press_ms: semantic.fixedPressMs,
      },
      60_000,
    );
    const parsed = atxResultSchema.safeParse(result);
    if (!parsed.success) throw this.protocolError("MALFORMED_RESPONSE", true);
    if (
      parsed.data.request_id !== request.requestId ||
      parsed.data.action !== request.action ||
      parsed.data.wire_action !== semantic.wireAction ||
      parsed.data.fixed_press_ms !== semantic.fixedPressMs
    ) {
      throw this.protocolError("MALFORMED_RESPONSE", true);
    }
    return {
      requestId: parsed.data.request_id,
      action: parsed.data.action,
      wireAction: parsed.data.wire_action,
      fixedPressMs: parsed.data.fixed_press_ms,
      serialSequenceCompleted: true,
      acknowledgedAt: parsed.data.acknowledged_at,
      atxLedObservation: {
        power: parsed.data.atx_led_observation.power,
        hdd: parsed.data.atx_led_observation.hdd,
        observedAt: parsed.data.atx_led_observation.observed_at,
        freshness: parsed.data.atx_led_observation.freshness,
      },
      verification: "device_ack_only",
      postRead: {
        status:
          parsed.data.post_read_error === undefined
            ? "available"
            : "unavailable",
      },
    };
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
      deadline.timeoutMs < 100 ||
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
    const correlationId =
      this.options.idFactory?.() ?? `device-rpc-${++this.sequence}`;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: correlationId,
      method,
      params: { binding: mapDeviceRpcBindingToWire(ref), ...params },
    });
    return new Promise<ExchangeResult>((resolve, reject) => {
      let settled = false;
      let receivedResult: unknown;
      let responseSeen = false;
      let writeBegan = false;
      let stopListening = () => {};

      const finishError = (error: DeviceRpcError) => {
        if (settled) return;
        settled = true;
        if (writeBegan) this.retireCorrelationId(correlationId);
        stopListening();
        reject(error);
      };
      const finishSuccess = () => {
        if (settled || !responseSeen) return;
        settled = true;
        this.retireCorrelationId(correlationId);
        stopListening();
        resolve({ result: receivedResult, writeBegan: true });
      };
      stopListening = expectedChannel.listen(
        (rawPayload) => {
          if (settled) return;
          if (
            this.revision !== expectedRevision ||
            this.channel !== expectedChannel ||
            !bindingsEqual(ref, this.currentBinding)
          ) {
            finishError(
              new DeviceRpcError(
                "BINDING_REPLACED",
                "ack",
                "unknown",
                true,
                false,
              ),
            );
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(rawPayload) as unknown;
          } catch {
            finishError(this.protocolError("MALFORMED_RESPONSE", writeBegan));
            return;
          }
          const envelope = responseEnvelopeSchema.safeParse(decoded);
          if (!envelope.success) {
            finishError(this.protocolError("MALFORMED_RESPONSE", writeBegan));
            return;
          }
          if (envelope.data.id !== correlationId) {
            if (this.retiredCorrelationIds.has(envelope.data.id)) return;
            finishError(this.protocolError("MALFORMED_RESPONSE", writeBegan));
            return;
          }
          if (responseSeen) {
            finishError(this.protocolError("DUPLICATE_RESPONSE", writeBegan));
            return;
          }
          responseSeen = true;
          if ("error" in envelope.data) {
            finishError(
              new DeviceRpcError(
                "DOWNSTREAM_ERROR",
                "ack",
                "unknown",
                true,
                false,
              ),
            );
            return;
          }
          receivedResult = envelope.data.result;
          queueMicrotask(finishSuccess);
        },
        () => {
          const replaced =
            this.revision !== expectedRevision ||
            this.channel !== expectedChannel ||
            !bindingsEqual(ref, this.currentBinding);
          finishError(
            new DeviceRpcError(
              replaced ? "BINDING_REPLACED" : "CONNECTION_LOST",
              writeBegan ? "ack" : "send",
              writeBegan ? "unknown" : "not_sent",
              writeBegan,
              false,
            ),
          );
        },
      );

      const writeResult = expectedChannel.write(payload);
      writeBegan = writeResult.written;
      if (!writeResult.written) {
        const replaced =
          this.revision !== expectedRevision ||
          this.channel !== expectedChannel ||
          !bindingsEqual(ref, this.currentBinding);
        finishError(
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
        finishError(
          new DeviceRpcError("BINDING_REPLACED", "ack", "unknown", true, false),
        );
        return;
      }
      void cancellation.promise.then((kind) => {
        finishError(this.cancellationError(kind, "ack", true));
      });
    });
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

  private retireCorrelationId(correlationId: string): void {
    if (this.retiredCorrelationIds.has(correlationId)) return;
    this.retiredCorrelationIds.add(correlationId);
    if (this.retiredCorrelationIds.size <= MAX_RETIRED_CORRELATION_IDS) return;
    const oldest = this.retiredCorrelationIds.values().next().value;
    if (oldest !== undefined) this.retiredCorrelationIds.delete(oldest);
  }

  private staleFact<T>(
    fact: QualifiedFact<T>,
    elapsedMs: number,
  ): QualifiedFact<T> {
    return {
      ...fact,
      ageMs: fact.ageMs === null ? null : fact.ageMs + elapsedMs,
      freshness: "stale",
    };
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private mapFact<T>(fact: {
    readonly value: T;
    readonly observed_at: string | null;
    readonly age_ms: number | null;
    readonly freshness: FactFreshness;
    readonly source: FactSource;
  }): QualifiedFact<T> {
    return {
      value: fact.value,
      observedAt: fact.observed_at,
      ageMs: fact.age_ms,
      freshness: fact.freshness,
      source: fact.source,
    };
  }
}
