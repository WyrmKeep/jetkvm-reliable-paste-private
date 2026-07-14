import { createHash } from "node:crypto";

import {
  activateIndependentLegacySseBearerCredential,
  loadCredentialSecret,
  type CredentialSourceSelection,
  type IndependentLegacySseBearerCredential,
} from "./browser/auth.js";
import type { BrowserControllerPort } from "./browser/BrowserController.js";
import { ManagedBrowserController } from "./browser/ManagedBrowserController.js";
import { PlaywrightBrowserFactory } from "./browser/PlaywrightBrowserFactory.js";
import type { OperatorConfig } from "./config.js";
import type { CapabilitySnapshot } from "./domain.js";
import {
  DeviceRpcError,
  type Deadline,
} from "./device/DeviceRpcAdapter.js";
import type { HandlerRegistry } from "./mcp/server.js";
import { JetKvmNativeControlPlane } from "./native/JetKvmNativeControlPlane.js";
import { JetKvmBrowserPlane } from "./planes/JetKvmBrowserPlane.js";
import type { BrowserConnection } from "./planes/BrowserPlane.js";
import {
  createToolHandlerComposition,
  type ToolHandlerComposition,
} from "./ToolHandlers.js";

export interface ProductionRuntime {
  readonly handlers: HandlerRegistry;
  readonly composition: ToolHandlerComposition;
  readonly browser: JetKvmBrowserPlane;
  readonly native: JetKvmNativeControlPlane;
  activateLegacySseBearer(
    source: CredentialSourceSelection,
  ): IndependentLegacySseBearerCredential;
  close(): Promise<void>;
}

export function configuredDeviceFingerprint(targetUrl: string): string {
  return `jetkvm-${createHash("sha256").update(targetUrl).digest("hex")}`;
}

export async function qualifyConnectionCapabilities(
  controller: BrowserControllerPort,
  connection: BrowserConnection,
  deadline: Deadline,
): Promise<CapabilitySnapshot> {
  const snapshot = await controller.snapshot(deadline);
  const display = await connection.deviceRpc.readDisplayState(
    connection.binding,
    deadline,
  );
  if (display.qualification !== "current_binding") {
    throw new DeviceRpcError(
      "CONNECTION_LOST",
      "ack",
      "not_sent",
      false,
      false,
    );
  }
  const browserReady = snapshot.state === "ready";
  const rpcReady = browserReady && snapshot.rpc_ready;
  const hidReady = browserReady && snapshot.hid_ready;
  const videoReady =
    browserReady &&
    snapshot.video_ready &&
    snapshot.source_width !== null &&
    snapshot.source_height !== null;
  return {
    session_status: browserReady,
    display_capture: videoReady,
    display_status: rpcReady,
    mouse: hidReady && snapshot.absolute_pointer,
    absolute_pointer: hidReady && snapshot.absolute_pointer,
    keyboard: hidReady && snapshot.keyboard_layout !== null,
    reliable_paste: rpcReady && snapshot.reliable_paste,
    input_release: hidReady && rpcReady,
    power_control: rpcReady,
    edid_read: rpcReady,
  };
}

export function createProductionRuntime(
  config: Readonly<OperatorConfig>,
): ProductionRuntime {
  const credential = loadCredentialSecret(config.credential);
  const factory = new PlaywrightBrowserFactory({
    targetUrl: config.targetUrl,
    credential,
  });
  const controller = new ManagedBrowserController(factory);
  const browser = new JetKvmBrowserPlane(controller);
  const native = new JetKvmNativeControlPlane(browser.deviceRpc);
  const capabilitiesForConnection = (
    connection: BrowserConnection,
    deadline: Deadline,
  ): Promise<CapabilitySnapshot> =>
    qualifyConnectionCapabilities(controller, connection, deadline);
  const composition = createToolHandlerComposition({
    browser,
    browserStatus: browser,
    native,
    configuredDevice: configuredDeviceFingerprint(config.targetUrl),
    capabilitiesForConnection,
  });
  let closePromise: Promise<void> | null = null;
  const activateLegacySseBearer = (
    source: CredentialSourceSelection,
  ): IndependentLegacySseBearerCredential => {
    const bearerSecret = loadCredentialSecret(source);
    return activateIndependentLegacySseBearerCredential(credential, {
      principalId: "legacy-sse-operator",
      secret: bearerSecret,
    });
  };
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const controllerSignal = new AbortController();
      try {
        await controller.dispose({
          timeoutMs: 10_000,
          signal: controllerSignal.signal,
        });
      } finally {
        credential.dispose();
      }
    })();
    return closePromise;
  };
  return Object.freeze({
    handlers: composition.handlers,
    composition,
    browser,
    native,
    activateLegacySseBearer,
    close,
  });
}
