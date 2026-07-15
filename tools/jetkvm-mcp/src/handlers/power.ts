import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  PowerControlInput,
  PowerControlResult,
  Success,
  ToolError,
} from "../domain.js";
import type { ErrorCode, ErrorPhase, RequiredNextStep } from "../errors.js";
import type {
  LedgerReservation,
  LedgerTerminal,
  RequestLedger,
} from "../idempotency/RequestLedger.js";
import {
  PUBLIC_ERROR_MESSAGES,
  toMcpErrorResult,
  toMcpSuccessResult,
} from "../mcp/results.js";
import { powerControlInputSchema } from "../mcp/schemas.js";
import type {
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "../mcp/server.js";
import type { NativeControlPlane, PowerReceipt } from "../planes/NativeControlPlane.js";
import {
  DeviceSessionClientError,
  type DeviceSessionSnapshot,
} from "../session/deviceSessionClient.js";
import {
  canonicalMutationDownstreamStage,
  createHandlerDeadline,
  defaultErrorDetails,
  sanitizePlaneFailure,
  type HandlerClock,
  type HandlerDeadline,
} from "./inputShared.js";

const TOOL = "jetkvm_power_control" as const;

type CachedPowerValue =
  | Readonly<{ kind: "success"; result: PowerControlResult }>
  | Readonly<{ kind: "error"; error: ToolError["error"] }>;

export interface PowerSessionPort {
  resolveSession(
    principal: string,
    ref: { readonly sessionId: string; readonly sessionGeneration: number },
  ): DeviceSessionSnapshot;
}

export interface PowerHandlerDependencies {
  readonly native: NativeControlPlane;
  readonly sessions: PowerSessionPort;
  readonly requestLedger: RequestLedger;
  readonly clock?: HandlerClock;
}

export type PowerHandlerRegistry = Readonly<{
  jetkvm_power_control: JetKvmToolHandler;
}>;

type PowerFailure = Readonly<{
  code: ErrorCode;
  phase: ErrorPhase;
  outcome: "not_sent" | "unknown";
  safeToRetry: boolean;
  requiredNextStep: RequiredNextStep;
  downstreamStage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
  permission?: "power.control" | null;
  capability?: "power_control" | null;
}>;

function coordinates(raw: unknown): {
  readonly sessionId: string | null;
  readonly sessionGeneration: number | null;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { sessionId: null, sessionGeneration: null };
  }
  const value = raw as Record<string, unknown>;
  return {
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
    sessionGeneration:
      Number.isSafeInteger(value.session_generation) &&
      (value.session_generation as number) >= 0
        ? (value.session_generation as number)
        : null,
  };
}

function errorResult(
  context: JetKvmHandlerContext,
  durationMs: number,
  input: PowerControlInput | null,
  rawCoordinates: ReturnType<typeof coordinates>,
  failure: PowerFailure,
): CallToolResult {
  const envelope: ToolError = {
    ok: false,
    tool: TOOL,
    operation_id: context.correlationId,
    session_id: input?.session_id ?? rawCoordinates.sessionId,
    session_generation:
      input?.session_generation ?? rawCoordinates.sessionGeneration,
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
        permission: failure.permission ?? null,
        capability: failure.capability ?? null,
        downstreamStage: failure.downstreamStage,
        dispatchedActionCount: failure.outcome === "unknown" ? 1 : 0,
        completedActionCount: 0,
      }),
    },
  };
  return toMcpErrorResult(envelope);
}

function sessionFailure(error: unknown): PowerFailure {
  if (error instanceof DeviceSessionClientError) {
    const staleBinding =
      error.code === "SESSION_NOT_FOUND" ||
      error.code === "STALE_SESSION_GENERATION";
    return {
      code: error.code,
      phase: staleBinding ? "validate" : "authorize",
      outcome: error.outcome,
      safeToRetry: error.safeToRetry,
      requiredNextStep: error.requiredNextStep,
      downstreamStage:
        error.outcome === "unknown"
          ? "write"
          : staleBinding
            ? "admission"
            : "none",
    };
  }
  return {
    code: "DOWNSTREAM_MALFORMED_RESPONSE",
    phase: "authorize",
    outcome: "not_sent",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  };
}

