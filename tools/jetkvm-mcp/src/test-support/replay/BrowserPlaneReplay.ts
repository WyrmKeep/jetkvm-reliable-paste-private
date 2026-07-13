import { createHash } from "node:crypto";

import { z } from "zod";
import { PHYSICAL_KEYS } from "../../domain.js";

import {
  OPAQUE_ID_PATTERN,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcBinding,
  type SessionRef,
} from "../../device/DeviceRpcAdapter.js";
import {
  MAX_OBSERVATION_AGE_MS,
  assertBrowserCaptureArtifact,
  type BrowserCaptureArtifact,
  type BrowserCaptureImage,
  type BrowserConnection,
  type BrowserPlane,
  type CaptureRequest,
  type KeyboardRequest,
  type MouseRequest,
  type MutationReceipt,
  type MonotonicClock,
  type Observation,
  type PasteReceipt,
  type PasteRequest,
  type ReleaseReceipt,
  type ReleaseRequest,
} from "../../planes/BrowserPlane.js";
import {
  SanitizedReplayCursor,
  ReplayRecordedError,
  type JsonValue,
  type SanitizedReplayTape,
} from "./SanitizedReplayTape.js";

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const FROZEN_MONOTONIC_CLOCK: MonotonicClock = { now: () => 0 };
const nonNegativeIntegerSchema = z.number().int().min(0).max(MAX_JSON_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(MAX_JSON_INTEGER);
const requestIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
const mutationReceiptFields = {
  requestId: requestIdSchema,
  outcome: z.enum(["applied", "already_applied"]),
  verification: z.enum(["device_ack_only", "device_state_verified"]),
  dispatchedCount: nonNegativeIntegerSchema,
  completedCount: nonNegativeIntegerSchema,
  acknowledgedAt: timestampSchema,
} as const;
const mutationReceiptSchema = z
  .object(mutationReceiptFields)
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);
const pasteReceiptSchema = z
  .object({
    ...mutationReceiptFields,
    originalByteCount: nonNegativeIntegerSchema,
    normalizedByteCount: nonNegativeIntegerSchema,
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
    ...mutationReceiptFields,
    mutationGateClosed: z.literal(true),
    deferredProducersJoined: z.literal(true),
    pasteTerminal: z.enum(["cancelled", "inactive"]),
    ordinaryLeasesZero: z.literal(true),
    keyboardZero: z.literal(true),
    pointerZero: z.literal(true),
    generationDrained: z.literal(true),
    heldKeys: z.array(z.enum(PHYSICAL_KEYS)).length(0),
  })
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);
const bindingSchema = z
  .object({
    sessionId: requestIdSchema,
    sessionGeneration: positiveIntegerSchema,
    connectionEpoch: positiveIntegerSchema,
    browserChannelGeneration: positiveIntegerSchema,
  })
  .strict();
const connectionSchema = z
  .object({
    state: z.literal("ready"),
    ref: z
      .object({
        sessionId: requestIdSchema,
        sessionGeneration: positiveIntegerSchema,
      })
      .strict(),
    binding: bindingSchema,
    connectionEpoch: positiveIntegerSchema,
    browserChannelGeneration: positiveIntegerSchema,
    displayGeneration: nonNegativeIntegerSchema,
  })
  .strict();
const observationSchema = z
  .object({
    observationId: requestIdSchema,
    sessionId: requestIdSchema,
    sessionGeneration: positiveIntegerSchema,
    connectionEpoch: positiveIntegerSchema,
    displayGeneration: nonNegativeIntegerSchema,
    frameId: requestIdSchema,
    capturedAt: z.string().datetime(),
    monotonicAgeMs: nonNegativeIntegerSchema,
    sourceWidth: positiveIntegerSchema,
    sourceHeight: positiveIntegerSchema,
    imageWidth: positiveIntegerSchema,
    imageHeight: positiveIntegerSchema,
    rotation: z.union([
      z.literal(0),
      z.literal(90),
      z.literal(180),
      z.literal(270),
    ]),
    geometry: z
      .object({
        contentX: z.number().nonnegative().finite(),
        contentY: z.number().nonnegative().finite(),
        contentWidth: z.number().positive().finite(),
        contentHeight: z.number().positive().finite(),
      })
      .strict(),
    format: z.enum(["jpeg", "png"]),
    sha256: sha256Schema,
    byteLength: positiveIntegerSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    const maximumBytes =
      observation.format === "jpeg" ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
    if (observation.byteLength > maximumBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["byteLength"],
        message: "Observation artifact exceeds its format limit.",
      });
    }
  });

