import { z } from "zod";

import {
  OPAQUE_ID_PATTERN,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcBinding,
  type SessionRef,
} from "../../device/DeviceRpcAdapter.js";
import type {
  NativeControlPlane,
  NativeDisplayStatus,
  NativeDisplayStatusRequest,
  NativeSessionStatus,
  PowerReceipt,
  PowerRequest,
} from "../../planes/NativeControlPlane.js";
import {
  SanitizedReplayCursor,
  atxReplayReceiptMatchesRequest,
  type JsonValue,
  type SanitizedReplayTape,
} from "./SanitizedReplayTape.js";

const powerReceiptSchema = z
  .object({
    requestId: z.string().regex(OPAQUE_ID_PATTERN),
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    wireAction: z.enum(["power-short", "power-long", "reset"]),
    fixedPressMs: z.union([z.literal(200), z.literal(5000)]),
    serialSequenceCompleted: z.literal(true),
    acknowledgedAt: z.string().datetime(),
    atxLedObservation: z.discriminatedUnion("freshness", [
      z
        .object({
          power: z.boolean().nullable(),
          hdd: z.boolean().nullable(),
          observedAt: z.string().datetime(),
          freshness: z.enum(["fresh", "stale"]),
        })
        .strict(),
      z
        .object({
          power: z.null(),
          hdd: z.null(),
          observedAt: z.null(),
          freshness: z.literal("unknown"),
        })
        .strict(),
    ]),
    verification: z.literal("device_ack_only"),
    postRead: z
      .object({ status: z.enum(["available", "unavailable"]) })
      .strict(),
  })
  .strict();
const recordedSessionStatusSchema = z
  .object({
    rpcReachability: z.enum(["reachable", "unreachable", "unknown"]),
    nativeProcess: z.enum([
      "available",
      "restarting",
      "unavailable",
      "unknown",
    ]),
    display: z.unknown(),
  })
  .strict();

export class NativeControlPlaneReplay implements NativeControlPlane {
  private readonly replay: SanitizedReplayCursor;

  public constructor(
    public readonly deviceRpc: DeviceRpcAdapter,
    tape: SanitizedReplayTape,
  ) {
    this.replay = new SanitizedReplayCursor(tape, "native");
  }

  public assertExhausted(): void {
    this.replay.assertExhausted();
  }

  public async sessionStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeSessionStatus> {
    this.validateDeadline(deadline);
    const binding = this.bindingFor(ref);
    const expected = this.replay.consume("sessionStatus", { ref: { ...ref } });
    const recorded = recordedSessionStatusSchema.safeParse(expected);
    if (!recorded.success) {
      throw new Error("Native replay session status shape is invalid.");
    }
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    const actual: NativeSessionStatus = {
      rpcReachability: recorded.data.rpcReachability,
      nativeProcess: recorded.data.nativeProcess,
      display,
    };
    this.replay.assertResult("sessionStatus", expected, this.asJson(actual));
    return actual;
  }

  public async displayStatus(
    ref: SessionRef,
    request: NativeDisplayStatusRequest,
    deadline: Deadline,
  ): Promise<NativeDisplayStatus> {
    this.validateDeadline(deadline);
    const binding = this.bindingFor(ref);
    const edidReadSupported = request.edidReadSupported;
    const expected = this.replay.consume("displayStatus", {
      ref: { ...ref },
      request: { edidReadSupported },
    });
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    const edid = edidReadSupported
      ? await this.deviceRpc.readEdid(binding, deadline)
      : {
          status: "unsupported" as const,
          readCompleted: false as const,
          reason: "edid_read_capability_absent" as const,
          observedAt: null,
          data: null,
        };
    const actual: NativeDisplayStatus = { ...display, edid };
    this.replay.assertResult("displayStatus", expected, this.asJson(actual));
    return actual;
  }

  public async powerControl(
    ref: SessionRef,
    request: PowerRequest,
    deadline: Deadline,
  ): Promise<PowerReceipt> {
    this.validateDeadline(deadline);
    const binding = this.bindingFor(ref);
    const expected = this.replay.consume("powerControl", {
      ref: { ...ref },
      request: { requestId: request.requestId, action: request.action },
    });
    const actual = await this.deviceRpc.performAtx(binding, request, deadline);
    const parsed = powerReceiptSchema.safeParse(actual);
    if (!parsed.success) {
      throw new Error("Native replay ATX receipt shape is invalid.");
    }
    if (!atxReplayReceiptMatchesRequest(request, parsed.data)) {
      throw new Error("Native replay ATX receipt correlation is invalid.");
    }
    this.replay.assertResult("powerControl", expected, this.asJson(actual));
    return actual;
  }

  private bindingFor(ref: SessionRef): DeviceRpcBinding {
    const binding = this.deviceRpc.binding;
    if (
      binding.sessionId !== ref.sessionId ||
      binding.sessionGeneration !== ref.sessionGeneration
    ) {
      throw new Error("Native replay session reference is stale.");
    }
    return binding;
  }

  private validateDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted)
      throw new Error("Replay plane call was cancelled before admission.");
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs <= 0) {
      throw new Error("Replay plane deadline is invalid.");
    }
  }

  private asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }
}
