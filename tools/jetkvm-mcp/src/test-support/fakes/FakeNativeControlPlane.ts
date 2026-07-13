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
  NativeDisplayStatusRequest,
  NativeSessionStatus,
  PowerReceipt,
  PowerRequest,
} from "../../planes/NativeControlPlane.js";
import {
  PlaneScenarioEngine,
  type PlaneEvent,
  type PlaneScenario,
} from "./PlaneScenario.js";
import {
  fakeAtxReceiptMatchesRequest,
  fakeAtxReceiptSchema,
  fakeDisplayStateSchema,
  fakeEdidSchema,
} from "./FakeDeviceRpcAdapter.js";

const fakeNativeSessionStatusSchema = z
  .object({
    rpcReachability: z.enum(["reachable", "unreachable", "unknown"]),
    nativeProcess: z.enum([
      "available",
      "unavailable",
      "restarting",
      "unknown",
    ]),
    display: fakeDisplayStateSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (
      status.display.qualification === "binding_lost_cached_only" &&
      status.rpcReachability === "reachable"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rpcReachability"],
        message: "A lost RPC binding cannot be reachable.",
      });
    }
  });
const explicitDisplayStatusShape = z
  .object({
    signal: z.unknown(),
    resolution: z.unknown(),
    fps: z.unknown(),
    qualification: z.unknown(),
    edid: z.unknown(),
  })
  .strict();

export class FakeNativeControlPlane implements NativeControlPlane {
  private readonly scenarios = new PlaneScenarioEngine();

  public constructor(public readonly deviceRpc: DeviceRpcAdapter) {}

  public loadScenario(scenario: PlaneScenario): void {
    this.scenarios.loadScenario(scenario);
  }

  public events(): readonly PlaneEvent[] {
    return this.scenarios.events();
  }

  public assertExhausted(): void {
    this.scenarios.assertExhausted();
  }

  public async sessionStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeSessionStatus> {
    const binding = this.bindingFor(ref);
    const explicit = this.scenarios.consume(
      "sessionStatus",
      { ref: { ...ref } },
      deadline,
    );
    if (explicit !== undefined) {
      const parsed = fakeNativeSessionStatusSchema.safeParse(explicit);
      if (!parsed.success) {
        throw new Error(
          "Fake NativeControlPlane session result shape is invalid.",
        );
      }
      return parsed.data;
    }
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    const bindingLost = display.qualification === "binding_lost_cached_only";
    return {
      rpcReachability: bindingLost ? "unreachable" : "reachable",
      nativeProcess: bindingLost ? "unknown" : "available",
      display,
    };
  }

  public async displayStatus(
    ref: SessionRef,
    request: NativeDisplayStatusRequest,
    deadline: Deadline,
  ): Promise<NativeDisplayStatus> {
    const binding = this.bindingFor(ref);
    const edidReadSupported = request.edidReadSupported;
    const explicit = this.scenarios.consume(
      "displayStatus",
      { ref: { ...ref }, request: { edidReadSupported } },
      deadline,
    );
    if (explicit !== undefined) {
      const structural = explicitDisplayStatusShape.safeParse(explicit);
      if (!structural.success) {
        throw new Error(
          "Fake NativeControlPlane display result shape is invalid.",
        );
      }
      const { edid, ...display } = structural.data;
      const parsedDisplay = fakeDisplayStateSchema.safeParse(display);
      const parsedEdid = fakeEdidSchema.safeParse(edid);
      if (!parsedDisplay.success || !parsedEdid.success) {
        throw new Error(
          "Fake NativeControlPlane display result shape is invalid.",
        );
      }
      return { ...parsedDisplay.data, edid: parsedEdid.data };
    }
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    if (!edidReadSupported) {
      return {
        ...display,
        edid: {
          status: "unsupported",
          readCompleted: false,
          reason: "edid_read_capability_absent",
          observedAt: null,
          data: null,
        },
      };
    }
    const edid = await this.deviceRpc.readEdid(binding, deadline);
    return { ...display, edid };
  }

  public async powerControl(
    ref: SessionRef,
    request: PowerRequest,
    deadline: Deadline,
  ): Promise<PowerReceipt> {
    const binding = this.bindingFor(ref);
    const explicit = this.scenarios.consume(
      "powerControl",
      {
        ref: { ...ref },
        request: { requestId: request.requestId, action: request.action },
      },
      deadline,
    );
    const result =
      explicit ?? (await this.deviceRpc.performAtx(binding, request, deadline));
    const parsed = fakeAtxReceiptSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error("Fake NativeControlPlane ATX result shape is invalid.");
    }
    if (!fakeAtxReceiptMatchesRequest(request, parsed.data)) {
      throw new Error(
        "Fake NativeControlPlane ATX result correlation is invalid.",
      );
    }
    return parsed.data;
  }

  private bindingFor(ref: SessionRef): DeviceRpcBinding {
    const binding = this.deviceRpc.binding;
    if (
      binding.sessionId !== ref.sessionId ||
      binding.sessionGeneration !== ref.sessionGeneration
    ) {
      throw new Error("Fake NativeControlPlane session reference is stale.");
    }
    return binding;
  }
}
