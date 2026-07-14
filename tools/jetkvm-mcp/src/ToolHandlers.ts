import { randomUUID } from "node:crypto";

import {
  CAPABILITY_NAMES,
  PERMISSION_NAMES,
  type CapabilitySnapshot,
  type PermissionName,
} from "./domain.js";
import type {
  BrowserConnection,
  BrowserPlane,
} from "./planes/BrowserPlane.js";
import type { NativeControlPlane } from "./planes/NativeControlPlane.js";
import type { Deadline } from "./device/DeviceRpcAdapter.js";
import { RequestLedger } from "./idempotency/RequestLedger.js";
import { createDisplayHandlers } from "./handlers/display.js";
import { createInputHandlers } from "./handlers/input.js";
import { createPowerHandlers } from "./handlers/power.js";
import { createSessionHandlers } from "./handlers/session.js";
import {
  assertHandlerRegistry,
  type HandlerRegistry,
} from "./mcp/server.js";
import { DeviceSessionClient } from "./session/deviceSessionClient.js";
import {
  SessionService,
  type BrowserSessionStatusPort,
} from "./session/SessionService.js";

const REQUEST_LEDGER_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_LEDGER_MAX_ENTRIES = 10_000;
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "1";

export interface ToolHandlerCompositionOptions {
  readonly browser: BrowserPlane;
  readonly browserStatus: BrowserSessionStatusPort;
  readonly native: NativeControlPlane;
  readonly configuredDevice: string;
  readonly capabilitiesForConnection: (
    connection: BrowserConnection,
    deadline: Deadline,
  ) => Promise<CapabilitySnapshot>;
  readonly permissionsForPrincipal?: (
    principal: string,
  ) => readonly PermissionName[];
  readonly requestLedger?: RequestLedger;
  readonly createSessionId?: () => string;
}

export interface ToolHandlerComposition {
  readonly handlers: HandlerRegistry;
  readonly sessions: DeviceSessionClient;
  readonly sessionService: SessionService;
  readonly requestLedger: RequestLedger;
}

export function allCapabilities(enabled = true): CapabilitySnapshot {
  return Object.fromEntries(
    CAPABILITY_NAMES.map((capability) => [capability, enabled]),
  ) as CapabilitySnapshot;
}

export function createToolHandlerComposition(
  options: ToolHandlerCompositionOptions,
): ToolHandlerComposition {
  if (options.browser.deviceRpc !== options.native.deviceRpc) {
    throw new Error(
      "Production handlers require one Browser-owned DeviceRpcAdapter.",
    );
  }
  const requestLedger =
    options.requestLedger ??
    new RequestLedger({
      ttlMs: REQUEST_LEDGER_TTL_MS,
      maxEntries: REQUEST_LEDGER_MAX_ENTRIES,
    });
  const permissionsForPrincipal =
    options.permissionsForPrincipal ?? (() => PERMISSION_NAMES);
  const sessions = new DeviceSessionClient({
    browser: options.browser,
    configuredDevice: options.configuredDevice,
    requestLedger,
    createSessionId: options.createSessionId ?? randomUUID,
    permissionsForPrincipal,
    capabilitiesForConnection: options.capabilitiesForConnection,
  });
  const sessionService = new SessionService({
    sessions,
    browserStatus: options.browserStatus,
    native: options.native,
    serverVersion: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  });
  const handlers: HandlerRegistry = Object.freeze({
    ...createSessionHandlers({ service: sessionService }),
    ...createDisplayHandlers({
      browser: options.browser,
      native: options.native,
      sessions,
    }),
    ...createInputHandlers({
      browser: options.browser,
      sessions,
      requestLedger,
    }),
    ...createPowerHandlers({
      native: options.native,
      sessions,
      requestLedger,
    }),
  });
  assertHandlerRegistry(handlers);
  return Object.freeze({ handlers, sessions, sessionService, requestLedger });
}
