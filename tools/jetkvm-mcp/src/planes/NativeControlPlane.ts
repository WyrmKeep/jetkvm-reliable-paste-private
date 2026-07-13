import type {
  AtxAction,
  AtxWireReceipt,
  CachedDisplayState,
  Deadline,
  DeviceRpcAdapter,
  QualifiedEdidRead,
  SessionRef,
} from "../device/DeviceRpcAdapter.js";

export interface NativeSessionStatus {
  readonly rpcReachability: "reachable" | "unreachable" | "unknown";
  readonly nativeProcess:
    | "available"
    | "unavailable"
    | "restarting"
    | "unknown";
  readonly display: CachedDisplayState;
}

export interface NativeDisplayStatus extends CachedDisplayState {
  readonly edid: QualifiedEdidRead;
}

export interface PowerRequest {
  readonly requestId: string;
  readonly action: AtxAction;
}

export type PowerReceipt = AtxWireReceipt;

/**
 * Qualified native semantics over an injected Browser-owned DeviceRpcAdapter.
 * Implementations must not create a browser, peer connection, data channel, or
 * direct HID/native bypass.
 */
export interface NativeControlPlane {
  readonly deviceRpc: DeviceRpcAdapter;
  sessionStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeSessionStatus>;
  displayStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeDisplayStatus>;
  powerControl(
    ref: SessionRef,
    request: PowerRequest,
    deadline: Deadline,
  ): Promise<PowerReceipt>;
}
