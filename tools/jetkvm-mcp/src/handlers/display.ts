import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  CapabilityName,
  DisplayCaptureInput,
  DisplayStatusInput,
  DisplayStatusResult,
  EdidResult,
  ObservedFact,
  PermissionName,
  Success,
  ToolError,
} from "../domain.js";
import type {
  NativeResolution,
  QualifiedEdidRead,
  QualifiedFact,
  SessionRef,
} from "../device/DeviceRpcAdapter.js";
import type { ErrorCode, ErrorPhase, RequiredNextStep } from "../errors.js";
import {
  DeviceSessionClientError,
  type DeviceSessionClient,
  type DeviceSessionSnapshot,
} from "../session/deviceSessionClient.js";
import type { BrowserPlane } from "../planes/BrowserPlane.js";
import type { NativeControlPlane } from "../planes/NativeControlPlane.js";
import {
  PUBLIC_ERROR_MESSAGES,
  toMcpErrorResult,
  toMcpSuccessResult,
} from "../mcp/results.js";
import {
  displayCaptureInputSchema,
  displayStatusInputSchema,
} from "../mcp/schemas.js";
import type {
  HandlerRegistry,
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "../mcp/server.js";
import {
  createHandlerDeadline,
  defaultErrorDetails,
  mapDisplayCaptureArtifact,
  sanitizePlaneFailure,
  type HandlerClock,
  type HandlerDeadline,
} from "./inputShared.js";

export interface DisplayHandlerDependencies {
  readonly browser: BrowserPlane;
  readonly native: NativeControlPlane;
  readonly sessions: DeviceSessionClient;
  readonly clock?: HandlerClock;
}

export type DisplayHandlerRegistry = Pick<
  HandlerRegistry,
  "jetkvm_display_capture" | "jetkvm_display_status"
>;

type ReadTool = "jetkvm_display_capture" | "jetkvm_display_status";
type ReadFailure = Readonly<{
  code: ErrorCode;
  phase: ErrorPhase;
  safeToRetry: boolean;
  requiredNextStep: RequiredNextStep;
  downstreamStage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
  permission?: PermissionName | null;
  capability?: CapabilityName | null;
  expectedGeneration?: number | null;
  actualGeneration?: number | null;
}>;

const CAPTURE_ERROR_CODES: readonly ErrorCode[] = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "AUTH_RATE_LIMITED",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "OBSERVE_ONLY",
  "SAFETY_DENIED",
  "CAPABILITY_MISSING",
  "UNSUPPORTED_UI_VERSION",
  "FIRMWARE_INCOMPATIBLE",
  "BROWSER_UNSUPPORTED",
  "SESSION_NOT_FOUND",
  "STALE_SESSION_GENERATION",
  "SESSION_TAKEN_OVER",
  "SESSION_DRAINED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "DOWNSTREAM_MALFORMED_RESPONSE",
  "VIDEO_UNAVAILABLE",
  "VIDEO_STALLED",
  "FRAME_TIMEOUT",
  "DISPLAY_CHANGED",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
];
const STATUS_ERROR_CODES: readonly ErrorCode[] = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "AUTH_RATE_LIMITED",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "OBSERVE_ONLY",
  "SAFETY_DENIED",
  "CAPABILITY_MISSING",
  "UNSUPPORTED_UI_VERSION",
  "FIRMWARE_INCOMPATIBLE",
  "BROWSER_UNSUPPORTED",
  "SESSION_NOT_FOUND",
  "STALE_SESSION_GENERATION",
  "SESSION_TAKEN_OVER",
  "SESSION_DRAINED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "DOWNSTREAM_MALFORMED_RESPONSE",
  "EDID_READ_FAILED",
  "DISPLAY_STATUS_STALE",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
];

function envelopeCoordinates(rawInput: unknown): {
  sessionId: string | null;
  sessionGeneration: number | null;
} {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    return { sessionId: null, sessionGeneration: null };
  }
  const candidate = rawInput as Record<string, unknown>;
  const sessionId =
    typeof candidate.session_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.session_id)
      ? candidate.session_id
      : null;
  const sessionGeneration =
    Number.isSafeInteger(candidate.session_generation) &&
    (candidate.session_generation as number) >= 0
      ? (candidate.session_generation as number)
      : null;
  return { sessionId, sessionGeneration };
}

