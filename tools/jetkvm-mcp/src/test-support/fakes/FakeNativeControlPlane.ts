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
  PlaneScenarioEngine,
  type PlaneEvent,
  type PlaneScenario,
} from "./PlaneScenario.js";
import { fakeAtxReceiptSchema } from "./FakeDeviceRpcAdapter.js";

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
    const explicit = this.scenarios.consume(
      "sessionStatus",
      { ref: { ...ref } },
      deadline,
    );
    if (explicit !== undefined) return explicit as NativeSessionStatus;
    const display = await this.deviceRpc.readDisplayState(
      this.bindingFor(ref),
      deadline,
    );
    return {
      rpcReachability: "reachable",
      nativeProcess: "available",
      display,
    };
  }

  public async displayStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeDisplayStatus> {
    const explicit = this.scenarios.consume(
      "displayStatus",
      { ref: { ...ref } },
      deadline,
    );
    if (explicit !== undefined) return explicit as NativeDisplayStatus;
    const binding = this.bindingFor(ref);
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    const edid = await this.deviceRpc.readEdid(binding, deadline);
    return { ...display, edid };
  }

  public async powerControl(
    ref: SessionRef,
    request: PowerRequest,
    deadline: Deadline,
  ): Promise<PowerReceipt> {
    const explicit = this.scenarios.consume(
      "powerControl",
      {
        ref: { ...ref },
        request: { requestId: request.requestId, action: request.action },
      },
      deadline,
    );
    const result =
      explicit ??
      (await this.deviceRpc.performAtx(
        this.bindingFor(ref),
        request,
        deadline,
      ));
    const parsed = fakeAtxReceiptSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error("Fake NativeControlPlane ATX result shape is invalid.");
    }
    return parsed.data;
  }

  private bindingFor(ref: SessionRef): DeviceRpcBinding {
    const binding = this.deviceRpc.binding;
    if (
      binding.sessionId !== ref.sessionId ||
      binding.sessionGeneration !== ref.sessionGeneration
    ) {
      return {
        sessionId: ref.sessionId,
        sessionGeneration: ref.sessionGeneration,
        connectionEpoch: binding.connectionEpoch,
        browserChannelGeneration: binding.browserChannelGeneration,
      };
    }
    return binding;
  }
}
