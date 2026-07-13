import { z } from "zod";

import type {
  Deadline,
  DeviceRpcAdapter,
  DeviceRpcBinding,
  SessionRef,
} from "../../device/DeviceRpcAdapter.js";
import type {
  NativeControlPlane,
  NativeDisplayStatus,
  NativeSessionStatus,
  PowerReceipt,
  PowerRequest,
} from "../../planes/NativeControlPlane.js";
import {
  SanitizedReplayCursor,
  type JsonValue,
  type SanitizedReplayTape,
} from "./SanitizedReplayTape.js";

const powerReceiptSchema = z
  .object({
    requestId: z.string().min(1),
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
    const expected = this.replay.consume("sessionStatus", { ref: { ...ref } });
    const display = await this.deviceRpc.readDisplayState(
      this.bindingFor(ref),
      deadline,
    );
    const actual: NativeSessionStatus = {
      rpcReachability: "reachable",
      nativeProcess: "available",
      display,
    };
    this.replay.assertResult("sessionStatus", expected, this.asJson(actual));
    return actual;
  }

  public async displayStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeDisplayStatus> {
    this.validateDeadline(deadline);
    const expected = this.replay.consume("displayStatus", { ref: { ...ref } });
    const binding = this.bindingFor(ref);
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    const edid = await this.deviceRpc.readEdid(binding, deadline);
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
    const expected = this.replay.consume("powerControl", {
      ref: { ...ref },
      request: { requestId: request.requestId, action: request.action },
    });
    const actual = await this.deviceRpc.performAtx(
      this.bindingFor(ref),
      request,
      deadline,
    );
    if (!powerReceiptSchema.safeParse(actual).success) {
      throw new Error("Native replay ATX receipt shape is invalid.");
    }
    this.replay.assertResult("powerControl", expected, this.asJson(actual));
    return actual;
  }

  private bindingFor(ref: SessionRef): DeviceRpcBinding {
    const binding = this.deviceRpc.binding;
    return binding.sessionId === ref.sessionId &&
      binding.sessionGeneration === ref.sessionGeneration
      ? binding
      : {
          sessionId: ref.sessionId,
          sessionGeneration: ref.sessionGeneration,
          connectionEpoch: binding.connectionEpoch,
          browserChannelGeneration: binding.browserChannelGeneration,
        };
  }

  private validateDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted)
      throw new Error("Replay plane call was cancelled before admission.");
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs < 100) {
      throw new Error("Replay plane deadline is invalid.");
    }
  }

  private asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }
}