function readErrorResult(
  tool: ReadTool,
  context: JetKvmHandlerContext,
  durationMs: number,
  coordinates: { sessionId: string | null; sessionGeneration: number | null },
  failure: ReadFailure,
): CallToolResult {
  const envelope: ToolError = {
    ok: false,
    tool,
    operation_id: context.correlationId,
    session_id: coordinates.sessionId,
    session_generation: coordinates.sessionGeneration,
    duration_ms: durationMs,
    error: {
      code: failure.code,
      message: PUBLIC_ERROR_MESSAGES[failure.code],
      phase: failure.phase,
      outcome: null,
      verification: "none",
      safe_to_retry: failure.safeToRetry,
      required_next_step: failure.requiredNextStep,
      details: defaultErrorDetails({
        permission: failure.permission,
        capability: failure.capability,
        downstreamStage: failure.downstreamStage,
        expectedGeneration: failure.expectedGeneration,
        actualGeneration: failure.actualGeneration,
      }),
    },
  };
  return toMcpErrorResult(envelope);
}

function sessionReadFailure(error: DeviceSessionClientError): ReadFailure {
  const phase: ErrorPhase =
    error.code === "SESSION_TAKEN_OVER" || error.code === "SESSION_DRAINED"
      ? "execute"
      : "validate";
  return {
    code: error.code,
    phase,
    safeToRetry: error.safeToRetry,
    requiredNextStep: error.requiredNextStep,
    downstreamStage: "admission",
  };
}

function readPlaneFailure(tool: ReadTool, error: unknown): ReadFailure {
  const sanitized = sanitizePlaneFailure(error);
  const allowed =
    sanitized !== null &&
    (tool === "jetkvm_display_capture"
      ? CAPTURE_ERROR_CODES.some((code) => code === sanitized.code)
      : STATUS_ERROR_CODES.some((code) => code === sanitized.code))
      ? sanitized.code
      : "DOWNSTREAM_MALFORMED_RESPONSE";
  const cleanupFailure =
    sanitized?.code === "MUTATION_OUTCOME_UNKNOWN" &&
    sanitized.stage === "verification";
  const phase: ErrorPhase = cleanupFailure
    ? "cleanup"
    : allowed === "CANCELLED" || allowed === "DEADLINE_EXCEEDED"
      ? "execute"
      : allowed === "EDID_READ_FAILED" || allowed === "DISPLAY_STATUS_STALE"
        ? "verify"
        : allowed === "VIDEO_UNAVAILABLE" ||
            allowed === "VIDEO_STALLED" ||
            allowed === "FRAME_TIMEOUT" ||
            allowed === "DISPLAY_CHANGED"
          ? "execute"
          : allowed === "CONNECTION_LOST" ||
              allowed === "DOWNSTREAM_MALFORMED_RESPONSE"
            ? "execute"
            : "connect";
  const retry = readRetryPolicy(allowed);
  return {
    code: allowed,
    phase,
    safeToRetry: retry.safeToRetry,
    requiredNextStep: retry.requiredNextStep,
    downstreamStage: sanitized?.stage ?? "acknowledgement",
  };
}

function readRetryPolicy(code: ErrorCode): {
  safeToRetry: boolean;
  requiredNextStep: RequiredNextStep;
} {
  if (code === "CANCELLED" || code === "DEADLINE_EXCEEDED") {
    return { safeToRetry: true, requiredNextStep: "none" };
  }
  if (
    code === "VIDEO_UNAVAILABLE" ||
    code === "VIDEO_STALLED" ||
    code === "FRAME_TIMEOUT" ||
    code === "DISPLAY_CHANGED"
  ) {
    return { safeToRetry: true, requiredNextStep: "capture_then_retry" };
  }
  if (code === "EDID_READ_FAILED" || code === "DISPLAY_STATUS_STALE") {
    return { safeToRetry: true, requiredNextStep: "none" };
  }
  if (
    code === "SESSION_NOT_FOUND" ||
    code === "STALE_SESSION_GENERATION" ||
    code === "SESSION_TAKEN_OVER" ||
    code === "SESSION_DRAINED"
  ) {
    return {
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    };
  }
  if (code === "DEVICE_UNREACHABLE" || code === "CONNECTION_LOST") {
    return {
      safeToRetry: true,
      requiredNextStep: "reconnect_then_capture",
    };
  }
  return {
    safeToRetry: false,
    requiredNextStep:
      code === "DOWNSTREAM_MALFORMED_RESPONSE"
        ? "reconnect_then_capture"
        : "none",
  };
}

function authorizeRead(
  snapshot: DeviceSessionSnapshot,
  permission: PermissionName,
  capability: CapabilityName,
): ReadFailure | null {
  if (!snapshot.permissions.includes(permission)) {
    return {
      code: "PERMISSION_DENIED",
      phase: "authorize",
      safeToRetry: false,
      requiredNextStep: "grant_permission",
      downstreamStage: "none",
      permission,
      capability: null,
    };
  }
  if (!snapshot.capabilities[capability]) {
    return {
      code: "CAPABILITY_MISSING",
      phase: "validate",
      safeToRetry: false,
      requiredNextStep: "enable_capability",
      downstreamStage: "none",
      permission: null,
      capability,
    };
  }
  return null;
}

