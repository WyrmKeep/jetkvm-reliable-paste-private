import { z } from "zod";

import {
  DeviceRpcError,
  OPAQUE_ID_PATTERN,
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

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const nonNegativeIntegerSchema = z.number().int().min(0).max(MAX_JSON_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(MAX_JSON_INTEGER);
const cachedFactSchema = <T extends z.ZodTypeAny, U extends z.ZodTypeAny>(
  value: T,
  unobservedValue: U,
) =>
  z.discriminatedUnion("source", [
    z
      .object({
        value,
        observedAt: z.string().datetime(),
        ageMs: nonNegativeIntegerSchema,
        freshness: z.enum(["fresh", "stale"]),
        source: z.enum(["cached_snapshot", "cached_event"]),
      })
      .strict(),
    z
      .object({
        value: unobservedValue,
        observedAt: z.null(),
        ageMs: z.null(),
        freshness: z.literal("unknown"),
        source: z.literal("none"),
      })
      .strict(),
  ]);
const fakeDisplayObjectSchema = z
  .object({
    signal: cachedFactSchema(
      z.enum(["present", "no_signal", "no_lock", "out_of_range", "unknown"]),
      z.literal("unknown"),
    ),
    resolution: cachedFactSchema(
      z
        .object({
          width: positiveIntegerSchema,
          height: positiveIntegerSchema,
          refreshHz: z.number().positive().finite().nullable(),
        })
        .strict()
        .nullable(),
      z.null(),
    ),
    fps: cachedFactSchema(
      z.number().nonnegative().finite().nullable(),
      z.null(),
    ),
    qualification: z.enum(["current_binding", "binding_lost_cached_only"]),
  })
  .strict();
export const fakeDisplayStateSchema = fakeDisplayObjectSchema.superRefine(
  (state, context) => {
    if (state.qualification !== "binding_lost_cached_only") return;
    for (const [name, fact] of [
      ["signal", state.signal],
      ["resolution", state.resolution],
      ["fps", state.fps],
    ] as const) {
      if (fact.freshness === "fresh") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name, "freshness"],
          message: "A binding-loss fact cannot be fresh.",
        });
      }
    }
  },
);
export const fakeEdidSchema = z.discriminatedUnion("status", [
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
          productCode: nonNegativeIntegerSchema.nullable(),
          serialNumber: z.string().nullable(),
          displayName: z.string().nullable(),
          preferredResolution: z
            .object({
              width: positiveIntegerSchema,
              height: positiveIntegerSchema,
              refreshHz: z.number().positive().finite().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
]);

const ATX_SEMANTICS = {
  press_power: { wireAction: "power-short", fixedPressMs: 200 },
  hold_power: { wireAction: "power-long", fixedPressMs: 5000 },
  press_reset: { wireAction: "reset", fixedPressMs: 200 },
} as const;

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
    requestId: opaqueIdSchema,
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

export function fakeAtxReceiptMatchesRequest(
  request: { readonly requestId: string; readonly action: AtxAction },
  receipt: AtxWireReceipt,
): boolean {
  const expected = ATX_SEMANTICS[request.action];
  return (
    receipt.requestId === request.requestId &&
    receipt.action === request.action &&
    receipt.wireAction === expected.wireAction &&
    receipt.fixedPressMs === expected.fixedPressMs
  );
}

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
    const parsed = fakeDisplayStateSchema.safeParse(
      this.requiredResult<unknown>(
        "readDisplayState",
        this.scenarios.consume(
          "readDisplayState",
          { ref: { ...ref } },
          deadline,
        ),
      ),
    );
    if (!parsed.success) {
      throw new Error("Fake DeviceRpcAdapter display result shape is invalid.");
    }
    return parsed.data;
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    this.assertCurrent(ref);
    const parsed = fakeEdidSchema.safeParse(
      this.requiredResult<unknown>(
        "readEdid",
        this.scenarios.consume("readEdid", { ref: { ...ref } }, deadline),
      ),
    );
    if (!parsed.success) {
      throw new Error("Fake DeviceRpcAdapter EDID result shape is invalid.");
    }
    return parsed.data;
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
    if (!fakeAtxReceiptMatchesRequest(request, parsed.data)) {
      throw new Error(
        "Fake DeviceRpcAdapter ATX result correlation is invalid.",
      );
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
