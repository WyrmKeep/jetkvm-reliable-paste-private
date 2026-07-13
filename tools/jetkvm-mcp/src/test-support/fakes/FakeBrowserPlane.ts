import { createHash } from "node:crypto";

import { z } from "zod";

import { PHYSICAL_KEYS, type PhysicalKey } from "../../domain.js";
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
  PlaneFaultError,
  PlaneScenarioEngine,
  type PlaneEvent,
  type PlaneScenario,
} from "./PlaneScenario.js";

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const FROZEN_MONOTONIC_CLOCK: MonotonicClock = { now: () => 0 };
const nonNegativeIntegerSchema = z.number().int().min(0).max(MAX_JSON_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(MAX_JSON_INTEGER);
const bindingSchema = z
  .object({
    sessionId: opaqueIdSchema,
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
        sessionId: opaqueIdSchema,
        sessionGeneration: positiveIntegerSchema,
      })
      .strict(),
    binding: bindingSchema,
    connectionEpoch: positiveIntegerSchema,
    browserChannelGeneration: positiveIntegerSchema,
    displayGeneration: nonNegativeIntegerSchema,
  })
  .strict();
const mutationReceiptSchema = z
  .object({
    requestId: opaqueIdSchema,
    outcome: z.enum(["applied", "already_applied"]),
    verification: z.enum(["device_ack_only", "device_state_verified"]),
    dispatchedCount: nonNegativeIntegerSchema,
    completedCount: nonNegativeIntegerSchema,
    acknowledgedAt: z.string().datetime(),
  })
  .strict();
const heldKeysSchema = z
  .array(z.enum(PHYSICAL_KEYS))
  .superRefine((heldKeys, context) => {
    let previousIndex = -1;
    for (const [index, key] of heldKeys.entries()) {
      const canonicalIndex = PHYSICAL_KEYS.indexOf(key);
      if (canonicalIndex <= previousIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Held keys must be unique and in canonical order.",
        });
        return;
      }
      previousIndex = canonicalIndex;
    }
  });
const keyboardMutationReceiptSchema = mutationReceiptSchema
  .extend({ heldKeys: heldKeysSchema })
  .strict();
type KeyboardMutationReceipt = MutationReceipt & {
  readonly heldKeys: readonly PhysicalKey[];
};

function freezeKeyboardMutationReceipt(
  receipt: KeyboardMutationReceipt,
): KeyboardMutationReceipt {
  Object.freeze(receipt.heldKeys);
  return Object.freeze(receipt);
}

const pasteReceiptSchema = mutationReceiptSchema
  .extend({
    originalByteCount: nonNegativeIntegerSchema,
    normalizedByteCount: nonNegativeIntegerSchema,
    normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    terminalState: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    measuredCharsPerSecond: z.number().nonnegative().finite().nullable(),
  })
  .strict();
const releaseReceiptSchema = mutationReceiptSchema
  .extend({
    mutationGateClosed: z.literal(true),
    deferredProducersJoined: z.literal(true),
    pasteTerminal: z.enum(["cancelled", "inactive"]),
    ordinaryLeasesZero: z.literal(true),
    keyboardZero: z.literal(true),
    pointerZero: z.literal(true),
    generationDrained: z.literal(true),
    heldKeys: z.array(z.enum(PHYSICAL_KEYS)).length(0),
  })
  .strict();
