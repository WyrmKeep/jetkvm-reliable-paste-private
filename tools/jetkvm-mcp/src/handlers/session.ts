import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  CapabilityName,
  PermissionName,
  SessionConnectInput,
  SessionReconnectInput,
  SessionStatusResult,
  Success,
  ToolError,
} from "../domain.js";
import type { Deadline, SessionRef } from "../device/DeviceRpcAdapter.js";
import type { ErrorCode, ErrorPhase, RequiredNextStep } from "../errors.js";
import {
  PUBLIC_ERROR_MESSAGES,
  toMcpErrorResult,
  toMcpSuccessResult,
} from "../mcp/results.js";
import {
  sessionConnectInputSchema,
  sessionReconnectInputSchema,
  sessionStatusInputSchema,
} from "../mcp/schemas.js";
import type {
  HandlerRegistry,
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "../mcp/server.js";
import {
  DeviceSessionClientError,
  type DeviceSessionConnectSuccess,
  type DeviceSessionReconnectSuccess,
} from "../session/deviceSessionClient.js";
import { SessionServiceError } from "../session/SessionService.js";
import {
  createHandlerDeadline,
  defaultErrorDetails,
  type HandlerClock,
} from "./inputShared.js";

export interface SessionHandlerService {
  connect(
    principal: string,
    input: SessionConnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionConnectSuccess>;
  status(
    principal: string,
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<SessionStatusResult>;
  reconnect(
    principal: string,
    input: SessionReconnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionReconnectSuccess>;
}

export interface SessionHandlerDependencies {
  readonly service: SessionHandlerService;
  readonly clock?: HandlerClock;
}

export type SessionHandlerRegistry = Readonly<{
  jetkvm_session_connect: JetKvmToolHandler;
  jetkvm_session_status: JetKvmToolHandler;
  jetkvm_session_reconnect: JetKvmToolHandler;
}>;

type SessionTool = keyof SessionHandlerRegistry;

const REQUIRED_PERMISSION_BY_TOOL: Readonly<
  Record<SessionTool, PermissionName>
> = {
  jetkvm_session_connect: "session.connect",
  jetkvm_session_status: "session.status",
  jetkvm_session_reconnect: "session.reconnect",
};

const REQUIRED_CAPABILITY_BY_TOOL: Readonly<
  Partial<Record<SessionTool, CapabilityName>>
> = {
  jetkvm_session_status: "session_status",
};
type Coordinates = {
  readonly sessionId: string | null;
  readonly sessionGeneration: number | null;
};
type PublicFailure = {
  readonly code: ErrorCode;
  readonly phase: ErrorPhase;
  readonly outcome: "not_sent" | "unknown" | null;
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
  readonly downstreamStage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
};

const coordinateSchema = z
  .object({
    session_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional(),
    session_generation: z.number().int().nonnegative().optional(),
  })
  .passthrough();

function coordinates(rawInput: unknown): Coordinates {
  const parsed = coordinateSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { sessionId: null, sessionGeneration: null };
  }
  return {
    sessionId: parsed.data.session_id ?? null,
    sessionGeneration: parsed.data.session_generation ?? null,
  };
}

function failurePhase(code: ErrorCode): ErrorPhase {
  switch (code) {
    case "PERMISSION_DENIED":
    case "AUTH_FAILED":
    case "AUTH_EXPIRED":
    case "AUTH_RATE_LIMITED":
      return "authorize";
    case "CONTROL_BUSY":
      return "authorize";
    case "ADMISSION_CAPACITY_EXCEEDED":
      return "queue";
    case "SESSION_DRAINED":
    case "SESSION_TAKEN_OVER":
      return "execute";
    case "CANCELLED":
    case "DEADLINE_EXCEEDED":
      return "execute";
    case "CONNECTION_LOST":
    case "DEVICE_UNREACHABLE":
    case "UNSUPPORTED_UI_VERSION":
    case "FIRMWARE_INCOMPATIBLE":
    case "BROWSER_UNSUPPORTED":
      return "connect";
    case "DOWNSTREAM_MALFORMED_RESPONSE":
    case "MUTATION_OUTCOME_UNKNOWN":
      return "execute";
    default:
      return "validate";
  }
}

function knownFailure(
  error: unknown,
  read: boolean,
): PublicFailure {
  if (error instanceof DeviceSessionClientError) {
    return {
      code: error.code,
      phase:
        error.code === "AUTH_FAILED" ||
        error.code === "AUTH_EXPIRED" ||
        error.code === "AUTH_RATE_LIMITED"
          ? "connect"
          : failurePhase(error.code),
      outcome: read ? null : error.outcome,
      safeToRetry: error.safeToRetry,
      requiredNextStep:
        error.code === "DEVICE_UNREACHABLE"
          ? "none"
          : error.requiredNextStep,
      downstreamStage:
        error.outcome === "unknown"
          ? "write"
          : error.code === "SESSION_NOT_FOUND" ||
              error.code === "STALE_SESSION_GENERATION" ||
              error.code === "CONTROL_BUSY" ||
              error.code === "DEVICE_UNREACHABLE" ||
              error.code === "AUTH_FAILED" ||
              error.code === "AUTH_EXPIRED" ||
              error.code === "AUTH_RATE_LIMITED" ||
              error.code === "UNSUPPORTED_UI_VERSION" ||
              error.code === "FIRMWARE_INCOMPATIBLE" ||
              error.code === "BROWSER_UNSUPPORTED"
            ? "admission"
            : error.code === "DOWNSTREAM_MALFORMED_RESPONSE"
              ? "write"
              : "none",
    };
  }
  if (error instanceof SessionServiceError) {
    const downstreamFailure =
      error.code === "CONNECTION_LOST" ||
      error.code === "DOWNSTREAM_MALFORMED_RESPONSE";
    return {
      code: error.code,
      phase: downstreamFailure ? "execute" : failurePhase(error.code),
      outcome: read ? null : "not_sent",
      safeToRetry: error.safeToRetry,
      requiredNextStep: error.requiredNextStep,
      downstreamStage: downstreamFailure ? "acknowledgement" : "none",
    };
  }
  return {
    code: "DOWNSTREAM_MALFORMED_RESPONSE",
    phase: read ? "verify" : "connect",
    outcome: read ? null : "unknown",
    safeToRetry: false,
    requiredNextStep: read ? "reconnect_then_capture" : "inspect_device_state_before_retry",
    downstreamStage: read ? "verification" : "acknowledgement",
  };
}

function errorResult(
  tool: SessionTool,
  context: JetKvmHandlerContext,
  durationMs: number,
  envelopeCoordinates: Coordinates,
  failure: PublicFailure,
): CallToolResult {
  const envelope: ToolError = {
    ok: false,
    tool,
    operation_id: context.correlationId,
    session_id: envelopeCoordinates.sessionId,
    session_generation: envelopeCoordinates.sessionGeneration,
    duration_ms: durationMs,
    error: {
      code: failure.code,
      message: PUBLIC_ERROR_MESSAGES[failure.code],
      phase: failure.phase,
      outcome: failure.outcome,
      verification: "none",
      safe_to_retry: failure.safeToRetry,
      required_next_step: failure.requiredNextStep,
      details: defaultErrorDetails({
        downstreamStage: failure.downstreamStage,
        permission:
          failure.code === "PERMISSION_DENIED"
            ? REQUIRED_PERMISSION_BY_TOOL[tool]
            : null,
        capability:
          failure.code === "CAPABILITY_MISSING"
            ? (REQUIRED_CAPABILITY_BY_TOOL[tool] ?? null)
            : null,
      }),
    },
  };
  return toMcpErrorResult(envelope);
}

function configFailure(): PublicFailure {
  return {
    code: "CONFIG_INVALID",
    phase: "validate",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  };
}

function authFailure(read: boolean): PublicFailure {
  return {
    code: "AUTH_FAILED",
    phase: "authorize",
    outcome: read ? null : "not_sent",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  };
}

function successResult<T>(
  tool: SessionTool,
  context: JetKvmHandlerContext,
  durationMs: number,
  ref: SessionRef,
  result: T,
): CallToolResult {
  const envelope: Success<T> = {
    ok: true,
    tool,
    operation_id: context.correlationId,
    session_id: ref.sessionId,
    session_generation: ref.sessionGeneration,
    duration_ms: durationMs,
    result,
  };
  return toMcpSuccessResult(envelope);
}

function createConnectHandler(
  dependencies: SessionHandlerDependencies,
): JetKvmToolHandler {
  return async (rawInput, context) => {
    const scope = createHandlerDeadline(60_000, context.signal, dependencies.clock);
    const parsed = sessionConnectInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return errorResult(
        "jetkvm_session_connect",
        context,
        scope.durationMs(),
        { sessionId: null, sessionGeneration: null },
        configFailure(),
      );
    }
    if (context.principalId === null) {
      return errorResult(
        "jetkvm_session_connect",
        context,
        scope.durationMs(),
        { sessionId: null, sessionGeneration: null },
        authFailure(false),
      );
    }
    try {
      const connected = await dependencies.service.connect(
        context.principalId,
        parsed.data,
        context.signal,
      );
      return successResult(
        "jetkvm_session_connect",
        context,
        scope.durationMs(),
        connected.ref,
        connected.result,
      );
    } catch (error) {
      return errorResult(
        "jetkvm_session_connect",
        context,
        scope.durationMs(),
        { sessionId: null, sessionGeneration: null },
        knownFailure(error, false),
      );
    }
  };
}

function createStatusHandler(
  dependencies: SessionHandlerDependencies,
): JetKvmToolHandler {
  return async (rawInput, context) => {
    const envelopeCoordinates = coordinates(rawInput);
    const parsed = sessionStatusInputSchema.safeParse(rawInput);
    const timeoutMs = parsed.success ? parsed.data.timeout_ms : 30_000;
    const scope = createHandlerDeadline(timeoutMs, context.signal, dependencies.clock);
    if (!parsed.success) {
      const failure = configFailure();
      return errorResult(
        "jetkvm_session_status",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        { ...failure, outcome: null },
      );
    }
    if (context.principalId === null) {
      return errorResult(
        "jetkvm_session_status",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        authFailure(true),
      );
    }
    const ref: SessionRef = {
      sessionId: parsed.data.session_id,
      sessionGeneration: parsed.data.session_generation,
    };
    try {
      const result = await dependencies.service.status(
        context.principalId,
        ref,
        scope.remaining(),
      );
      return successResult(
        "jetkvm_session_status",
        context,
        scope.durationMs(),
        ref,
        result,
      );
    } catch (error) {
      return errorResult(
        "jetkvm_session_status",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        knownFailure(error, true),
      );
    }
  };
}

function createReconnectHandler(
  dependencies: SessionHandlerDependencies,
): JetKvmToolHandler {
  return async (rawInput, context) => {
    const envelopeCoordinates = coordinates(rawInput);
    const parsed = sessionReconnectInputSchema.safeParse(rawInput);
    const timeoutMs = parsed.success ? parsed.data.timeout_ms : 60_000;
    const scope = createHandlerDeadline(timeoutMs, context.signal, dependencies.clock);
    if (!parsed.success) {
      return errorResult(
        "jetkvm_session_reconnect",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        configFailure(),
      );
    }
    if (context.principalId === null) {
      return errorResult(
        "jetkvm_session_reconnect",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        authFailure(false),
      );
    }
    try {
      const reconnected = await dependencies.service.reconnect(
        context.principalId,
        parsed.data,
        context.signal,
      );
      return successResult(
        "jetkvm_session_reconnect",
        context,
        scope.durationMs(),
        reconnected.ref,
        reconnected.result,
      );
    } catch (error) {
      return errorResult(
        "jetkvm_session_reconnect",
        context,
        scope.durationMs(),
        envelopeCoordinates,
        knownFailure(error, false),
      );
    }
  };
}

export function createSessionHandlers(
  dependencies: SessionHandlerDependencies,
): SessionHandlerRegistry {
  return Object.freeze({
    jetkvm_session_connect: createConnectHandler(dependencies),
    jetkvm_session_status: createStatusHandler(dependencies),
    jetkvm_session_reconnect: createReconnectHandler(dependencies),
  });
}

