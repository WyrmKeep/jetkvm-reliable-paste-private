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
import type {
  BrowserConnection,
  BrowserPlane,
  CaptureRequest,
  KeyboardRequest,
  MouseRequest,
  MutationReceipt,
  Observation,
  PasteReceipt,
  PasteRequest,
  ReleaseReceipt,
  ReleaseRequest,
} from "../../planes/BrowserPlane.js";
import {
  SanitizedReplayCursor,
  type JsonValue,
  type SanitizedReplayTape,
} from "./SanitizedReplayTape.js";

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
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
    sessionGeneration: positiveIntegerSchema,
    connectionEpoch: positiveIntegerSchema,
    displayGeneration: nonNegativeIntegerSchema,
    frameId: requestIdSchema,
    capturedAt: z.string().datetime(),
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
        contentX: z.number().nonnegative(),
        contentY: z.number().nonnegative(),
        contentWidth: z.number().positive(),
        contentHeight: z.number().positive(),
      })
      .strict(),
    artifact: z.discriminatedUnion("mimeType", [
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
    ]),
  })
  .strict();

export interface ReplayFrameArtifactProvider {
  resolve(sha256: string): Promise<Uint8Array>;
}

export interface ReplayDeviceRpcAdapterReplacement {
  invalidate(previous: DeviceRpcAdapter): Promise<void>;
  createReplacement(
    recordedBinding: DeviceRpcBinding,
  ): DeviceRpcAdapter | Promise<DeviceRpcAdapter>;
}

export class BrowserPlaneReplay implements BrowserPlane {
  private readonly replay: SanitizedReplayCursor;
  private currentDeviceRpc: DeviceRpcAdapter;
  private publishedConnection?: {
    readonly binding: DeviceRpcBinding;
    readonly displayGeneration: number;
  };

  public constructor(
    deviceRpc: DeviceRpcAdapter,
    tape: SanitizedReplayTape,
    private readonly frameArtifacts?: ReplayFrameArtifactProvider,
    private readonly replaceDeviceRpc?: ReplayDeviceRpcAdapterReplacement,
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
    this.publishedConnection = {
      binding: parsed.data.binding,
      displayGeneration: parsed.data.displayGeneration,
    };
    return { ...parsed.data, deviceRpc: this.deviceRpc };
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.validateDeadline(deadline);
    const previousPublication = this.publishedConnection;
    if (previousPublication === undefined) {
      throw new Error("Replay reconnect requires a published connection.");
    }
    const response = this.replay.consume("reconnect", { ref: { ...ref } });
    const parsed = connectionSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay reconnect response shape is invalid.");
    if (!this.connectionMatchesRef(parsed.data, ref)) {
      throw new Error("Replay reconnect response identity is invalid.");
    }
    if (
      parsed.data.connectionEpoch <=
        previousPublication.binding.connectionEpoch ||
      parsed.data.browserChannelGeneration <=
        previousPublication.binding.browserChannelGeneration
    ) {
      throw new Error("Replay reconnect generations must strictly increase.");
    }
    const previous = this.deviceRpc;
    if (this.replaceDeviceRpc === undefined) {
      throw new Error("Replay reconnect requires an adapter replacement.");
    }
    await this.replaceDeviceRpc.invalidate(previous);
    const replacement = await this.replaceDeviceRpc.createReplacement(
      parsed.data.binding,
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
    this.publishedConnection = {
      binding: parsed.data.binding,
      displayGeneration: parsed.data.displayGeneration,
    };
    return { ...parsed.data, deviceRpc: replacement };
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<Observation> {
    this.validateDeadline(deadline);
    this.assertCurrentRef(ref);
    if (
      !Number.isSafeInteger(request.maxWidth) ||
      request.maxWidth <= 0 ||
      !Number.isSafeInteger(request.maxHeight) ||
      request.maxHeight <= 0
    ) {
      throw new Error("Replay capture request bounds are invalid.");
    }
    const response = this.replay.consume("capture", {
      ref: { ...ref },
      request: { ...request },
    });
    const parsed = observationSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay capture response shape is invalid.");
    const expectedMimeType =
      request.format === "jpeg" ? "image/jpeg" : "image/png";
    const publication = this.publishedConnection;
    const rotated = parsed.data.rotation === 90 || parsed.data.rotation === 270;
    const sourceWidth = rotated
      ? parsed.data.sourceHeight
      : parsed.data.sourceWidth;
    const sourceHeight = rotated
      ? parsed.data.sourceWidth
      : parsed.data.sourceHeight;
    if (
      publication === undefined ||
      parsed.data.sessionGeneration !== publication.binding.sessionGeneration ||
      parsed.data.connectionEpoch !== publication.binding.connectionEpoch ||
      parsed.data.displayGeneration !== publication.displayGeneration ||
      parsed.data.artifact.mimeType !== expectedMimeType ||
      parsed.data.imageWidth > request.maxWidth ||
      parsed.data.imageHeight > request.maxHeight ||
      parsed.data.imageWidth > sourceWidth ||
      parsed.data.imageHeight > sourceHeight ||
      parsed.data.imageWidth * sourceHeight !==
        parsed.data.imageHeight * sourceWidth ||
      parsed.data.geometry.contentX + parsed.data.geometry.contentWidth >
        parsed.data.imageWidth ||
      parsed.data.geometry.contentY + parsed.data.geometry.contentHeight >
        parsed.data.imageHeight
    ) {
      throw new Error(
        "Replay capture response does not match the published connection, geometry, or format.",
      );
    }
    if (this.frameArtifacts === undefined) {
      throw new Error(
        "Replay capture requires an external sanitized frame artifact provider.",
      );
    }
    const bytes = await this.frameArtifacts.resolve(
      parsed.data.artifact.sha256,
    );
    if (
      bytes.byteLength !== parsed.data.artifact.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !==
        parsed.data.artifact.sha256
    ) {
      throw new Error("Replay frame artifact failed its length or hash proof.");
    }
    const { artifact, ...metadata } = parsed.data;
    return {
      ...metadata,
      image: { mimeType: artifact.mimeType, sha256: artifact.sha256, bytes },
    };
  }

  public async mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.consumeReceipt(
      "mouse",
      ref,
      request,
      deadline,
      mutationReceiptSchema,
      request.actions.length,
    );
  }

  public async keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.consumeReceipt(
      "keyboard",
      ref,
      request,
      deadline,
      mutationReceiptSchema,
      request.actions.length,
    );
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    this.validateDeadline(deadline);
    this.assertCurrentRef(ref);
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
  }

  public async release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt> {
    return this.consumeReceipt(
      "release",
      ref,
      request,
      deadline,
      releaseReceiptSchema,
      1,
    );
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.validateDeadline(deadline);
    this.assertCurrentRef(ref);
    const response = this.replay.consume("close", { ref: { ...ref } });
    if (response !== null)
      throw new Error("Replay close response must be null.");
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
    this.validateDeadline(deadline);
    this.assertCurrentRef(ref);
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
