import { describe, expect, it } from "vitest";

import type { CapabilitySnapshot, PermissionName } from "../domain.js";
import type { Deadline, SessionRef } from "../device/DeviceRpcAdapter.js";
import type { NativeSessionStatus } from "../planes/NativeControlPlane.js";
import type {
  DeviceSessionConnectSuccess,
  DeviceSessionInspection,
  DeviceSessionReconnectSuccess,
} from "./deviceSessionClient.js";
import {
  SessionService,
  SessionServiceError,
  type BrowserSessionObservation,
  type SessionOwnershipPort,
} from "./SessionService.js";

const REF: SessionRef = { sessionId: "session-1", sessionGeneration: 1 };
const CAPABILITIES: CapabilitySnapshot = {
  session_status: true,
  display_capture: true,
  display_status: true,
  mouse: true,
  absolute_pointer: true,
  keyboard: true,
  reliable_paste: true,
  input_release: true,
  power_control: true,
  edid_read: true,
};
const PERMISSIONS: readonly PermissionName[] = [
  "session.connect",
  "session.status",
  "session.reconnect",
];
const INSPECTION: DeviceSessionInspection = {
  ref: REF,
  state: "ready",
  active: true,
  inputDrained: false,
  connectionEpoch: 4,
  displayGeneration: 7,
  browserChannelGeneration: 9,
  freshCaptureRequired: true,
  permissions: PERMISSIONS,
  capabilities: CAPABILITIES,
};
const BROWSER: BrowserSessionObservation = {
  deviceReachable: true,
  setupState: "complete",
  authMode: "password",
  lifecycleState: "degraded",
  webRtc: "connected",
  hid: "ready",
  decodedVideo: "stalled",
  dispatchGeneration: 11,
  activeMutation: false,
  blockedReason: "video_stalled",
  uiContractVersion: "automation-v1",
  firmwareVersion: "firmware-test",
};
const NATIVE: NativeSessionStatus = {
  rpcReachability: "reachable",
  nativeProcess: "available",
  display: {
    qualification: "current_binding",
    signal: {
      value: "present",
      observedAt: "2026-07-14T00:00:00.000Z",
      ageMs: 5,
      freshness: "stale",
      source: "cached_event",
    },
    resolution: {
      value: { width: 1920, height: 1080, refreshHz: 60 },
      observedAt: "2026-07-14T00:00:00.000Z",
      ageMs: 5,
      freshness: "stale",
      source: "cached_event",
    },
    fps: {
      value: 59.94,
      observedAt: "2026-07-14T00:00:00.000Z",
      ageMs: 5,
      freshness: "stale",
      source: "cached_event",
    },
  },
};

function dependencies(overrides: {
  inspection?: DeviceSessionInspection;
  permissions?: readonly PermissionName[];
} = {}) {
  const calls: string[] = [];
  const inspection = {
    ...(overrides.inspection ?? INSPECTION),
    permissions: overrides.permissions ??
      overrides.inspection?.permissions ??
      INSPECTION.permissions,
  };
  const connectSuccess: DeviceSessionConnectSuccess = {
    ref: REF,
    result: {
      request_id: "connect-1",
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      state: "ready",
      connection_epoch: 4,
      display_generation: 7,
      takeover_performed: false,
      fresh_capture_required: true,
      permissions: [...PERMISSIONS],
      capabilities: CAPABILITIES,
    },
  };
  const reconnectSuccess: DeviceSessionReconnectSuccess = {
    ref: { sessionId: REF.sessionId, sessionGeneration: 2 },
    result: {
      request_id: "reconnect-1",
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      previous_session_generation: 1,
      new_session_generation: 2,
      connection_epoch: 5,
      state: "ready",
      takeover_performed: false,
      fresh_capture_required: true,
    },
  };
  const sessions: SessionOwnershipPort = {
    connect: async () => {
      calls.push("connect");
      return connectSuccess;
    },
    reconnect: async () => {
      calls.push("reconnect");
      return reconnectSuccess;
    },
    inspectSession: () => {
      calls.push("inspect");
      return inspection;
    },
  };
  const service = new SessionService({
    sessions,
    browserStatus: {
      observeSession: async () => {
        calls.push("browser");
        return BROWSER;
      },
    },
    native: {
      sessionStatus: async () => {
        calls.push("native");
        return NATIVE;
      },
    },
    serverVersion: "0.1.0",
    protocolVersion: "2025-06-18",
  });
  return { service, calls };
}

