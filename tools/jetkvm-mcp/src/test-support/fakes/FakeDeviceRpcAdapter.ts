import {
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
    return this.requiredResult<AtxWireReceipt>(
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
  }

  private assertCurrent(ref: DeviceRpcBinding): void {
    if (
      ref.sessionId !== this.currentBinding.sessionId ||
      ref.sessionGeneration !== this.currentBinding.sessionGeneration ||
      ref.connectionEpoch !== this.currentBinding.connectionEpoch ||
      ref.browserChannelGeneration !==
        this.currentBinding.browserChannelGeneration
    ) {
      throw new PlaneFaultError("stale_generation", 0, 0);
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
