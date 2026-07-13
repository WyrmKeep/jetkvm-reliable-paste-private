import { createHash } from "node:crypto";

import { z } from "zod";
import { PHYSICAL_KEYS } from "../../domain.js";

import type {
  Deadline,
  DeviceRpcAdapter,
  SessionRef,
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

const requestIdSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
const mutationReceiptFields = {
  requestId: requestIdSchema,
  outcome: z.enum(["applied", "already_applied"]),
  verification: z.enum(["device_ack_only", "device_state_verified"]),
  dispatchedCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  acknowledgedAt: timestampSchema,
} as const;
const mutationReceiptSchema = z
  .object(mutationReceiptFields)
  .strict()
  .refine((receipt) => receipt.completedCount <= receipt.dispatchedCount);
const pasteReceiptSchema = z
  .object({
    ...mutationReceiptFields,
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
    ...mutationReceiptFields,
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
const bindingSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    sessionGeneration: z.number().int().positive(),
    connectionEpoch: z.number().int().positive(),
    browserChannelGeneration: z.number().int().positive(),
  })
  .strict();
const connectionSchema = z
  .object({
    state: z.literal("ready"),
    ref: z
      .object({
        sessionId: z.string().min(1).max(256),
        sessionGeneration: z.number().int().positive(),
      })
      .strict(),
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
    capturedAt: z.string().datetime(),
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

export class BrowserPlaneReplay implements BrowserPlane {
  private readonly replay: SanitizedReplayCursor;

  public constructor(
    public readonly deviceRpc: DeviceRpcAdapter,
    tape: SanitizedReplayTape,
    private readonly frameArtifacts?: ReplayFrameArtifactProvider,
  ) {
    this.replay = new SanitizedReplayCursor(tape, "browser");
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
    if (
      parsed.data.ref.sessionId !== ref.sessionId ||
      parsed.data.ref.sessionGeneration !== ref.sessionGeneration ||
      parsed.data.binding.sessionId !== parsed.data.ref.sessionId ||
      parsed.data.binding.sessionGeneration !==
        parsed.data.ref.sessionGeneration ||
      parsed.data.binding.connectionEpoch !== parsed.data.connectionEpoch ||
      parsed.data.binding.browserChannelGeneration !==
        parsed.data.browserChannelGeneration
    ) {
      throw new Error("Replay connect response identity is invalid.");
    }
    return { ...parsed.data, deviceRpc: this.deviceRpc };
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("reconnect", { ref: { ...ref } });
    const parsed = connectionSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay reconnect response shape is invalid.");
    if (
      parsed.data.ref.sessionId !== ref.sessionId ||
      parsed.data.ref.sessionGeneration !== ref.sessionGeneration ||
      parsed.data.binding.sessionId !== parsed.data.ref.sessionId ||
      parsed.data.binding.sessionGeneration !==
        parsed.data.ref.sessionGeneration ||
      parsed.data.binding.connectionEpoch !== parsed.data.connectionEpoch ||
      parsed.data.binding.browserChannelGeneration !==
        parsed.data.browserChannelGeneration
    ) {
      throw new Error("Replay reconnect response identity is invalid.");
    }
    return { ...parsed.data, deviceRpc: this.deviceRpc };
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<Observation> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("capture", {
      ref: { ...ref },
      request: { ...request },
    });
    const parsed = observationSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay capture response shape is invalid.");
    const expectedMimeType =
      request.format === "jpeg" ? "image/jpeg" : "image/png";
    if (
      parsed.data.sessionGeneration !== ref.sessionGeneration ||
      parsed.data.artifact.mimeType !== expectedMimeType
    ) {
      throw new Error("Replay capture response identity or format is invalid.");
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
    );
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    this.validateDeadline(deadline);
    const encoded = Buffer.from(request.text, "utf8");
    let sourceCharacterCount = 0;
    for (const character of request.text) {
      sourceCharacterCount += character.length > 0 ? 1 : 0;
    }
    const response = this.replay.consume("paste", {
      ref: { ...ref },
      request: {
        observationId: request.observationId,
        requestId: request.requestId,
        textByteLength: encoded.byteLength,
        sourceCharacterCount,
        textSha256: createHash("sha256").update(encoded).digest("hex"),
      },
    });
    const parsed = pasteReceiptSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay paste response shape is invalid.");
    if (parsed.data.requestId !== request.requestId)
      throw new Error("Replay paste receipt request ID is invalid.");
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
    );
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("close", { ref: { ...ref } });
    if (response !== null)
      throw new Error("Replay close response must be null.");
  }

  private async consumeReceipt<T extends { readonly requestId: string }>(
    operation: "mouse" | "keyboard" | "release",
    ref: SessionRef,
    request: MouseRequest | KeyboardRequest | ReleaseRequest,
    deadline: Deadline,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.validateDeadline(deadline);
    const response = this.replay.consume(operation, {
      ref: { ...ref },
      request: JSON.parse(JSON.stringify(request)) as JsonValue,
    });
    const parsed = schema.safeParse(response);
    if (!parsed.success)
      throw new Error(`Replay ${operation} response shape is invalid.`);
    if (parsed.data.requestId !== request.requestId)
      throw new Error(`Replay ${operation} receipt request ID is invalid.`);
    return parsed.data;
  }

  private validateDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted)
      throw new Error("Replay plane call was cancelled before admission.");
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs < 100) {
      throw new Error("Replay plane deadline is invalid.");
    }
  }
}