function planeFailure(error: unknown): PowerFailure {
  const sanitized = sanitizePlaneFailure(error);
  if (sanitized === null) {
    return {
      code: "DOWNSTREAM_MALFORMED_RESPONSE",
      phase: "execute",
      outcome: "unknown",
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
      downstreamStage: "acknowledgement",
    };
  }
  if (sanitized.code === "ATX_EXTENSION_INACTIVE") {
    return {
      code: sanitized.code,
      phase: "validate",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  if (sanitized.code === "ATX_SERIAL_UNAVAILABLE") {
    return {
      code: sanitized.code,
      phase: "execute",
      outcome: sanitized.outcome === "unknown" ? "unknown" : "not_sent",
      safeToRetry: sanitized.outcome !== "unknown",
      requiredNextStep:
        sanitized.outcome === "unknown"
          ? "inspect_device_state_before_retry"
          : "none",
      downstreamStage: "write",
    };
  }
  return {
    code: sanitized.code,
    phase:
      sanitized.stage === "admission"
        ? "execute"
        : sanitized.stage === "verification"
          ? "verify"
          : "execute",
    outcome: sanitized.outcome === "not_sent" ? "not_sent" : "unknown",
    safeToRetry: sanitized.outcome === "not_sent" && sanitized.safeToRetry,
    requiredNextStep:
      sanitized.outcome === "unknown"
        ? "inspect_device_state_before_retry"
        : sanitized.code === "CONNECTION_LOST"
          ? "reconnect_then_capture"
          : sanitized.requiredNextStep,
    downstreamStage: canonicalMutationDownstreamStage(
      sanitized,
      sanitized.outcome === "not_sent" ? "not_sent" : "unknown",
    ),
  };
}

function assertReceiptMatches(
  receipt: PowerReceipt,
  input: PowerControlInput,
): void {
  const expected =
    input.action === "press_power"
      ? { wireAction: "power-short", fixedPressMs: 200 }
      : input.action === "hold_power"
        ? { wireAction: "power-long", fixedPressMs: 5000 }
        : { wireAction: "reset", fixedPressMs: 200 };
  if (
    receipt.requestId !== input.request_id ||
    receipt.action !== input.action ||
    receipt.wireAction !== expected.wireAction ||
    receipt.fixedPressMs !== expected.fixedPressMs ||
    receipt.serialSequenceCompleted !== true ||
    receipt.verification !== "device_ack_only"
  ) {
    throw new Error("ATX receipt does not match the admitted request.");
  }
}

function mapReceipt(
  receipt: PowerReceipt,
  outcome: "applied" | "already_applied" = "applied",
): PowerControlResult {
  const led =
    receipt.atxLedObservation.freshness === "unknown"
      ? {
          power: null,
          hdd: null,
          observed_at: null,
          freshness: "unknown" as const,
        }
      : {
          power: receipt.atxLedObservation.power,
          hdd: receipt.atxLedObservation.hdd,
          observed_at: receipt.atxLedObservation.observedAt,
          freshness: receipt.atxLedObservation.freshness,
        };
  return {
    request_id: receipt.requestId,
    outcome,
    verification: "device_ack_only",
    safe_to_retry: false,
    required_next_step: "none",
    action: receipt.action,
    wire_action: receipt.wireAction,
    fixed_press_ms: receipt.fixedPressMs,
    serial_sequence_completed: true,
    atx_led_observation: led,
  } as PowerControlResult;
}

function successResult(
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: PowerControlInput,
  result: PowerControlResult,
): CallToolResult {
  const envelope: Success<PowerControlResult> = {
    ok: true,
    tool: TOOL,
    operation_id: context.correlationId,
    session_id: input.session_id,
    session_generation: input.session_generation,
    duration_ms: scope.durationMs(),
    result,
  };
  return toMcpSuccessResult(envelope);
}

function replayResult(
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: PowerControlInput,
  terminal: LedgerTerminal<CachedPowerValue>,
): CallToolResult {
  if (terminal.value.kind === "success") {
    return successResult(
      context,
      scope,
      input,
      { ...terminal.value.result, outcome: "already_applied" },
    );
  }
  return toMcpErrorResult({
    ok: false,
    tool: TOOL,
    operation_id: context.correlationId,
    session_id: input.session_id,
    session_generation: input.session_generation,
    duration_ms: scope.durationMs(),
    error: terminal.value.error,
  });
}

function persistUnknown(
  dependencies: PowerHandlerDependencies,
  reservation: LedgerReservation,
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: PowerControlInput,
  rawCoordinates: ReturnType<typeof coordinates>,
  failure: PowerFailure,
): CallToolResult {
  const response = errorResult(
    context,
    scope.durationMs(),
    input,
    rawCoordinates,
    failure,
  );
  const structured = response.structuredContent as ToolError;
  return dependencies.requestLedger.completeBeforeResponse(
    reservation,
    {
      outcome: "unknown",
      verification: "none",
      value: { kind: "error", error: structured.error } satisfies CachedPowerValue,
    },
    () => response,
  );
}

async function executePowerControl(
  dependencies: PowerHandlerDependencies,
  rawInput: unknown,
  context: JetKvmHandlerContext,
): Promise<CallToolResult> {
  const rawCoordinates = coordinates(rawInput);
  const parsed = powerControlInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult(context, 0, null, rawCoordinates, {
      code: "CONFIG_INVALID",
      phase: "validate",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "none",
    });
  }
  const input = parsed.data;
  const scope = createHandlerDeadline(
    input.timeout_ms,
    context.signal,
    dependencies.clock,
  );
  if (context.principalId === null) {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "AUTH_FAILED",
      phase: "connect",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "admission",
    });
  }

  let session: DeviceSessionSnapshot;
  try {
    session = dependencies.sessions.resolveSession(context.principalId, {
      sessionId: input.session_id,
      sessionGeneration: input.session_generation,
    });
  } catch (error) {
    return errorResult(
      context,
      scope.durationMs(),
      input,
      rawCoordinates,
      sessionFailure(error),
    );
  }
  if (!session.permissions.includes("power.control")) {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "PERMISSION_DENIED",
      phase: "authorize",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "grant_permission",
      downstreamStage: "none",
      permission: "power.control",
    });
  }
  if (!session.capabilities.power_control) {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "CAPABILITY_MISSING",
      phase: "validate",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "enable_capability",
      downstreamStage: "none",
      capability: "power_control",
    });
  }

  const decision = dependencies.requestLedger.acquire<CachedPowerValue>(
    {
      sessionId: input.session_id,
      sessionGeneration: input.session_generation,
      tool: TOOL,
      requestId: input.request_id,
    },
    input,
  );
  if (decision.kind === "replay") {
    return replayResult(context, scope, input, decision.terminal);
  }
  if (decision.kind === "conflict") {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: decision.code,
      phase: "validate",
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "none",
    });
  }
  if (decision.kind === "in_flight") {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "ATX_BUSY",
      phase: "queue",
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    });
  }
  if (decision.kind === "capacity_exceeded") {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "ADMISSION_CAPACITY_EXCEEDED",
      phase: "queue",
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    });
  }
  if (decision.kind === "cache_lost") {
    return errorResult(context, scope.durationMs(), input, rawCoordinates, {
      code: "MUTATION_OUTCOME_UNKNOWN",
      phase: "execute",
      outcome: "unknown",
      safeToRetry: false,
      requiredNextStep: "inspect_device_state_before_retry",
      downstreamStage: "acknowledgement",
    });
  }

  const reservation = decision.reservation;
  const remaining = scope.remaining();
  const admissionFailure =
    context.signal.aborted
      ? ({
          code: "CANCELLED",
          phase: "queue",
          outcome: "not_sent",
          safeToRetry: true,
          requiredNextStep: "none",
          downstreamStage: "none",
        } satisfies PowerFailure)
      : remaining.timeoutMs === 0
        ? ({
            code: "DEADLINE_EXCEEDED",
            phase: "queue",
            outcome: "not_sent",
            safeToRetry: true,
            requiredNextStep: "none",
            downstreamStage: "none",
          } satisfies PowerFailure)
        : null;
  if (admissionFailure !== null) {
    dependencies.requestLedger.release(reservation, "not_sent");
    return errorResult(
      context,
      scope.durationMs(),
      input,
      rawCoordinates,
      admissionFailure,
    );
  }

  try {
    const receipt = await dependencies.native.powerControl(
      session.ref,
      { requestId: input.request_id, action: input.action },
      remaining,
    );
    assertReceiptMatches(receipt, input);
    const result = mapReceipt(receipt);
    return dependencies.requestLedger.completeBeforeResponse(
      reservation,
      {
        outcome: "applied",
        verification: "device_ack_only",
        value: { kind: "success", result } satisfies CachedPowerValue,
      },
      () => successResult(context, scope, input, result),
    );
  } catch (error) {
    const failure = planeFailure(error);
    if (failure.outcome === "not_sent") {
      dependencies.requestLedger.release(reservation, "not_sent");
      return errorResult(
        context,
        scope.durationMs(),
        input,
        rawCoordinates,
        failure,
      );
    }
    return persistUnknown(
      dependencies,
      reservation,
      context,
      scope,
      input,
      rawCoordinates,
      failure,
    );
  }
}

export function createPowerControlHandler(
  dependencies: PowerHandlerDependencies,
): JetKvmToolHandler {
  return (input, context) => executePowerControl(dependencies, input, context);
}

export function createPowerHandlers(
  dependencies: PowerHandlerDependencies,
): PowerHandlerRegistry {
  return Object.freeze({
    jetkvm_power_control: createPowerControlHandler(dependencies),
  });
}
