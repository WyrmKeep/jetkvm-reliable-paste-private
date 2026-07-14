import { z } from "zod";

import {
  type CapabilitySnapshot,
  type ObservedFact,
  type PermissionName,
  type SessionConnectInput,
  type SessionReconnectInput,
  type SessionStatusResult,
} from "../domain.js";
import type {
  Deadline,
  QualifiedFact,
  NativeSignal,
  SessionRef,
} from "../device/DeviceRpcAdapter.js";
import type { ErrorCode, RequiredNextStep } from "../errors.js";
import type { NativeSessionStatus } from "../planes/NativeControlPlane.js";
import type {
  DeviceSessionConnectSuccess,
  DeviceSessionInspection,
  DeviceSessionReconnectSuccess,
} from "./deviceSessionClient.js";

export interface SessionOwnershipPort {
  connect(
    principal: string,
    input: SessionConnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionConnectSuccess>;
  reconnect(
    principal: string,
    input: SessionReconnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionReconnectSuccess>;
  inspectSession(principal: string, ref: SessionRef): DeviceSessionInspection;
}

export interface BrowserSessionObservation {
  readonly deviceReachable: boolean | null;
  readonly setupState: "complete" | "required" | "unknown";
  readonly authMode: "password" | "no_password" | "unknown";
  readonly lifecycleState: "ready" | "degraded";
  readonly webRtc:
    | "connecting"
    | "connected"
    | "disconnected"
    | "failed"
    | "unknown";
  readonly hid: "ready" | "not_ready" | "unknown";
  readonly decodedVideo: "ready" | "stalled" | "unavailable" | "unknown";
  readonly dispatchGeneration: number;
  readonly activeMutation: boolean;
  readonly blockedReason: string | null;
  readonly uiContractVersion: string | null;
  readonly firmwareVersion: string | null;
}

export interface BrowserSessionStatusPort {
  observeSession(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserSessionObservation>;
}

export interface NativeSessionStatusPort {
  sessionStatus(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<NativeSessionStatus>;
}

export interface SessionServiceOptions {
  readonly sessions: SessionOwnershipPort;
  readonly browserStatus: BrowserSessionStatusPort;
  readonly native: NativeSessionStatusPort;
  readonly serverVersion: string;
  readonly protocolVersion: string;
}

export class SessionServiceError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    public readonly safeToRetry: boolean,
    public readonly requiredNextStep: RequiredNextStep,
  ) {
    super(code);
    this.name = "SessionServiceError";
  }
}

const browserSessionObservationSchema = z
  .object({
    deviceReachable: z.boolean().nullable(),
    setupState: z.enum(["complete", "required", "unknown"]),
    authMode: z.enum(["password", "no_password", "unknown"]),
    lifecycleState: z.enum(["ready", "degraded"]),
    webRtc: z.enum([
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "unknown",
    ]),
    hid: z.enum(["ready", "not_ready", "unknown"]),
    decodedVideo: z.enum(["ready", "stalled", "unavailable", "unknown"]),
    dispatchGeneration: z.number().int().nonnegative(),
    activeMutation: z.boolean(),
    blockedReason: z.string().nullable(),
    uiContractVersion: z.string().nullable(),
    firmwareVersion: z.string().nullable(),
  })
  .strict();

const UNKNOWN_CAPABILITIES: CapabilitySnapshot = Object.freeze({
  session_status: false,
  display_capture: false,
  display_status: false,
  mouse: false,
  absolute_pointer: false,
  keyboard: false,
  reliable_paste: false,
  input_release: false,
  power_control: false,
  edid_read: false,
});

function capabilitiesFor(
  inspection: DeviceSessionInspection,
): CapabilitySnapshot {
  if (inspection.capabilities !== null) {
    return inspection.capabilities;
  }
  return UNKNOWN_CAPABILITIES;
}

function lifecycleState(
  inspection: DeviceSessionInspection,
): SessionStatusResult["state"] {
  if (inspection.state === "reconnecting") {
    return "connecting";
  }
  return inspection.state;
}

function unknownFact<T, F extends T = T>(value: F): ObservedFact<T, F> {
  return {
    value,
    observed_at: null,
    age_ms: null,
    freshness: "unknown",
    source: "none",
  };
}

function mapFact<T, U, F extends U>(
  fact: QualifiedFact<T>,
  mapValue: (value: T) => U,
  unavailableValue: F,
): ObservedFact<U, F> {
  if (
    fact.source === "none" ||
    fact.observedAt === null ||
    fact.ageMs === null ||
    fact.freshness === "unknown"
  ) {
    return unknownFact(unavailableValue);
  }
  return {
    value: mapValue(fact.value),
    observed_at: fact.observedAt,
    age_ms: fact.ageMs,
    freshness: fact.freshness,
    source: "cached_event",
  };
}

function blockedReasonFor(inspection: DeviceSessionInspection): string | null {
  switch (inspection.state) {
    case "drained":
      return "session_drained";
    case "taken_over":
      return "session_taken_over";
    case "connecting":
    case "reconnecting":
      return "session_connecting";
    case "closing":
      return "session_closing";
    case "failed":
      return "session_failed";
    case "ready":
      return inspection.active ? null : "session_not_active";
  }
}

export class SessionService {
  readonly #sessions: SessionOwnershipPort;
  readonly #browserStatus: BrowserSessionStatusPort;
  readonly #native: NativeSessionStatusPort;
  readonly #serverVersion: string;
  readonly #protocolVersion: string;

  public constructor(options: SessionServiceOptions) {
    if (options.serverVersion.length === 0 || options.protocolVersion.length === 0) {
      throw new TypeError("Session service versions must not be empty.");
    }
    this.#sessions = options.sessions;
    this.#browserStatus = options.browserStatus;
    this.#native = options.native;
    this.#serverVersion = options.serverVersion;
    this.#protocolVersion = options.protocolVersion;
  }

  public connect(
    principal: string,
    input: SessionConnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionConnectSuccess> {
    return this.#sessions.connect(principal, input, callerSignal);
  }

  public reconnect(
    principal: string,
    input: SessionReconnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionReconnectSuccess> {
    return this.#sessions.reconnect(principal, input, callerSignal);
  }

  public async status(
    principal: string,
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<SessionStatusResult> {
    this.#assertDeadline(deadline);
    const inspection = this.#sessions.inspectSession(principal, ref);
    if (!inspection.permissions.includes("session.status")) {
      throw new SessionServiceError(
        "PERMISSION_DENIED",
        false,
        "grant_permission",
      );
    }
    if (inspection.capabilities?.session_status === false) {
      throw new SessionServiceError(
        "CAPABILITY_MISSING",
        false,
        "enable_capability",
      );
    }

    if (inspection.state !== "ready" || !inspection.active) {
      return this.#statusWithoutCurrentBinding(inspection);
    }

    const [browserResult, nativeResult] = await Promise.allSettled([
      this.#browserStatus.observeSession(ref, deadline),
      this.#native.sessionStatus(ref, deadline),
    ]);
    this.#assertDeadline(deadline);

    let browser: BrowserSessionObservation | null = null;
    if (browserResult.status === "fulfilled") {
      const parsed = browserSessionObservationSchema.safeParse(
        browserResult.value,
      );
      if (!parsed.success) {
        throw new SessionServiceError(
          "DOWNSTREAM_MALFORMED_RESPONSE",
          false,
          "reconnect_then_capture",
        );
      }
      browser = parsed.data;
    }
    const native =
      nativeResult.status === "fulfilled" ? nativeResult.value : null;
    const unknownSignal = unknownFact<NativeSignal, "unknown">("unknown");
    const capabilities = capabilitiesFor(inspection);

    return {
      state: browser?.lifecycleState ?? "degraded",
      connection_epoch: inspection.connectionEpoch,
      display_generation: inspection.displayGeneration,
      dispatch_generation: browser?.dispatchGeneration ?? 0,
      browser_channel_generation: inspection.browserChannelGeneration,
      device_reachable: browser?.deviceReachable ?? null,
      setup_state: browser?.setupState ?? "unknown",
      auth_mode: browser?.authMode ?? "unknown",
      rpc_reachability: native?.rpcReachability ?? "unknown",
      native_process: native?.nativeProcess ?? "unknown",
      web_rtc: browser?.webRtc ?? "unknown",
      hid: browser?.hid ?? "unknown",
      decoded_video: browser?.decodedVideo ?? "unknown",
      native_capture_facts:
        native === null
          ? {
              signal: unknownSignal,
              resolution: unknownFact(null),
              fps: unknownFact(null),
            }
          : {
              signal: mapFact<NativeSignal, NativeSignal, "unknown">(
                native.display.signal,
                (value) => value,
                "unknown",
              ),
              resolution: mapFact(
                native.display.resolution,
                (value) =>
                  value === null
                    ? null
                    : { width: value.width, height: value.height },
                null,
              ),
              fps: mapFact(native.display.fps, (value) => value, null),
            },
      active_mutation: browser?.activeMutation ?? false,
      fresh_capture_required: inspection.freshCaptureRequired,
      permissions: [...inspection.permissions],
      capabilities,
      blocked_reason:
        browser?.blockedReason ??
        (browserResult.status === "rejected"
          ? "browser_status_unavailable"
          : nativeResult.status === "rejected"
            ? "native_status_unavailable"
            : null),
      versions: {
        server: this.#serverVersion,
        protocol: this.#protocolVersion,
        ui_contract: browser?.uiContractVersion ?? null,
        firmware: browser?.firmwareVersion ?? null,
      },
    };
  }

  #statusWithoutCurrentBinding(
    inspection: DeviceSessionInspection,
  ): SessionStatusResult {
    return {
      state: lifecycleState(inspection),
      connection_epoch: inspection.connectionEpoch,
      display_generation: inspection.displayGeneration,
      dispatch_generation: 0,
      browser_channel_generation: inspection.browserChannelGeneration,
      device_reachable: null,
      setup_state: "unknown",
      auth_mode: "unknown",
      rpc_reachability: "unknown",
      native_process: "unknown",
      web_rtc: "unknown",
      hid: "unknown",
      decoded_video: "unknown",
      native_capture_facts: {
        signal: unknownFact("unknown"),
        resolution: unknownFact(null),
        fps: unknownFact(null),
      },
      active_mutation: false,
      fresh_capture_required: inspection.freshCaptureRequired,
      permissions: [...inspection.permissions],
      capabilities: capabilitiesFor(inspection),
      blocked_reason: blockedReasonFor(inspection),
      versions: {
        server: this.#serverVersion,
        protocol: this.#protocolVersion,
        ui_contract: null,
        firmware: null,
      },
    };
  }

  #assertDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted) {
      throw new SessionServiceError("CANCELLED", true, "none");
    }
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs <= 0) {
      throw new SessionServiceError("DEADLINE_EXCEEDED", true, "none");
    }
  }
}