export interface ReplayDeviceRpcAdapterReplacement {
  invalidate(previous: DeviceRpcAdapter): Promise<void>;
  createReplacement(
    recordedBinding: DeviceRpcBinding,
  ): DeviceRpcAdapter | Promise<DeviceRpcAdapter>;
}
export type BrowserReplayImageResolver = (
  observation: Observation,
) => BrowserCaptureImage | Promise<BrowserCaptureImage>;

type PublishedConnection = {
  readonly binding: DeviceRpcBinding;
  readonly displayGeneration: number;
};

type ObservationLedgerEntry = {
  readonly observation: Observation;
  readonly registeredAtMs: number;
  state: "available" | "reserved" | "consumed";
};
type CaptureReservation = {
  readonly ref: SessionRef;
  readonly request: CaptureRequest;
  readonly publication: PublishedConnection;
  readonly binding: DeviceRpcBinding;
  readonly deviceRpc: DeviceRpcAdapter;
  readonly entry: ObservationLedgerEntry;
  readonly lifecycleToken: number;
  readonly lifecycleSignal: AbortSignal;
};

export class BrowserPlaneReplay implements BrowserPlane {
  private readonly replay: SanitizedReplayCursor;
  private currentDeviceRpc: DeviceRpcAdapter;
  private publishedConnection?: PublishedConnection;
  private readonly observations = new Map<string, ObservationLedgerEntry>();
  private lastPublishedBinding?: DeviceRpcBinding;
  private lifecycleState: "closed" | "published" | "reconnecting" = "closed";
  private lifecycleToken = 0;
  private lifecycleAbort = new AbortController();
  private reconnectingRef?: SessionRef;
  private generationDrained = false;
  private releaseAdmissionClosed = false;

  public constructor(
    deviceRpc: DeviceRpcAdapter,
    tape: SanitizedReplayTape,
    private readonly resolveCaptureImage: BrowserReplayImageResolver,
    private readonly replaceDeviceRpc?: ReplayDeviceRpcAdapterReplacement,
    private readonly monotonicClock: MonotonicClock = FROZEN_MONOTONIC_CLOCK,
  ) {
    this.currentDeviceRpc = deviceRpc;
    this.replay = new SanitizedReplayCursor(tape, "browser");
  }

  public get deviceRpc(): DeviceRpcAdapter {
    return this.currentDeviceRpc;
  }

  public assertExhausted(): void {
    this.replay.assertExhausted();
  }

  public async connect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("connect", { ref: { ...ref } });
    const parsed = connectionSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay connect response shape is invalid.");
    if (!this.connectionMatchesRef(parsed.data, ref)) {
      throw new Error("Replay connect response identity is invalid.");
    }
    if (!this.bindingMatches(this.deviceRpc.binding, parsed.data.binding)) {
      throw new Error(
        "Replay connect adapter does not match the recorded binding.",
      );
    }
    this.observations.clear();
    this.generationDrained = false;
    this.lastPublishedBinding = parsed.data.binding;
    this.publishedConnection = {
      binding: parsed.data.binding,
      displayGeneration: parsed.data.displayGeneration,
    };
    delete this.reconnectingRef;
    this.advanceLifecycle("published");
    return { ...parsed.data, deviceRpc: this.deviceRpc };
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.validateDeadline(deadline);
    this.assertPublishedRef(ref, true);
    const previousBinding = this.lastPublishedBinding;
    if (previousBinding === undefined) {
      throw new Error(
        "Replay reconnect requires a prior published connection.",
      );
    }
    const response = this.replay.consume("reconnect", { ref: { ...ref } });
    const parsed = connectionSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay reconnect response shape is invalid.");
    if (!this.connectionMatchesRef(parsed.data, ref)) {
      throw new Error("Replay reconnect response identity is invalid.");
    }
    if (
      parsed.data.connectionEpoch <= previousBinding.connectionEpoch ||
      parsed.data.browserChannelGeneration <=
        previousBinding.browserChannelGeneration
    ) {
      throw new Error("Replay reconnect generations must strictly increase.");
    }
    if (this.replaceDeviceRpc === undefined) {
      throw new Error("Replay reconnect requires an adapter replacement.");
    }

