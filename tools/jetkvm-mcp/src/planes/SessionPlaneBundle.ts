import type { DeviceRpcAdapter } from "../device/DeviceRpcAdapter.js";
import type { BrowserPlane } from "./BrowserPlane.js";
import type { NativeControlPlane } from "./NativeControlPlane.js";

export interface SessionPlaneBundle {
  readonly browser: BrowserPlane;
  readonly native: NativeControlPlane;
  readonly deviceRpc: DeviceRpcAdapter;
}

export function validateSessionPlaneBundle(
  bundle: SessionPlaneBundle,
): SessionPlaneBundle {
  if (
    bundle.browser.deviceRpc !== bundle.deviceRpc ||
    bundle.native.deviceRpc !== bundle.deviceRpc
  ) {
    throw new Error(
      "BrowserPlane and NativeControlPlane must share the same DeviceRpcAdapter object.",
    );
  }
  return bundle;
}