function preflightReadFailure(scope: HandlerDeadline): ReadFailure | null {
  if (scope.signal.aborted) {
    return {
      code: "CANCELLED",
      phase: "queue",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  if (scope.remaining().timeoutMs <= 0) {
    return {
      code: "DEADLINE_EXCEEDED",
      phase: "queue",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  return null;
}

function resolveReadSession(
  dependencies: DisplayHandlerDependencies,
  context: JetKvmHandlerContext,
  ref: SessionRef,
): DeviceSessionSnapshot | ReadFailure {
  if (context.principalId === null) {
    return {
      code: "AUTH_FAILED",
      phase: "authorize",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  try {
    return dependencies.sessions.resolveSession(context.principalId, ref);
  } catch (error) {
    return error instanceof DeviceSessionClientError
      ? sessionReadFailure(error)
      : {
          code: "DOWNSTREAM_MALFORMED_RESPONSE",
          phase: "validate",
          safeToRetry: false,
          requiredNextStep: "reconnect_then_capture",
          downstreamStage: "none",
        };
  }
}

function isReadFailure(
  value: DeviceSessionSnapshot | ReadFailure,
): value is ReadFailure {
  return "code" in value;
}

function observedFact<T, U extends T>(
  fact: QualifiedFact<T>,
  unobservedValue: U,
): ObservedFact<T, U> {
  return fact.source === "cached_event"
    ? {
        value: fact.value,
        observed_at: fact.observedAt as string,
        age_ms: fact.ageMs as number,
        freshness: fact.freshness as "fresh" | "stale",
        source: "cached_event",
      }
    : {
        value: unobservedValue,
        observed_at: null,
        age_ms: null,
        freshness: "unknown",
        source: "none",
      };
}

function observedResolution(
  fact: QualifiedFact<NativeResolution | null>,
): DisplayStatusResult["native_resolution"] {
  const mapped =
    fact.value === null
      ? null
      : {
          width: fact.value.width,
          height: fact.value.height,
          refresh_hz: fact.value.refreshHz,
        };
  return fact.source === "cached_event"
    ? {
        value: mapped,
        observed_at: fact.observedAt as string,
        age_ms: fact.ageMs as number,
        freshness: fact.freshness as "fresh" | "stale",
        source: "cached_event",
      }
    : {
        value: null,
        observed_at: null,
        age_ms: null,
        freshness: "unknown",
        source: "none",
      };
}

function edidResult(edid: QualifiedEdidRead): EdidResult {
  if (edid.status !== "available") {
    return {
      status: edid.status,
      read_completed: edid.readCompleted,
      reason: edid.reason,
      observed_at: edid.observedAt,
      data: null,
    } as EdidResult;
  }
  return {
    status: "available",
    read_completed: true,
    reason: null,
    observed_at: edid.observedAt,
    data: {
      sha256: edid.data.sha256,
      manufacturer_id: edid.data.manufacturerId,
      product_code: edid.data.productCode,
      serial_number: edid.data.serialNumber,
      display_name: edid.data.displayName,
      preferred_resolution:
        edid.data.preferredResolution === null
          ? null
          : {
              width: edid.data.preferredResolution.width,
              height: edid.data.preferredResolution.height,
              refresh_hz: edid.data.preferredResolution.refreshHz,
            },
    },
  };
}

export function createDisplayCaptureHandler(
  dependencies: DisplayHandlerDependencies,
): JetKvmToolHandler {
  return async (rawInput, context) => {
    const coordinates = envelopeCoordinates(rawInput);
    const parsed = displayCaptureInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return readErrorResult(
        "jetkvm_display_capture",
        context,
        0,
        coordinates,
        {
          code: "CONFIG_INVALID",
          phase: "validate",
          safeToRetry: false,
          requiredNextStep: "none",
          downstreamStage: "none",
        },
      );
    }
    const input: DisplayCaptureInput = parsed.data;
    const scope = createHandlerDeadline(
      input.timeout_ms,
      context.signal,
      dependencies.clock,
    );
    const ref: SessionRef = {
      sessionId: input.session_id,
      sessionGeneration: input.session_generation,
    };
    const resolved = resolveReadSession(dependencies, context, ref);
    if (isReadFailure(resolved)) {
      return readErrorResult(
        "jetkvm_display_capture",
        context,
        scope.durationMs(),
        coordinates,
        {
          ...resolved,
          expectedGeneration:
            resolved.code === "STALE_SESSION_GENERATION"
              ? input.session_generation
              : null,
          actualGeneration: null,
        },
      );
    }
    const authorization = authorizeRead(
      resolved,
      "display.capture",
      "display_capture",
    );
    if (authorization !== null) {
      return readErrorResult(
        "jetkvm_display_capture",
        context,
        scope.durationMs(),
        coordinates,
        authorization,
      );
    }
    const preflight = preflightReadFailure(scope);
    if (preflight !== null) {
      return readErrorResult(
        "jetkvm_display_capture",
        context,
        scope.durationMs(),
        coordinates,
        preflight,
      );
    }
    try {
      const artifact = await dependencies.browser.capture(
        ref,
        {
          format: input.format ?? "jpeg",
          maxWidth: input.max_width ?? 1280,
          maxHeight: input.max_height ?? 720,
        },
        scope.remaining(),
      );
      const result = mapDisplayCaptureArtifact(artifact);
      if (
        context.principalId === null ||
        !dependencies.sessions.acknowledgeCurrentCapture(context.principalId, {
          ref,
          connectionEpoch: result.connection_epoch,
          displayGeneration: result.display_generation,
        })
      ) {
        return readErrorResult(
          "jetkvm_display_capture",
          context,
          scope.durationMs(),
          coordinates,
          {
            code: "DISPLAY_CHANGED",
            phase: "verify",
            safeToRetry: true,
            requiredNextStep: "capture_then_retry",
            downstreamStage: "verification",
          },
        );
      }
      const envelope: Success<typeof result> = {
        ok: true,
        tool: "jetkvm_display_capture",
        operation_id: context.correlationId,
        session_id: input.session_id,
        session_generation: input.session_generation,
        duration_ms: scope.durationMs(),
        result,
      };
      return toMcpSuccessResult(envelope, {
        bytes: artifact.image.bytes,
        mime_type: artifact.image.mimeType,
      });
    } catch (error) {
      return readErrorResult(
        "jetkvm_display_capture",
        context,
        scope.durationMs(),
        coordinates,
        readPlaneFailure("jetkvm_display_capture", error),
      );
    }
  };
}

export function createDisplayStatusHandler(
  dependencies: DisplayHandlerDependencies,
): JetKvmToolHandler {
  return async (rawInput, context) => {
    const coordinates = envelopeCoordinates(rawInput);
    const parsed = displayStatusInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return readErrorResult("jetkvm_display_status", context, 0, coordinates, {
        code: "CONFIG_INVALID",
        phase: "validate",
        safeToRetry: false,
        requiredNextStep: "none",
        downstreamStage: "none",
      });
    }
    const input: DisplayStatusInput = parsed.data;
    const scope = createHandlerDeadline(
      input.timeout_ms,
      context.signal,
      dependencies.clock,
    );
    const ref: SessionRef = {
      sessionId: input.session_id,
      sessionGeneration: input.session_generation,
    };
    const resolved = resolveReadSession(dependencies, context, ref);
    if (isReadFailure(resolved)) {
      return readErrorResult(
        "jetkvm_display_status",
        context,
        scope.durationMs(),
        coordinates,
        {
          ...resolved,
          expectedGeneration:
            resolved.code === "STALE_SESSION_GENERATION"
              ? input.session_generation
              : null,
          actualGeneration: null,
        },
      );
    }
    const authorization = authorizeRead(
      resolved,
      "display.status",
      "display_status",
    );
    if (authorization !== null) {
      return readErrorResult(
        "jetkvm_display_status",
        context,
        scope.durationMs(),
        coordinates,
        authorization,
      );
    }
    const preflight = preflightReadFailure(scope);
    if (preflight !== null) {
      return readErrorResult(
        "jetkvm_display_status",
        context,
        scope.durationMs(),
        coordinates,
        preflight,
      );
    }
    try {
      const status = await dependencies.native.displayStatus(
        ref,
        { edidReadSupported: resolved.capabilities.edid_read },
        scope.remaining(),
      );
      const result: DisplayStatusResult = {
        signal: observedFact(status.signal, "unknown"),
        native_resolution: observedResolution(status.resolution),
        fps: observedFact(status.fps, null),
        edid: edidResult(status.edid),
      };
      const envelope: Success<DisplayStatusResult> = {
        ok: true,
        tool: "jetkvm_display_status",
        operation_id: context.correlationId,
        session_id: input.session_id,
        session_generation: input.session_generation,
        duration_ms: scope.durationMs(),
        result,
      };
      return toMcpSuccessResult(envelope);
    } catch (error) {
      return readErrorResult(
        "jetkvm_display_status",
        context,
        scope.durationMs(),
        coordinates,
        readPlaneFailure("jetkvm_display_status", error),
      );
    }
  };
}

export function createDisplayHandlers(
  dependencies: DisplayHandlerDependencies,
): DisplayHandlerRegistry {
  if (dependencies.browser.deviceRpc !== dependencies.native.deviceRpc) {
    throw new Error(
      "Display handlers require one shared Browser-owned DeviceRpcAdapter.",
    );
  }
  return Object.freeze({
    jetkvm_display_capture: createDisplayCaptureHandler(dependencies),
    jetkvm_display_status: createDisplayStatusHandler(dependencies),
  });
}