    const previous = this.deviceRpc;
    const lifecycleToken = this.advanceLifecycle("reconnecting");
    const lifecycleSignal = this.lifecycleAbort.signal;
    this.reconnectingRef = { ...ref };
    delete this.publishedConnection;
    this.observations.clear();
    this.generationDrained = true;
    try {
      await this.replaceDeviceRpc.invalidate(previous);
      this.assertReconnectLifecycle(
        lifecycleToken,
        lifecycleSignal,
        this.reconnectingRef,
      );
      const replacement = await this.replaceDeviceRpc.createReplacement(
        parsed.data.binding,
      );
      this.assertReconnectLifecycle(
        lifecycleToken,
        lifecycleSignal,
        this.reconnectingRef,
      );
      if (
        replacement === previous ||
        !this.bindingMatches(replacement.binding, parsed.data.binding)
      ) {
        throw new Error(
          "Replay reconnect replacement must be a new adapter with the recorded binding.",
        );
      }

      this.currentDeviceRpc = replacement;
      this.lastPublishedBinding = parsed.data.binding;
      this.publishedConnection = {
        binding: parsed.data.binding,
        displayGeneration: parsed.data.displayGeneration,
      };
      this.generationDrained = false;
      delete this.reconnectingRef;
      this.advanceLifecycle("published");
      return { ...parsed.data, deviceRpc: replacement };
    } catch (error) {
      if (
        this.lifecycleToken === lifecycleToken &&
        this.lifecycleState === "reconnecting"
      ) {
        delete this.reconnectingRef;
        delete this.publishedConnection;
        this.observations.clear();
        this.generationDrained = true;
        this.advanceLifecycle("closed");
      }
      throw error;
    }
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<BrowserCaptureArtifact> {
    this.validateDeadline(deadline);
    const admittedRef = { ...ref };
    const admittedRequest = { ...request };
    this.assertPublishedRef(admittedRef);
    if (
      !Number.isSafeInteger(admittedRequest.maxWidth) ||
      admittedRequest.maxWidth <= 0 ||
      !Number.isSafeInteger(admittedRequest.maxHeight) ||
      admittedRequest.maxHeight <= 0
    ) {
      throw new Error("Replay capture request bounds are invalid.");
    }
    const publication = this.publishedConnection;
    if (publication === undefined) {
      throw new Error("Replay BrowserPlane has no published connection.");
    }
    const deviceRpc = this.deviceRpc;
    const publishedBinding = { ...publication.binding };
    if (!this.bindingMatches(deviceRpc.binding, publishedBinding)) {
      throw new Error(
        "Replay capture adapter does not match the published binding.",
      );
    }
    const response = this.replay.consume("capture", {
      ref: admittedRef,
      request: admittedRequest,
    });
    const parsed = observationSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay capture response shape is invalid.");
    this.assertCaptureResponseMatches(
      parsed.data,
      admittedRequest,
      publication,
    );
    if (this.observations.has(parsed.data.observationId)) {
      throw new Error(
        "Replay capture response does not match the published connection, geometry, or format.",
      );
    }

    const entry: ObservationLedgerEntry = {
      observation: parsed.data,
      registeredAtMs: this.readMonotonicTick(),
      state: "reserved",
    };
    const reservation: CaptureReservation = {
      ref: admittedRef,
      request: admittedRequest,
      publication,
      binding: publishedBinding,
      deviceRpc,
      entry,
      lifecycleToken: this.lifecycleToken,
      lifecycleSignal: this.lifecycleAbort.signal,
    };
    this.observations.set(parsed.data.observationId, entry);
    try {
      const artifact: BrowserCaptureArtifact = {
        observation: parsed.data,
        image: await this.resolveCaptureWithinLifecycle(
          parsed.data,
          deadline,
          reservation,
        ),
      };
      this.assertCaptureReservationIsCurrent(reservation);
      assertBrowserCaptureArtifact(artifact);
      entry.state = "available";
      return artifact;
    } catch (error) {
      if (this.observations.get(parsed.data.observationId) === entry) {
        this.observations.delete(parsed.data.observationId);
      }
      throw error;
    }
  }

