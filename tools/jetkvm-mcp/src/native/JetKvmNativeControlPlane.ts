import {
  DeviceRpcError,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcBinding,
  type QualifiedEdidRead,
  type SessionRef,
} from "../device/DeviceRpcAdapter.js";
import type {
  NativeControlPlane,
  NativeDisplayStatus,
  NativeDisplayStatusRequest,
  NativeSessionStatus,
  PowerReceipt,
  PowerRequest,
} from "../planes/NativeControlPlane.js";

const UNSUPPORTED_EDID: QualifiedEdidRead = Object.freeze({
  status: "unsupported",
  readCompleted: false,
  reason: "edid_read_capability_absent",
  observedAt: null,
  data: null,
});

export class JetKvmNativeControlPlane implements NativeControlPlane {
  public constructor(public readonly deviceRpc: DeviceRpcAdapter) {}

  public async sessionStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeSessionStatus> {
    const binding = this.bindingFor(ref);
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
    this.validateDisplayRequest(request);
    const edidReadSupported = request.edidReadSupported;
    const display = await this.deviceRpc.readDisplayState(binding, deadline);
    if (!edidReadSupported) {
      return { ...display, edid: UNSUPPORTED_EDID };
    }
    const edid = await this.deviceRpc.readEdid(binding, deadline);
    return { ...display, edid };
  }

  public async powerControl(
    ref: SessionRef,
    request: PowerRequest,
    deadline: Deadline,
  ): Promise<PowerReceipt> {
    return this.deviceRpc.performAtx(this.bindingFor(ref), request, deadline);
  }

  private bindingFor(ref: SessionRef): DeviceRpcBinding {
    const binding = this.deviceRpc.binding;
    if (
      binding.sessionId !== ref.sessionId ||
      binding.sessionGeneration !== ref.sessionGeneration
    ) {
      throw new DeviceRpcError(
        "STALE_BINDING",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
    return binding;
  }

  private validateDisplayRequest(request: NativeDisplayStatusRequest): void {
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request) ||
      Object.keys(request).length !== 1 ||
      typeof request.edidReadSupported !== "boolean"
    ) {
      throw new DeviceRpcError(
        "INVALID_REQUEST",
        "admission",
        "not_sent",
        false,
        false,
      );
    }
  }
}
