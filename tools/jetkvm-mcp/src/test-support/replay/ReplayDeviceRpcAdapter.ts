import { z } from "zod";

import type {
  AtxAction,
  AtxWireReceipt,
  CachedDisplayState,
  Deadline,
  DeviceRpcAdapter,
  DeviceRpcBinding,
  QualifiedEdidRead,
} from "../../device/DeviceRpcAdapter.js";
import {
  SanitizedReplayCursor,
  type SanitizedReplayTape,
} from "./SanitizedReplayTape.js";

const factMetadata = {
  observedAt: z.string().datetime().nullable(),
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
      observedAt: z.string().datetime(),
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      readCompleted: z.literal(true),
      reason: z.null(),
      observedAt: z.string().datetime(),
      data: z
        .object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
const atxSchema = z
  .object({
    requestId: z.string().min(1),
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    wireAction: z.enum(["power-short", "power-long", "reset"]),
    fixedPressMs: z.union([z.literal(200), z.literal(5000)]),
    serialSequenceCompleted: z.literal(true),
    acknowledgedAt: z.string().datetime(),
    atxLedObservation: z
      .object({
        power: z.boolean().nullable(),
        hdd: z.boolean().nullable(),
        observedAt: z.string().datetime().nullable(),
        freshness: z.enum(["fresh", "stale", "unknown"]),
      })
      .strict(),
    verification: z.literal("device_ack_only"),
    postRead: z
      .object({ status: z.enum(["available", "unavailable"]) })
      .strict(),
  })
  .strict();

export class ReplayDeviceRpcAdapter implements DeviceRpcAdapter {
  private readonly replay: SanitizedReplayCursor;

  public constructor(
    public readonly binding: DeviceRpcBinding,
    tape: SanitizedReplayTape,
  ) {
    this.replay = new SanitizedReplayCursor(tape, "device_rpc");
  }

  public assertExhausted(): void {
    this.replay.assertExhausted();
  }

  public async readDisplayState(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("readDisplayState", {
      ref: { ...ref },
    });
    const parsed = displaySchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay display state response shape is invalid.");
    return parsed.data;
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("readEdid", { ref: { ...ref } });
    const parsed = edidSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay EDID response shape is invalid.");
    return parsed.data;
  }

  public async performAtx(
    ref: DeviceRpcBinding,
    request: { readonly requestId: string; readonly action: AtxAction },
    deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    this.validateDeadline(deadline);
    const response = this.replay.consume("performAtx", {
      ref: { ...ref },
      request: { requestId: request.requestId, action: request.action },
    });
    const parsed = atxSchema.safeParse(response);
    if (!parsed.success)
      throw new Error("Replay ATX response shape is invalid.");
    return parsed.data;
  }

  private validateDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted)
      throw new Error("Replay adapter call was cancelled before admission.");
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs < 100) {
      throw new Error("Replay adapter deadline is invalid.");
    }
  }
}