  public async mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.withObservation(ref, request.observationId, () =>
      this.consumeReceipt(
        "mouse",
        ref,
        request,
        deadline,
        mutationReceiptSchema,
        request.actions.length,
      ),
    );
  }

  public async keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.withObservation(ref, request.observationId, () =>
      this.consumeReceipt(
        "keyboard",
        ref,
        request,
        deadline,
        mutationReceiptSchema,
        request.actions.length,
      ),
    );
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    return this.withObservation(ref, request.observationId, async () => {
      this.validateDeadline(deadline);
      const normalizedText = (
        request.text.startsWith("\uFEFF") ? request.text.slice(1) : request.text
      )
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .normalize("NFC");
      const originalBytes = Buffer.from(request.text, "utf8");
      const normalizedBytes = Buffer.from(normalizedText, "utf8");
      const originalSha256 = createHash("sha256")
        .update(originalBytes)
        .digest("hex");
      const normalizedSha256 = createHash("sha256")
        .update(normalizedBytes)
        .digest("hex");
      const response = this.replay.consume("paste", {
        ref: { ...ref },
        request: {
          observationId: request.observationId,
          requestId: request.requestId,
          originalByteCount: originalBytes.byteLength,
          originalSha256,
          normalizedByteCount: normalizedBytes.byteLength,
          normalizedSha256,
        },
      });
      const parsed = pasteReceiptSchema.safeParse(response);
      if (
        !parsed.success ||
        parsed.data.requestId !== request.requestId ||
        parsed.data.dispatchedCount !== normalizedBytes.byteLength ||
        parsed.data.completedCount !== normalizedBytes.byteLength ||
        parsed.data.originalByteCount !== originalBytes.byteLength ||
        parsed.data.normalizedByteCount !== normalizedBytes.byteLength ||
        parsed.data.normalizedSha256 !== normalizedSha256
      ) {
        throw new Error("Replay paste receipt correlation is invalid.");
      }
      return parsed.data;
    });
  }

  public release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt> {
    let admittedPosition: number | undefined;
    try {
      this.validateDeadline(deadline);
      this.assertPublishedRef(ref);
      this.releaseAdmissionClosed = true;
      admittedPosition = this.replay.position;
      const receipt = this.consumeAdmittedReceipt(
        "release",
        ref,
        request,
        releaseReceiptSchema,
        1,
      );
      this.drainPublishedGeneration();
      return Promise.resolve(receipt);
    } catch (error) {
      if (admittedPosition !== undefined) {
        this.releaseAdmissionClosed = false;
        const definitiveNotSent =
          error instanceof ReplayRecordedError &&
          error.outcome === "not_sent" &&
          !error.writeBegan;
        if (this.replay.position !== admittedPosition && !definitiveNotSent) {
          this.drainPublishedGeneration();
        }
      }
      return Promise.reject(error);
    }
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.validateDeadline(deadline);
    this.assertCloseRef(ref);
    const response = this.replay.consume("close", { ref: { ...ref } });
    if (response !== null)
      throw new Error("Replay close response must be null.");
    delete this.publishedConnection;
    delete this.reconnectingRef;
    this.observations.clear();
    this.generationDrained = true;
    this.advanceLifecycle("closed");
  }

  private assertCaptureResponseMatches(
    observation: Observation,
    request: CaptureRequest,
    publication: PublishedConnection,
  ): void {
    const rotated = observation.rotation === 90 || observation.rotation === 270;
    const sourceWidth = rotated
      ? observation.sourceHeight
      : observation.sourceWidth;
    const sourceHeight = rotated
      ? observation.sourceWidth
      : observation.sourceHeight;
    if (
      observation.sessionId !== publication.binding.sessionId ||
      observation.sessionGeneration !== publication.binding.sessionGeneration ||
      observation.connectionEpoch !== publication.binding.connectionEpoch ||
      observation.displayGeneration !== publication.displayGeneration ||
      observation.format !== request.format ||
      observation.imageWidth > request.maxWidth ||
      observation.imageHeight > request.maxHeight ||
      observation.imageWidth > sourceWidth ||
      observation.imageHeight > sourceHeight ||
      observation.geometry.contentWidth * sourceHeight !==
        observation.geometry.contentHeight * sourceWidth ||
      observation.geometry.contentX + observation.geometry.contentWidth >
        observation.imageWidth ||
      observation.geometry.contentY + observation.geometry.contentHeight >
        observation.imageHeight
    ) {
      throw new Error(
        "Replay capture response does not match the published connection, geometry, or format.",
      );
    }
  }

  private assertCaptureReservationIsCurrent(
    reservation: CaptureReservation,
  ): void {
    const {
      binding,
      deviceRpc,
      entry,
      lifecycleSignal,
      lifecycleToken,
      publication,
      ref,
      request,
    } = reservation;
    if (
      this.lifecycleState !== "published" ||
      lifecycleSignal.aborted ||
      this.lifecycleToken !== lifecycleToken ||
      this.publishedConnection !== publication ||
      this.deviceRpc !== deviceRpc ||
      this.observations.get(entry.observation.observationId) !== entry ||
      entry.state !== "reserved" ||
      ref.sessionId !== binding.sessionId ||
      ref.sessionGeneration !== binding.sessionGeneration ||
      !this.bindingMatches(publication.binding, binding) ||
      !this.bindingMatches(deviceRpc.binding, binding)
    ) {
      throw new Error(
        "Replay capture observation reservation is stale or foreign.",
      );
    }
    this.assertCaptureResponseMatches(entry.observation, request, publication);
  }

  private async consumeReceipt<
    T extends {
      readonly requestId: string;
      readonly dispatchedCount: number;
      readonly completedCount: number;
    },
  >(
    operation: "mouse" | "keyboard" | "release",
    ref: SessionRef,
    request: MouseRequest | KeyboardRequest | ReleaseRequest,
    deadline: Deadline,
    schema: z.ZodType<T>,
    expectedCount: number,
  ): Promise<T> {
    return this.consumeReceiptSynchronously(
      operation,
      ref,
      request,
      deadline,
      schema,
      expectedCount,
    );
  }

  private consumeReceiptSynchronously<
    T extends {
      readonly requestId: string;
      readonly dispatchedCount: number;
      readonly completedCount: number;
    },
  >(
    operation: "mouse" | "keyboard" | "release",
    ref: SessionRef,
    request: MouseRequest | KeyboardRequest | ReleaseRequest,
    deadline: Deadline,
    schema: z.ZodType<T>,
    expectedCount: number,
  ): T {
    this.validateDeadline(deadline);
    this.assertPublishedRef(ref);
    return this.consumeAdmittedReceipt(
      operation,
      ref,
      request,
      schema,
      expectedCount,
    );
  }

  private consumeAdmittedReceipt<
    T extends {
      readonly requestId: string;
      readonly dispatchedCount: number;
      readonly completedCount: number;
    },
  >(
    operation: "mouse" | "keyboard" | "release",
    ref: SessionRef,
    request: MouseRequest | KeyboardRequest | ReleaseRequest,
    schema: z.ZodType<T>,
    expectedCount: number,
  ): T {
    const response = this.replay.consume(operation, {
      ref: { ...ref },
      request: JSON.parse(JSON.stringify(request)) as JsonValue,
    });
    const parsed = schema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.requestId !== request.requestId ||
      parsed.data.dispatchedCount !== expectedCount ||
      parsed.data.completedCount !== expectedCount
    ) {
      throw new Error(`Replay ${operation} receipt correlation is invalid.`);
    }
    return parsed.data;
  }

  private async withObservation<T>(
    ref: SessionRef,
    observationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.reserveObservation(ref, observationId);
    const position = this.replay.position;
    try {
      this.assertObservationMatches(ref, entry, "reserved");
      const result = await operation();
      entry.state = "consumed";
      return result;
    } catch (error) {
      const stepConsumed = this.replay.position !== position;
      entry.state =
        !stepConsumed ||
        (error instanceof ReplayRecordedError &&
          error.outcome === "not_sent" &&
          !error.writeBegan)
          ? "available"
          : "consumed";
      throw error;
    }
  }

  private reserveObservation(
    ref: SessionRef,
    observationId: string,
  ): ObservationLedgerEntry {
    this.assertPublishedRef(ref);
    const entry = this.observations.get(observationId);
    if (entry === undefined) {
      throw new Error("Replay BrowserPlane observation is unseen.");
    }
    this.assertObservationMatches(ref, entry, "available");
    entry.state = "reserved";
    return entry;
  }

  private assertObservationMatches(
    ref: SessionRef,
    entry: ObservationLedgerEntry,
    expectedState: ObservationLedgerEntry["state"],
  ): void {
    const publication = this.publishedConnection;
    const observation = entry.observation;
    const ageMs = this.observationAgeMs(entry);
    if (
      publication === undefined ||
      entry.state !== expectedState ||
      observation.sessionId !== ref.sessionId ||
      observation.sessionGeneration !== ref.sessionGeneration ||
      observation.connectionEpoch !== publication.binding.connectionEpoch ||
      observation.displayGeneration !== publication.displayGeneration ||
      ageMs > MAX_OBSERVATION_AGE_MS
    ) {
      throw new Error(
        "Replay BrowserPlane observation is stale, foreign, or consumed.",
      );
    }
  }

  private observationAgeMs(entry: ObservationLedgerEntry): number {
    const now = this.readMonotonicTick();
    const elapsed = now - entry.registeredAtMs;
    const ageMs = entry.observation.monotonicAgeMs + elapsed;
    if (
      !Number.isSafeInteger(elapsed) ||
      elapsed < 0 ||
      !Number.isSafeInteger(ageMs)
    ) {
      throw new Error(
        "Replay BrowserPlane monotonic observation age is invalid.",
      );
    }
    return ageMs;
  }

  private readMonotonicTick(): number {
    const tick = this.monotonicClock.now();
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new Error("Replay BrowserPlane monotonic clock is invalid.");
    }
    return tick;
  }

  private assertPublishedRef(ref: SessionRef, allowDrained = false): void {
    this.assertCurrentRef(ref);
    const publication = this.publishedConnection;
    if (
      this.lifecycleState !== "published" ||
      publication === undefined ||
      publication.binding.sessionId !== ref.sessionId ||
      publication.binding.sessionGeneration !== ref.sessionGeneration
    ) {
      throw new Error("Replay BrowserPlane has no published connection.");
    }
    if (
      (this.generationDrained || this.releaseAdmissionClosed) &&
      !allowDrained
    ) {
      throw new Error("Replay BrowserPlane generation input is drained.");
    }
  }

  private assertCloseRef(ref: SessionRef): void {
    if (this.lifecycleState === "reconnecting") {
      if (
        this.reconnectingRef?.sessionId !== ref.sessionId ||
        this.reconnectingRef.sessionGeneration !== ref.sessionGeneration
      ) {
        throw new Error("Replay BrowserPlane session reference is stale.");
      }
      return;
    }
    this.assertPublishedRef(ref, true);
  }

  private assertReconnectLifecycle(
    lifecycleToken: number,
    lifecycleSignal: AbortSignal,
    reconnectingRef: SessionRef | undefined,
  ): void {
    if (
      lifecycleSignal.aborted ||
      lifecycleToken !== this.lifecycleToken ||
      this.lifecycleState !== "reconnecting" ||
      reconnectingRef === undefined ||
      this.reconnectingRef !== reconnectingRef
    ) {
      throw new Error("Replay reconnect lifecycle was closed or replaced.");
    }
  }

  private drainPublishedGeneration(): void {
    this.releaseAdmissionClosed = false;
    if (this.lifecycleState !== "published") return;
    this.observations.clear();
    this.generationDrained = true;
  }

  private advanceLifecycle(
    state: "closed" | "published" | "reconnecting",
  ): number {
    this.lifecycleAbort.abort();
    this.lifecycleAbort = new AbortController();
    this.lifecycleToken += 1;
    this.lifecycleState = state;
    this.releaseAdmissionClosed = false;
    return this.lifecycleToken;
  }

  private async resolveCaptureWithinLifecycle(
    observation: Observation,
    deadline: Deadline,
    reservation: CaptureReservation,
  ): Promise<BrowserCaptureImage> {
    const interruption = Promise.withResolvers<never>();
    let interrupted = false;
    const rejectOnce = (error: Error): void => {
      if (interrupted) return;
      interrupted = true;
      interruption.reject(error);
    };
    const onDeadlineAbort = (): void =>
      rejectOnce(new Error("Replay capture was cancelled."));
    const onLifecycleAbort = (): void =>
      rejectOnce(new Error("Replay capture lifecycle changed."));
    const timeout = setTimeout(
      () => rejectOnce(new Error("Replay capture deadline exceeded.")),
      deadline.timeoutMs,
    );
    deadline.signal.addEventListener("abort", onDeadlineAbort, { once: true });
    reservation.lifecycleSignal.addEventListener("abort", onLifecycleAbort, {
      once: true,
    });
    if (deadline.signal.aborted) onDeadlineAbort();
    if (reservation.lifecycleSignal.aborted) onLifecycleAbort();
    try {
      const resolution = Promise.resolve(this.resolveCaptureImage(observation));
      return await Promise.race([resolution, interruption.promise]);
    } finally {
      clearTimeout(timeout);
      deadline.signal.removeEventListener("abort", onDeadlineAbort);
      reservation.lifecycleSignal.removeEventListener(
        "abort",
        onLifecycleAbort,
      );
    }
  }

  private connectionMatchesRef(
    connection: z.infer<typeof connectionSchema>,
    ref: SessionRef,
  ): boolean {
    return (
      connection.ref.sessionId === ref.sessionId &&
      connection.ref.sessionGeneration === ref.sessionGeneration &&
      connection.binding.sessionId === ref.sessionId &&
      connection.binding.sessionGeneration === ref.sessionGeneration &&
      connection.binding.connectionEpoch === connection.connectionEpoch &&
      connection.binding.browserChannelGeneration ===
        connection.browserChannelGeneration
    );
  }

  private assertCurrentRef(ref: SessionRef): void {
    const binding = this.deviceRpc.binding;
    if (
      ref.sessionId !== binding.sessionId ||
      ref.sessionGeneration !== binding.sessionGeneration
    ) {
      throw new Error("Replay BrowserPlane session reference is stale.");
    }
  }

  private bindingMatches(
    actual: DeviceRpcBinding,
    expected: DeviceRpcBinding,
  ): boolean {
    return (
      actual.sessionId === expected.sessionId &&
      actual.sessionGeneration === expected.sessionGeneration &&
      actual.connectionEpoch === expected.connectionEpoch &&
      actual.browserChannelGeneration === expected.browserChannelGeneration
    );
  }

  private validateDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted)
      throw new Error("Replay plane call was cancelled before admission.");
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs <= 0) {
      throw new Error("Replay plane deadline is invalid.");
    }
  }
}