const observationSchema = z
  .object({
    observationId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    sessionGeneration: positiveIntegerSchema,
    connectionEpoch: positiveIntegerSchema,
    displayGeneration: nonNegativeIntegerSchema,
    frameId: opaqueIdSchema,
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
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
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

function normalizePasteText(text: string): string {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
}

function bindingMatches(
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

type ObservationLedgerEntry = {
  readonly observation: Observation;
  readonly registeredAtMs: number;
  state: "available" | "reserved" | "consumed";
};

export class FakeBrowserPlane implements BrowserPlane {
  private readonly scenarios = new PlaneScenarioEngine();
  private publishedConnection?: {
    readonly binding: DeviceRpcBinding;
    readonly displayGeneration: number;
  };
  private readonly observations = new Map<string, ObservationLedgerEntry>();
  private lastPublishedBinding?: DeviceRpcBinding;
  private closed = true;
  private generationDrained = false;

  public constructor(
    public readonly deviceRpc: DeviceRpcAdapter,
    private readonly monotonicClock: MonotonicClock = FROZEN_MONOTONIC_CLOCK,
    private readonly captureImage?: BrowserCaptureImage,
  ) {}

  public loadScenario(scenario: PlaneScenario): void {
    this.scenarios.loadScenario(scenario);
  }

  public events(): readonly PlaneEvent[] {
    return this.scenarios.events();
  }

  public assertExhausted(): void {
    this.scenarios.assertExhausted();
  }

  public async connect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    const result = this.requiredResult(
      "connect",
      this.scenarios.consume("connect", { ref: { ...ref } }, deadline),
    );
    const connection = this.parseConnection("connect", result, ref);
    if (!bindingMatches(this.deviceRpc.binding, connection.binding)) {
      throw new Error("Fake BrowserPlane connect result adapter is invalid.");
    }
    this.observations.clear();
    this.generationDrained = false;
    this.closed = false;
    this.lastPublishedBinding = connection.binding;
    this.publishedConnection = {
      binding: connection.binding,
      displayGeneration: connection.displayGeneration,
    };
    return { ...connection, deviceRpc: this.deviceRpc };
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.assertPublishedRef(ref, true);
    const previous = this.lastPublishedBinding;
    if (previous === undefined) {
      throw new Error(
        "Fake BrowserPlane reconnect requires a prior published connection.",
      );
    }
    const result = this.requiredResult(
      "reconnect",
      this.scenarios.consume("reconnect", { ref: { ...ref } }, deadline),
    );
    const connection = this.parseConnection("reconnect", result, ref);
    if (
      connection.connectionEpoch <= previous.connectionEpoch ||
      connection.browserChannelGeneration <=
        previous.browserChannelGeneration ||
      !bindingMatches(this.deviceRpc.binding, connection.binding)
    ) {
      throw new Error(
        "Fake BrowserPlane reconnect result generations are invalid.",
      );
    }
    this.observations.clear();
    this.generationDrained = false;
    this.closed = false;
    this.lastPublishedBinding = connection.binding;
    this.publishedConnection = {
      binding: connection.binding,
      displayGeneration: connection.displayGeneration,
    };
    return { ...connection, deviceRpc: this.deviceRpc };
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<BrowserCaptureArtifact> {
    this.assertPublishedRef(ref);
    const result = this.requiredResult(
      "capture",
      this.scenarios.consume(
        "capture",
        {
          ref: { ...ref },
          request: {
            format: request.format,
            maxWidth: request.maxWidth,
            maxHeight: request.maxHeight,
          },
        },
        deadline,
      ),
    );
    const parsed = observationSchema.safeParse(result);
    if (
      !parsed.success ||
      !this.captureMatches(request, parsed.data) ||
      this.observations.has(parsed.data.observationId)
    ) {
      throw new Error("Fake BrowserPlane capture result is invalid.");
    }
    if (this.captureImage === undefined) {
      throw new Error(
        "Fake BrowserPlane capture requires an authorized image fixture.",
      );
    }
    const artifact: BrowserCaptureArtifact = {
      observation: parsed.data,
      image: this.captureImage,
    };
    assertBrowserCaptureArtifact(artifact);
    this.observations.set(parsed.data.observationId, {
      observation: parsed.data,
      registeredAtMs: this.readMonotonicTick(),
      state: "available",
    });
    return artifact;
  }

  public async mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.withObservation(ref, request.observationId, () => {
      const result = this.requiredResult(
        "mouse",
        this.scenarios.consume(
          "mouse",
          {
            ref: { ...ref },
            request: {
              observationId: request.observationId,
              requestId: request.requestId,
              actionCount: request.actions.length,
            },
          },
          deadline,
        ),
      );
      return this.parseMutationReceipt(
        "mouse",
        result,
        request.requestId,
        request.actions.length,
      );
    });
  }

  public async keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.withObservation(ref, request.observationId, () => {
      const result = this.requiredResult(
        "keyboard",
        this.scenarios.consume(
          "keyboard",
          {
            ref: { ...ref },
            request: {
              observationId: request.observationId,
              requestId: request.requestId,
              actionCount: request.actions.length,
            },
          },
          deadline,
        ),
      );
      return this.parseMutationReceipt(
        "keyboard",
        result,
        request.requestId,
        request.actions.length,
      );
    });
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    return this.withObservation(ref, request.observationId, () => {
      const normalizedText = normalizePasteText(request.text);
      const originalBytes = Buffer.from(request.text, "utf8");
      const normalizedBytes = Buffer.from(normalizedText, "utf8");
      const originalSha256 = createHash("sha256")
        .update(originalBytes)
        .digest("hex");
      const normalizedSha256 = createHash("sha256")
        .update(normalizedBytes)
        .digest("hex");
      const result = this.requiredResult(
        "paste",
        this.scenarios.consume(
          "paste",
          {
            ref: { ...ref },
            request: {
              observationId: request.observationId,
              requestId: request.requestId,
              originalByteCount: originalBytes.byteLength,
              originalSha256,
              normalizedByteCount: normalizedBytes.byteLength,
              normalizedSha256,
            },
          },
          deadline,
        ),
      );
      const parsed = pasteReceiptSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.requestId !== request.requestId ||
        parsed.data.dispatchedCount !== normalizedBytes.byteLength ||
        parsed.data.completedCount !== normalizedBytes.byteLength ||
        parsed.data.originalByteCount !== originalBytes.byteLength ||
        parsed.data.normalizedByteCount !== normalizedBytes.byteLength ||
        parsed.data.normalizedSha256 !== normalizedSha256
      ) {
        throw new Error("Fake BrowserPlane paste receipt is invalid.");
      }
      return parsed.data;
    });
  }

  public async release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt> {
    this.assertPublishedRef(ref);
    try {
      const result = this.requiredResult(
        "release",
        this.scenarios.consume(
          "release",
          { ref: { ...ref }, request: { requestId: request.requestId } },
          deadline,
        ),
      );
      const parsed = releaseReceiptSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.requestId !== request.requestId ||
        parsed.data.dispatchedCount !== 1 ||
        parsed.data.completedCount !== 1
      ) {
        throw new Error("Fake BrowserPlane release receipt is invalid.");
      }
      this.drainPublishedGeneration();
      return parsed.data;
    } catch (error) {
      if (
        error instanceof PlaneFaultError &&
        error.writeBegan &&
        error.outcome !== "not_sent"
      ) {
        this.drainPublishedGeneration();
      }
      throw error;
    }
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.assertPublishedRef(ref, true);
    const result = this.scenarios.consume(
      "close",
      { ref: { ...ref } },
      deadline,
    );
    if (result !== undefined) {
      throw new Error("Fake BrowserPlane close result is invalid.");
    }
    this.closed = true;
    delete this.publishedConnection;
    this.observations.clear();
  }

  private withObservation<T>(
    ref: SessionRef,
    observationId: string,
    operation: () => T,
  ): T {
    const entry = this.reserveObservation(ref, observationId);
    const eventCount = this.scenarios.events().length;
    try {
      this.assertObservationMatches(ref, entry, "reserved");
      const result = operation();
      entry.state = "consumed";
      return result;
    } catch (error) {
      const stepConsumed = this.scenarios.events().length !== eventCount;
      entry.state =
        !stepConsumed ||
        (error instanceof PlaneFaultError &&
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
      throw new Error("Fake BrowserPlane observation is unseen.");
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
        "Fake BrowserPlane observation is stale, foreign, or consumed.",
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
        "Fake BrowserPlane monotonic observation age is invalid.",
      );
    }
    return ageMs;
  }

  private readMonotonicTick(): number {
    const tick = this.monotonicClock.now();
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new Error("Fake BrowserPlane monotonic clock is invalid.");
    }
    return tick;
  }

  private parseConnection(
    operation: "connect" | "reconnect",
    result: unknown,
    ref: SessionRef,
  ): Omit<BrowserConnection, "deviceRpc"> {
    const parsed = connectionSchema.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.ref.sessionId !== ref.sessionId ||
      parsed.data.ref.sessionGeneration !== ref.sessionGeneration ||
      parsed.data.binding.sessionId !== ref.sessionId ||
      parsed.data.binding.sessionGeneration !== ref.sessionGeneration ||
      parsed.data.binding.connectionEpoch !== parsed.data.connectionEpoch ||
      parsed.data.binding.browserChannelGeneration !==
        parsed.data.browserChannelGeneration
    ) {
      throw new Error(`Fake BrowserPlane ${operation} result is invalid.`);
    }
    return parsed.data;
  }

  private parseMutationReceipt(
    operation: "mouse" | "keyboard",
    result: unknown,
    requestId: string,
    expectedCount: number,
  ): MutationReceipt {
    if (operation === "keyboard") {
      const parsed = keyboardMutationReceiptSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.requestId !== requestId ||
        parsed.data.dispatchedCount !== expectedCount ||
        parsed.data.completedCount !== expectedCount
      ) {
        throw new Error(`Fake BrowserPlane ${operation} receipt is invalid.`);
      }
      return freezeKeyboardMutationReceipt(parsed.data);
    }
    const parsed = mutationReceiptSchema.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.requestId !== requestId ||
      parsed.data.dispatchedCount !== expectedCount ||
      parsed.data.completedCount !== expectedCount
    ) {
      throw new Error(`Fake BrowserPlane ${operation} receipt is invalid.`);
    }
    return parsed.data;
  }

  private captureMatches(
    request: CaptureRequest,
    observation: Observation,
  ): boolean {
    const published = this.publishedConnection;
    if (published === undefined) return false;
    const rotated = observation.rotation === 90 || observation.rotation === 270;
    const sourceWidth = rotated
      ? observation.sourceHeight
      : observation.sourceWidth;
    const sourceHeight = rotated
      ? observation.sourceWidth
      : observation.sourceHeight;
    const expectedFormat = request.format;
    return (
      observation.sessionId === published.binding.sessionId &&
      observation.sessionGeneration === published.binding.sessionGeneration &&
      observation.connectionEpoch === published.binding.connectionEpoch &&
      observation.displayGeneration === published.displayGeneration &&
      observation.format === expectedFormat &&
      observation.imageWidth <= request.maxWidth &&
      observation.imageHeight <= request.maxHeight &&
      observation.imageWidth <= sourceWidth &&
      observation.imageHeight <= sourceHeight &&
      observation.geometry.contentWidth * sourceHeight ===
        observation.geometry.contentHeight * sourceWidth &&
      observation.geometry.contentX + observation.geometry.contentWidth <=
        observation.imageWidth &&
      observation.geometry.contentY + observation.geometry.contentHeight <=
        observation.imageHeight
    );
  }

  private assertPublishedRef(ref: SessionRef, allowDrained = false): void {
    this.assertCurrentRef(ref);
    const publication = this.publishedConnection;
    if (
      this.closed ||
      publication === undefined ||
      publication.binding.sessionId !== ref.sessionId ||
      publication.binding.sessionGeneration !== ref.sessionGeneration
    ) {
      throw new Error("Fake BrowserPlane has no published connection.");
    }
    if (this.generationDrained && !allowDrained) {
      throw new Error("Fake BrowserPlane generation input is drained.");
    }
  }

  private drainPublishedGeneration(): void {
    if (this.closed || this.publishedConnection === undefined) return;
    this.observations.clear();
    this.generationDrained = true;
  }

  private assertCurrentRef(ref: SessionRef): void {
    const binding = this.deviceRpc.binding;
    if (
      ref.sessionId !== binding.sessionId ||
      ref.sessionGeneration !== binding.sessionGeneration
    ) {
      throw new Error("Fake BrowserPlane session reference is stale.");
    }
  }

  private requiredResult(operation: string, result: unknown): unknown {
    if (result === undefined) {
      throw new Error(
        `Fake BrowserPlane step ${operation} requires an explicit result.`,
      );
    }
    return result;
  }
}
