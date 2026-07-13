import { z } from "zod";

import {
  DeviceRpcError,
  mapDeviceRpcBindingToWire,
  type AtxAction,
  type AtxWireReceipt,
  type CachedDisplayState,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcBinding,
  type QualifiedEdidRead,
} from "../../device/DeviceRpcAdapter.js";
import {
  PlaneFaultError,
  PlaneScenarioEngine,
  type PlaneEvent,
  type PlaneScenario,
} from "./PlaneScenario.js";

const atxLedObservationSchema = z.discriminatedUnion("freshness", [
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
]);
export const fakeAtxReceiptSchema = z
  .object({
    requestId: z.string().min(1),
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    wireAction: z.enum(["power-short", "power-long", "reset"]),
    fixedPressMs: z.union([z.literal(200), z.literal(5000)]),
    serialSequenceCompleted: z.literal(true),
    acknowledgedAt: z.string().datetime(),
    atxLedObservation: atxLedObservationSchema,
    verification: z.literal("device_ack_only"),
    postRead: z
      .object({ status: z.enum(["available", "unavailable"]) })
      .strict(),
  })
  .strict();

export class FakeDeviceRpcAdapter implements DeviceRpcAdapter {
  private currentBinding: DeviceRpcBinding;
  private readonly scenarios = new PlaneScenarioEngine();

  public constructor(binding: DeviceRpcBinding) {
    mapDeviceRpcBindingToWire(binding);
    this.currentBinding = Object.freeze({ ...binding });
  }

  public get binding(): DeviceRpcBinding {
    return this.currentBinding;
  }

  public loadScenario(scenario: PlaneScenario): void {
    this.scenarios.loadScenario(scenario);
  }

  public replaceBinding(next: DeviceRpcBinding): void {
    mapDeviceRpcBindingToWire(next);
    this.currentBinding = Object.freeze({ ...next });
  }

  public events(): readonly PlaneEvent[] {
    return this.scenarios.events();
  }

  public assertExhausted(): void {
    this.scenarios.assertExhausted();
  }

  public async readDisplayState(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState> {
    this.assertCurrent(ref);
    return this.requiredResult<CachedDisplayState>(
      "readDisplayState",
      this.scenarios.consume("readDisplayState", { ref: { ...ref } }, deadline),
    );
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.assertCurrent(ref);
    return this.requiredResult<QualifiedEdidRead>(
      "readEdid",
      this.scenarios.consume("readEdid", { ref: { ...ref } }, deadline),
    );
  }

  public async performAtx(
    ref: DeviceRpcBinding,
    request: { readonly requestId: string; readonly action: AtxAction },
    deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    this.assertCurrent(ref);
    const result = this.requiredResult<unknown>(
      "performAtx",
      this.scenarios.consume(
        "performAtx",
        {
          ref: { ...ref },
          request: { requestId: request.requestId, action: request.action },
        },
        deadline,
      ),
    );
    const parsed = fakeAtxReceiptSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error("Fake DeviceRpcAdapter ATX result shape is invalid.");
    }
    return parsed.data;
  }

  private assertCurrent(ref: DeviceRpcBinding): void {
    if (
      ref.sessionId !== this.currentBinding.sessionId ||
      ref.sessionGeneration !== this.currentBinding.sessionGeneration
    ) {
      throw new PlaneFaultError("stale_generation", 0, 0);
    }
    if (
      ref.connectionEpoch !== this.currentBinding.connectionEpoch ||
      ref.browserChannelGeneration !==
        this.currentBinding.browserChannelGeneration
    ) {
      throw new DeviceRpcError(
        "STALE_BINDING",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
  }

  private requiredResult<T>(operation: string, result: unknown): T {
    if (result === undefined) {
      throw new Error(
        `Fake DeviceRpcAdapter step ${operation} requires an explicit result.`,
      );
    }
    return result as T;
  }
}