const DEADLINE: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

describe("SessionService", () => {
  it("composes separate lifecycle, browser, native, capture, and version facts", async () => {
    const { service, calls } = dependencies();

    const result = await service.status("principal-a", REF, DEADLINE);

    expect(calls).toEqual(["inspect", "browser", "native"]);
    expect(result).toEqual({
      state: "degraded",
      connection_epoch: 4,
      display_generation: 7,
      dispatch_generation: 11,
      browser_channel_generation: 9,
      device_reachable: true,
      setup_state: "complete",
      auth_mode: "password",
      rpc_reachability: "reachable",
      native_process: "available",
      web_rtc: "connected",
      hid: "ready",
      decoded_video: "stalled",
      native_capture_facts: {
        signal: {
          value: "present",
          observed_at: "2026-07-14T00:00:00.000Z",
          age_ms: 5,
          freshness: "stale",
          source: "cached_event",
        },
        resolution: {
          value: { width: 1920, height: 1080 },
          observed_at: "2026-07-14T00:00:00.000Z",
          age_ms: 5,
          freshness: "stale",
          source: "cached_event",
        },
        fps: {
          value: 59.94,
          observed_at: "2026-07-14T00:00:00.000Z",
          age_ms: 5,
          freshness: "stale",
          source: "cached_event",
        },
      },
      active_mutation: false,
      fresh_capture_required: true,
      permissions: [...PERMISSIONS],
      capabilities: CAPABILITIES,
      blocked_reason: "video_stalled",
      versions: {
        server: "0.1.0",
        protocol: "2025-06-18",
        ui_contract: "automation-v1",
        firmware: "firmware-test",
      },
    });
  });

  it("reports a drained owner without probing another current plane binding", async () => {
    const { service, calls } = dependencies({
      inspection: { ...INSPECTION, state: "drained", inputDrained: true },
    });

    const result = await service.status("principal-a", REF, DEADLINE);

    expect(calls).toEqual(["inspect"]);
    expect(result).toMatchObject({
      state: "drained",
      connection_epoch: 4,
      browser_channel_generation: 9,
      rpc_reachability: "unknown",
      native_process: "unknown",
      web_rtc: "unknown",
      hid: "unknown",
      decoded_video: "unknown",
      blocked_reason: "session_drained",
    });
  });

  it("rejects status before any browser or native probe when permission is absent", async () => {
    const { service, calls } = dependencies({
      permissions: ["session.connect"],
    });

    await expect(service.status("principal-a", REF, DEADLINE)).rejects.toEqual(
      expect.objectContaining<Partial<SessionServiceError>>({
        code: "PERMISSION_DENIED",
        safeToRetry: false,
        requiredNextStep: "grant_permission",
      }),
    );
    expect(calls).toEqual(["inspect"]);
  });

  it("rejects status before plane probes when session status capability is absent", async () => {
    const { service, calls } = dependencies({
      inspection: {
        ...INSPECTION,
        capabilities: { ...CAPABILITIES, session_status: false },
      },
    });

    await expect(service.status("principal-a", REF, DEADLINE)).rejects.toEqual(
      expect.objectContaining<Partial<SessionServiceError>>({
        code: "CAPABILITY_MISSING",
        safeToRetry: false,
        requiredNextStep: "enable_capability",
      }),
    );
    expect(calls).toEqual(["inspect"]);
  });
});
