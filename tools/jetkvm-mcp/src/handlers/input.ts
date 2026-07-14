import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  PHYSICAL_KEYS,
  type CapabilityName,
  type DefinitiveMutationState,
  type DisplayCaptureResult,
  type InputKeyboardInput,
  type InputKeyboardResult,
  type InputMouseInput,
  type InputMouseResult,
  type InputPasteInput,
  type InputPasteResult,
  type InputReleaseInput,
  type InputReleaseResult,
  type PermissionName,
  type PhysicalKey,
  type Success,
  type ToolError,
} from "../domain.js";
import type { SessionRef } from "../device/DeviceRpcAdapter.js";
import type { ErrorCode, ErrorPhase, RequiredNextStep } from "../errors.js";
import type {
  LedgerAcquireDecision,
  LedgerReservation,
  LedgerTerminal,
  RequestLedger,
} from "../idempotency/RequestLedger.js";
import {
  PUBLIC_ERROR_MESSAGES,
  toMcpErrorResult,
  toMcpSuccessResult,
} from "../mcp/results.js";
import {
  inputKeyboardInputSchema,
  inputMouseInputSchema,
  inputPasteInputSchema,
  inputReleaseInputSchema,
} from "../mcp/schemas.js";
import type {
  HandlerRegistry,
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "../mcp/server.js";
import type {
  BrowserCaptureArtifact,
  BrowserPlane,
  MutationReceipt,
  PasteReceipt,
  ReleaseReceipt,
} from "../planes/BrowserPlane.js";
import {
  DeviceSessionClientError,
  type DeviceSessionClient,
  type DeviceSessionSnapshot,
} from "../session/deviceSessionClient.js";
import {
  createHandlerDeadline,
  defaultErrorDetails,
  mapDisplayCaptureArtifact,
  sanitizePlaneFailure,
  type HandlerClock,
  type HandlerDeadline,
  type SanitizedPlaneFailure,
} from "./inputShared.js";

export interface InputHandlerDependencies {
  readonly browser: BrowserPlane;
  readonly sessions: DeviceSessionClient;
  readonly requestLedger: RequestLedger;
  readonly clock?: HandlerClock;
}

export type InputHandlerRegistry = Pick<
  HandlerRegistry,
  | "jetkvm_input_keyboard"
  | "jetkvm_input_mouse"
  | "jetkvm_input_paste"
  | "jetkvm_input_release"
>;

type InputTool =
  | "jetkvm_input_keyboard"
  | "jetkvm_input_mouse"
  | "jetkvm_input_paste"
  | "jetkvm_input_release";
type ParsedInput =
  | InputKeyboardInput
  | InputMouseInput
  | InputPasteInput
  | InputReleaseInput;
type InputResult =
  | InputKeyboardResult
  | InputMouseResult
  | InputPasteResult
  | InputReleaseResult;
type CachedMutationValue =
  | Readonly<{ kind: "success"; result: InputResult }>
  | Readonly<{ kind: "error"; error: ToolError["error"] }>;
interface KeyboardMutationReceipt extends MutationReceipt {
  readonly heldKeys: readonly PhysicalKey[];
}
type MutationFailure = Readonly<{
  code: ErrorCode;
  phase: ErrorPhase;
  outcome: "not_sent" | "unknown" | "applied" | "already_applied";
  verification: "none" | "device_ack_only";
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
  failedActionIndex?: number | null;
  dispatchedActionCount?: number | null;
  completedActionCount?: number | null;
  expectedGeneration?: number | null;
  actualGeneration?: number | null;
  observationId?: string | null;
}>;

interface EnvelopeCoordinates {
  readonly sessionId: string | null;
  readonly sessionGeneration: number | null;
  readonly observationId: string | null;
}

const INPUT_ERROR_CODES_BY_TOOL: Readonly<
  Record<InputTool, readonly ErrorCode[]>
> = {
  jetkvm_input_keyboard: [
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
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "ADMISSION_CAPACITY_EXCEEDED",
    "MUTATION_OUTCOME_UNKNOWN",
    "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    "STALE_OBSERVATION",
    "OBSERVATION_CONSUMED",
    "DISPLAY_CHANGED",
    "VIDEO_UNAVAILABLE",
    "VIDEO_STALLED",
    "INVALID_KEY",
    "PARTIAL_VERIFICATION",
  ],
  jetkvm_input_mouse: [
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
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "ADMISSION_CAPACITY_EXCEEDED",
    "MUTATION_OUTCOME_UNKNOWN",
    "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    "STALE_OBSERVATION",
    "OBSERVATION_CONSUMED",
    "DISPLAY_CHANGED",
    "VIDEO_UNAVAILABLE",
    "VIDEO_STALLED",
    "INVALID_COORDINATE",
    "UNSUPPORTED_SCROLL_AXIS",
    "PARTIAL_VERIFICATION",
  ],
  jetkvm_input_paste: [
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
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "ADMISSION_CAPACITY_EXCEEDED",
    "MUTATION_OUTCOME_UNKNOWN",
    "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    "STALE_OBSERVATION",
    "OBSERVATION_CONSUMED",
    "DISPLAY_CHANGED",
    "VIDEO_UNAVAILABLE",
    "VIDEO_STALLED",
    "PASTE_BUSY",
    "PASTE_REJECTED",
    "PASTE_FAILED",
    "PASTE_CANCELLED",
    "EVENT_GAP",
    "PARTIAL_VERIFICATION",
  ],
  jetkvm_input_release: [
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
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "ADMISSION_CAPACITY_EXCEEDED",
    "MUTATION_OUTCOME_UNKNOWN",
    "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
  ],
};
const PERMISSION_BY_TOOL: Readonly<Record<InputTool, PermissionName>> = {
  jetkvm_input_keyboard: "input.keyboard",
  jetkvm_input_mouse: "input.mouse",
  jetkvm_input_paste: "input.paste",
  jetkvm_input_release: "input.release",
};
const CAPABILITIES_BY_TOOL: Readonly<
  Record<InputTool, readonly CapabilityName[]>
> = {
  jetkvm_input_keyboard: ["keyboard"],
  jetkvm_input_mouse: ["mouse", "absolute_pointer"],
  jetkvm_input_paste: ["reliable_paste"],
  jetkvm_input_release: ["input_release"],
};

const BASE_RECEIPT_KEYS = [
  "acknowledgedAt",
  "completedCount",
  "dispatchedCount",
  "outcome",
  "requestId",
  "verification",
] as const;
const RECEIPT_KEYS_BY_TOOL: Readonly<Record<InputTool, readonly string[]>> = {
  jetkvm_input_mouse: BASE_RECEIPT_KEYS,
  jetkvm_input_keyboard: [...BASE_RECEIPT_KEYS, "heldKeys"].sort(),
  jetkvm_input_paste: [
    ...BASE_RECEIPT_KEYS,
    "acceptedAt",
    "completedAt",
    "measuredCharsPerSecond",
    "normalizedByteCount",
    "normalizedSha256",
    "originalByteCount",
    "terminalState",
  ].sort(),
  jetkvm_input_release: [
    ...BASE_RECEIPT_KEYS,
    "deferredProducersJoined",
    "generationDrained",
    "heldKeys",
    "keyboardZero",
    "mutationGateClosed",
    "ordinaryLeasesZero",
    "pasteTerminal",
    "pointerZero",
  ].sort(),
};

const CLOSED_GENERATION_BY_SESSION_CLIENT = new WeakMap<
  DeviceSessionClient,
  Map<string, number>
>();

function isInputGenerationClosed(
  sessions: DeviceSessionClient,
  input: ParsedInput,
): boolean {
  return (
    CLOSED_GENERATION_BY_SESSION_CLIENT.get(sessions)?.get(input.session_id) ===
    input.session_generation
  );
}

function closeInputGeneration(
  sessions: DeviceSessionClient,
  principal: string,
  input: ParsedInput,
): void {
  let generations = CLOSED_GENERATION_BY_SESSION_CLIENT.get(sessions);
  if (generations === undefined) {
    generations = new Map<string, number>();
    CLOSED_GENERATION_BY_SESSION_CLIENT.set(sessions, generations);
  }
  generations.set(input.session_id, input.session_generation);
  sessions.markGenerationDrained(principal, {
    sessionId: input.session_id,
    sessionGeneration: input.session_generation,
  });
}

function closedGenerationFailure(): MutationFailure {
  return {
    code: "SESSION_DRAINED",
    phase: "execute",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
    failedActionIndex: null,
    dispatchedActionCount: 0,
    completedActionCount: 0,
  };
}

function parsedInputFor(
  tool: InputTool,
  rawInput: unknown,
): { success: true; data: ParsedInput } | { success: false } {
  const parsed =
    tool === "jetkvm_input_keyboard"
      ? inputKeyboardInputSchema.safeParse(rawInput)
      : tool === "jetkvm_input_mouse"
        ? inputMouseInputSchema.safeParse(rawInput)
        : tool === "jetkvm_input_paste"
          ? inputPasteInputSchema.safeParse(rawInput)
          : inputReleaseInputSchema.safeParse(rawInput);
  return parsed.success
    ? { success: true, data: parsed.data as ParsedInput }
    : { success: false };
}

function envelopeCoordinates(rawInput: unknown): EnvelopeCoordinates {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    return { sessionId: null, sessionGeneration: null, observationId: null };
  }
  const candidate = rawInput as Record<string, unknown>;
  const canonicalId = (value: unknown): string | null =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
      ? value
      : null;
  return {
    sessionId: canonicalId(candidate.session_id),
    sessionGeneration:
      Number.isSafeInteger(candidate.session_generation) &&
      (candidate.session_generation as number) >= 0
        ? (candidate.session_generation as number)
        : null,
    observationId: canonicalId(candidate.observation_id),
  };
}

function mutationErrorEnvelope(
  tool: InputTool,
  context: JetKvmHandlerContext,
  durationMs: number,
  input: ParsedInput | null,
  coordinates: EnvelopeCoordinates,
  failure: MutationFailure,
): ToolError {
  return {
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
      outcome: failure.outcome,
      verification: failure.verification,
      safe_to_retry: failure.safeToRetry,
      required_next_step: failure.requiredNextStep,
      details: defaultErrorDetails({
        permission: failure.permission,
        capability: failure.capability,
        failedActionIndex: failure.failedActionIndex,
        dispatchedActionCount: failure.dispatchedActionCount,
        completedActionCount: failure.completedActionCount,
        downstreamStage: failure.downstreamStage,
        expectedGeneration: failure.expectedGeneration,
        actualGeneration: failure.actualGeneration,
        observationId:
          failure.observationId ??
          (input !== null && "observation_id" in input
            ? input.observation_id
            : coordinates.observationId),
      }),
    },
  };
}

function mutationErrorResult(
  tool: InputTool,
  context: JetKvmHandlerContext,
  durationMs: number,
  input: ParsedInput | null,
  coordinates: EnvelopeCoordinates,
  failure: MutationFailure,
): CallToolResult {
  return toMcpErrorResult(
    mutationErrorEnvelope(
      tool,
      context,
      durationMs,
      input,
      coordinates,
      failure,
    ),
  );
}

function resolveMutationSession(
  dependencies: InputHandlerDependencies,
  tool: InputTool,
  context: JetKvmHandlerContext,
  input: ParsedInput,
): DeviceSessionSnapshot | MutationFailure {
  if (context.principalId === null) {
    return {
      code: "AUTH_FAILED",
      phase: "connect",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "admission",
    };
  }
  try {
    return dependencies.sessions.resolveSession(
      context.principalId,
      {
        sessionId: input.session_id,
        sessionGeneration: input.session_generation,
      },
      { allowDrained: tool === "jetkvm_input_release" },
    );
  } catch (error) {
    if (error instanceof DeviceSessionClientError) {
      return {
        code: error.code,
        phase:
          error.code === "SESSION_TAKEN_OVER" ||
          error.code === "SESSION_DRAINED"
            ? "execute"
            : "validate",
        outcome: "not_sent",
        verification: "none",
        safeToRetry: error.safeToRetry,
        requiredNextStep: error.requiredNextStep,
        downstreamStage: "admission",
        expectedGeneration:
          error.code === "STALE_SESSION_GENERATION"
            ? input.session_generation
            : null,
        actualGeneration: null,
      };
    }
    return {
      code: "DOWNSTREAM_MALFORMED_RESPONSE",
      phase: "validate",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
      downstreamStage: "none",
    };
  }
}

function isMutationFailure(
  value: DeviceSessionSnapshot | MutationFailure,
): value is MutationFailure {
  return "code" in value;
}

function authorizeMutation(
  tool: InputTool,
  snapshot: DeviceSessionSnapshot,
  input: ParsedInput,
): MutationFailure | null {
  const permission = PERMISSION_BY_TOOL[tool];
  if (!snapshot.permissions.includes(permission)) {
    return {
      code: "PERMISSION_DENIED",
      phase: "authorize",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "grant_permission",
      downstreamStage: "none",
      permission,
      capability: null,
    };
  }
  for (const capability of CAPABILITIES_BY_TOOL[tool]) {
    if (!snapshot.capabilities[capability]) {
      return {
        code: "CAPABILITY_MISSING",
        phase: "validate",
        outcome: "not_sent",
        verification: "none",
        safeToRetry: false,
        requiredNextStep: "enable_capability",
        downstreamStage: "none",
        permission: null,
        capability,
      };
    }
  }
  if (tool !== "jetkvm_input_release" && snapshot.freshCaptureRequired) {
    return {
      code: "STALE_OBSERVATION",
      phase: "validate",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: true,
      requiredNextStep: "capture_then_retry",
      downstreamStage: "none",
      observationId: (input as InputMouseInput).observation_id,
    };
  }
  return null;
}

function preflightFailure(scope: HandlerDeadline): MutationFailure | null {
  if (scope.signal.aborted) {
    return {
      code: "CANCELLED",
      phase: "queue",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  if (scope.remaining().timeoutMs <= 0) {
    return {
      code: "DEADLINE_EXCEEDED",
      phase: "queue",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: true,
      requiredNextStep: "none",
      downstreamStage: "none",
    };
  }
  return null;
}

function requestedCount(tool: InputTool, input: ParsedInput): number {
  if (tool === "jetkvm_input_mouse" || tool === "jetkvm_input_keyboard") {
    return (input as InputMouseInput).actions.length;
  }
  if (tool === "jetkvm_input_paste") {
    const text = (input as InputPasteInput).text;
    const normalized = (text.startsWith("\uFEFF") ? text.slice(1) : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .normalize("NFC");
    return Buffer.byteLength(normalized, "utf8");
  }
  return 1;
}

function unknownCounts(
  tool: InputTool,
  input: ParsedInput,
  sanitized: SanitizedPlaneFailure | null,
): {
  failedActionIndex: number | null;
  dispatchedActionCount: number;
  completedActionCount: number;
} {
  const maximum = requestedCount(tool, input);
  if (tool === "jetkvm_input_mouse" || tool === "jetkvm_input_keyboard") {
    if (
      sanitized !== null &&
      sanitized.dispatchedCount === sanitized.completedCount + 1 &&
      sanitized.dispatchedCount <= maximum
    ) {
      return {
        failedActionIndex: sanitized.completedCount,
        dispatchedActionCount: sanitized.dispatchedCount,
        completedActionCount: sanitized.completedCount,
      };
    }
    return {
      failedActionIndex: 0,
      dispatchedActionCount: 1,
      completedActionCount: 0,
    };
  }
  if (tool === "jetkvm_input_paste") {
    const dispatched = Math.min(
      maximum,
      sanitized?.dispatchedCount ?? (maximum > 0 ? 1 : 0),
    );
    const completed = Math.min(dispatched, sanitized?.completedCount ?? 0);
    return {
      failedActionIndex:
        sanitized?.failedIndex !== null &&
        sanitized?.failedIndex !== undefined &&
        sanitized.failedIndex < maximum
          ? sanitized.failedIndex
          : completed < maximum
            ? completed
            : null,
      dispatchedActionCount: dispatched,
      completedActionCount: completed,
    };
  }
  return {
    failedActionIndex: null,
    dispatchedActionCount: sanitized?.dispatchedCount ?? 1,
    completedActionCount: sanitized?.completedCount ?? 0,
  };
}

function canonicalNotSentPolicy(code: ErrorCode): {
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
} {
  if (code === "CONNECTION_LOST" || code === "ATX_SERIAL_UNAVAILABLE") {
    return {
      safeToRetry: true,
      requiredNextStep:
        code === "CONNECTION_LOST" ? "reconnect_then_capture" : "none",
    };
  }
  if (code === "DOWNSTREAM_MALFORMED_RESPONSE") {
    return {
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    };
  }
  if (
    code === "STALE_OBSERVATION" ||
    code === "OBSERVATION_CONSUMED" ||
    code === "DISPLAY_CHANGED" ||
    code === "VIDEO_UNAVAILABLE" ||
    code === "VIDEO_STALLED"
  ) {
    return { safeToRetry: true, requiredNextStep: "capture_then_retry" };
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
  if (
    code === "CANCELLED" ||
    code === "DEADLINE_EXCEEDED" ||
    code === "DEVICE_UNREACHABLE" ||
    code === "PASTE_BUSY" ||
    code === "ADMISSION_CAPACITY_EXCEEDED"
  ) {
    return { safeToRetry: true, requiredNextStep: "none" };
  }
  return { safeToRetry: false, requiredNextStep: "none" };
}

function planeMutationFailure(
  tool: InputTool,
  input: ParsedInput,
  error: unknown,
): MutationFailure {
  const sanitized = sanitizePlaneFailure(error);
  const allowedCode =
    sanitized !== null &&
    INPUT_ERROR_CODES_BY_TOOL[tool].some((code) => code === sanitized.code)
      ? sanitized.code
      : "DOWNSTREAM_MALFORMED_RESPONSE";
  const inconsistentNotSent =
    sanitized?.outcome === "not_sent" && sanitized.writeBegan;
  const acknowledgedApplied =
    sanitized?.outcome === "applied" && sanitized.acknowledged;
  const outcome = acknowledgedApplied
    ? "applied"
    : sanitized?.outcome === "not_sent" && !inconsistentNotSent
      ? "not_sent"
      : "unknown";
  const code =
    outcome === "applied"
      ? "PARTIAL_VERIFICATION"
      : allowedCode === "PARTIAL_VERIFICATION"
        ? "MUTATION_OUTCOME_UNKNOWN"
        : allowedCode;
  const cleanup =
    outcome === "unknown" &&
    sanitized?.stage === "verification" &&
    !sanitized.acknowledged &&
    (sanitized.code === "MUTATION_OUTCOME_UNKNOWN" ||
      sanitized.requiredNextStep === "inspect_device_state_before_retry");
  const phase: ErrorPhase = cleanup
    ? "cleanup"
    : outcome === "applied"
      ? "verify"
      : outcome === "not_sent" &&
          (code === "CANCELLED" || code === "DEADLINE_EXCEEDED")
        ? "queue"
        : code === "STALE_OBSERVATION" ||
            code === "OBSERVATION_CONSUMED" ||
            (code === "DISPLAY_CHANGED" && outcome === "not_sent") ||
            code === "INVALID_COORDINATE" ||
            code === "INVALID_KEY" ||
            code === "UNSUPPORTED_SCROLL_AXIS"
          ? "validate"
          : code === "PASTE_BUSY"
            ? "queue"
            : "execute";
  const counts =
    outcome === "not_sent"
      ? {
          failedActionIndex: null,
          dispatchedActionCount: 0,
          completedActionCount: 0,
        }
      : outcome === "applied"
        ? {
            failedActionIndex: null,
            dispatchedActionCount: requestedCount(tool, input),
            completedActionCount: requestedCount(tool, input),
          }
        : unknownCounts(tool, input, sanitized);
  const notSentPolicy = canonicalNotSentPolicy(code);
  return {
    code,
    phase,
    outcome,
    verification: outcome === "applied" ? "device_ack_only" : "none",
    safeToRetry: outcome === "not_sent" ? notSentPolicy.safeToRetry : false,
    requiredNextStep:
      outcome === "applied"
        ? "none"
        : outcome === "unknown"
          ? code === "EVENT_GAP" ||
            code === "PASTE_FAILED" ||
            code === "PASTE_CANCELLED" ||
            code === "DISPLAY_CHANGED" ||
            code === "SESSION_TAKEN_OVER" ||
            code === "SESSION_DRAINED"
            ? "release_then_reconnect_then_capture"
            : "inspect_device_state_before_retry"
          : notSentPolicy.requiredNextStep,
    permission: code === "PERMISSION_DENIED" ? PERMISSION_BY_TOOL[tool] : null,
    capability:
      code === "CAPABILITY_MISSING" ? CAPABILITIES_BY_TOOL[tool][0]! : null,
    downstreamStage:
      sanitized?.stage ?? (outcome === "not_sent" ? "admission" : "write"),
    ...counts,
  };
}

function persistedFailureResult(
  dependencies: InputHandlerDependencies,
  reservation: LedgerReservation,
  tool: InputTool,
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: ParsedInput,
  coordinates: EnvelopeCoordinates,
  failure: MutationFailure,
): CallToolResult {
  const envelope = mutationErrorEnvelope(
    tool,
    context,
    scope.durationMs(),
    input,
    coordinates,
    failure,
  );
  const terminal: LedgerTerminal<CachedMutationValue> =
    failure.outcome === "applied" || failure.outcome === "already_applied"
      ? {
          outcome: "applied",
          verification: "device_ack_only",
          value: { kind: "error", error: envelope.error },
        }
      : {
          outcome: "unknown",
          verification: "none",
          value: { kind: "error", error: envelope.error },
        };
  return dependencies.requestLedger.completeBeforeResponse(
    reservation,
    terminal,
    () => toMcpErrorResult(envelope),
  );
}

function releaseNotSentReservation(
  dependencies: InputHandlerDependencies,
  reservation: LedgerReservation,
  tool: InputTool,
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: ParsedInput,
  coordinates: EnvelopeCoordinates,
  failure: MutationFailure,
): CallToolResult {
  if (dependencies.requestLedger.release(reservation, "not_sent")) {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      failure,
    );
  }
  return mutationErrorResult(
    tool,
    context,
    scope.durationMs(),
    input,
    coordinates,
    {
      ...unknownAdmissionFailure(tool, input, null),
      code: "MUTATION_OUTCOME_UNKNOWN",
    },
  );
}

function unknownAdmissionFailure(
  tool: InputTool,
  input: ParsedInput,
  cachedError: ToolError["error"] | null,
): MutationFailure {
  const counts = cachedError?.details ?? unknownCounts(tool, input, null);
  return {
    code: "MUTATION_OUTCOME_UNKNOWN",
    phase: cachedError?.phase ?? "execute",
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: cachedError?.details.downstream_stage ?? "write",
    failedActionIndex:
      "failed_action_index" in counts
        ? counts.failed_action_index
        : counts.failedActionIndex,
    dispatchedActionCount:
      "dispatched_action_count" in counts
        ? counts.dispatched_action_count
        : counts.dispatchedActionCount,
    completedActionCount:
      "completed_action_count" in counts
        ? counts.completed_action_count
        : counts.completedActionCount,
  };
}

function replayResult(
  tool: InputTool,
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: ParsedInput,
  coordinates: EnvelopeCoordinates,
  terminal: LedgerTerminal<CachedMutationValue>,
): CallToolResult {
  if (terminal.outcome !== "applied") {
    const cachedError =
      terminal.value.kind === "error" ? terminal.value.error : null;
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      unknownAdmissionFailure(tool, input, cachedError),
    );
  }
  if (terminal.value.kind === "error") {
    const envelope: ToolError = {
      ok: false,
      tool,
      operation_id: context.correlationId,
      session_id: input.session_id,
      session_generation: input.session_generation,
      duration_ms: scope.durationMs(),
      error: {
        ...terminal.value.error,
        outcome: "already_applied",
      },
    };
    return toMcpErrorResult(envelope);
  }
  const result = {
    ...terminal.value.result,
    outcome: "already_applied" as const,
    ...(tool === "jetkvm_input_release" ? {} : { post_capture: null }),
  } as InputResult;
  const envelope: Success<InputResult> = {
    ok: true,
    tool,
    operation_id: context.correlationId,
    session_id: input.session_id,
    session_generation: input.session_generation,
    duration_ms: scope.durationMs(),
    result,
  };
  return toMcpSuccessResult(envelope);
}

function acquireMutation(
  dependencies: InputHandlerDependencies,
  tool: InputTool,
  input: ParsedInput,
): LedgerAcquireDecision<CachedMutationValue> {
  return dependencies.requestLedger.acquire<CachedMutationValue>(
    {
      sessionId: input.session_id,
      sessionGeneration: input.session_generation,
      tool,
      requestId: input.request_id,
    },
    input,
  );
}

function validateMutationReceipt(
  tool: InputTool,
  input: ParsedInput,
  receipt: unknown,
): receipt is MutationReceipt {
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    Array.isArray(receipt)
  ) {
    return false;
  }
  const candidate = receipt as Partial<MutationReceipt>;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = RECEIPT_KEYS_BY_TOOL[tool];
  const validKeys =
    tool === "jetkvm_input_keyboard"
      ? keys.join(",") === BASE_RECEIPT_KEYS.join(",") ||
        keys.join(",") === expectedKeys.join(",")
      : keys.join(",") === expectedKeys.join(",");
  if (!validKeys) return false;
  const count = requestedCount(tool, input);
  return (
    candidate.requestId === input.request_id &&
    candidate.outcome === "applied" &&
    (candidate.verification === "device_ack_only" ||
      candidate.verification === "device_state_verified") &&
    candidate.dispatchedCount === count &&
    candidate.completedCount === count &&
    typeof candidate.acknowledgedAt === "string" &&
    candidate.acknowledgedAt.length > 0
  );
}

function heldKeysFromReceipt(
  receipt: MutationReceipt,
): KeyboardMutationReceipt["heldKeys"] | null {
  if (
    !Object.hasOwn(receipt, "heldKeys") ||
    !Object.prototype.propertyIsEnumerable.call(receipt, "heldKeys")
  ) {
    return null;
  }
  const heldKeys = Reflect.get(receipt, "heldKeys");
  if (!Array.isArray(heldKeys)) return null;
  let previousIndex = -1;
  for (const heldKey of heldKeys) {
    const index = PHYSICAL_KEYS.indexOf(heldKey as PhysicalKey);
    if (index <= previousIndex) return null;
    previousIndex = index;
  }
  return Object.freeze([...heldKeys] as PhysicalKey[]);
}

function definitiveState(
  input: ParsedInput,
  verification: DefinitiveMutationState["verification"],
): DefinitiveMutationState {
  return {
    request_id: input.request_id,
    outcome: "applied",
    verification,
    safe_to_retry: false,
    required_next_step: "none",
  };
}

function resultFromReceipt(
  tool: InputTool,
  input: ParsedInput,
  receipt: MutationReceipt | PasteReceipt | ReleaseReceipt,
  postCapture: DisplayCaptureResult | null,
): InputResult | null {
  if (!validateMutationReceipt(tool, input, receipt)) return null;
  if (tool === "jetkvm_input_mouse") {
    return {
      ...definitiveState(input, receipt.verification),
      dispatched_action_count: receipt.dispatchedCount,
      completed_action_count: receipt.completedCount,
      post_capture: postCapture,
    };
  }
  if (tool === "jetkvm_input_keyboard") {
    const heldKeys = heldKeysFromReceipt(receipt);
    if (heldKeys === null) return null;
    return {
      ...definitiveState(input, receipt.verification),
      dispatched_action_count: receipt.dispatchedCount,
      completed_action_count: receipt.completedCount,
      held_keys: [...heldKeys],
      post_capture: postCapture,
    };
  }
  if (tool === "jetkvm_input_paste") {
    const paste = receipt as PasteReceipt;
    if (
      paste.originalByteCount !==
        Buffer.byteLength((input as InputPasteInput).text, "utf8") ||
      paste.normalizedByteCount !== requestedCount(tool, input) ||
      paste.dispatchedCount !== paste.normalizedByteCount ||
      paste.completedCount !== paste.normalizedByteCount ||
      !/^[a-f0-9]{64}$/.test(paste.normalizedSha256) ||
      paste.acceptedAt === null ||
      paste.completedAt === null ||
      paste.terminalState !== "succeeded"
    ) {
      return null;
    }
    return {
      ...definitiveState(input, paste.verification),
      original_byte_count: paste.originalByteCount,
      normalized_byte_count: paste.normalizedByteCount,
      normalized_sha256: paste.normalizedSha256,
      accepted_at: paste.acceptedAt,
      completed_at: paste.completedAt,
      terminal_state: "succeeded",
      measured_chars_per_second: paste.measuredCharsPerSecond,
      post_capture: postCapture,
    };
  }
  const release = receipt as ReleaseReceipt;
  if (
    receipt.verification !== "device_state_verified" ||
    !release.mutationGateClosed ||
    !release.deferredProducersJoined ||
    (release.pasteTerminal !== "cancelled" &&
      release.pasteTerminal !== "inactive") ||
    release.ordinaryLeasesZero !== true ||
    release.keyboardZero !== true ||
    release.pointerZero !== true ||
    !release.generationDrained ||
    release.heldKeys.length !== 0
  ) {
    return null;
  }
  return {
    ...definitiveState(input, "device_state_verified"),
    verification: "device_state_verified",
    mutation_gate_closed: true,
    deferred_producers_joined: true,
    paste_terminal: release.pasteTerminal,
    ordinary_leases_zero: true,
    keyboard_zero: true,
    pointer_zero: true,
    generation_drained: true,
  };
}

async function callPlane(
  dependencies: InputHandlerDependencies,
  tool: InputTool,
  input: ParsedInput,
  ref: SessionRef,
  scope: HandlerDeadline,
): Promise<MutationReceipt | PasteReceipt | ReleaseReceipt> {
  const deadline = scope.remaining();
  if (tool === "jetkvm_input_mouse") {
    const mouse = input as InputMouseInput;
    return dependencies.browser.mouse(
      ref,
      {
        observationId: mouse.observation_id,
        requestId: mouse.request_id,
        actions: mouse.actions,
      },
      deadline,
    );
  }
  if (tool === "jetkvm_input_keyboard") {
    const keyboard = input as InputKeyboardInput;
    return dependencies.browser.keyboard(
      ref,
      {
        observationId: keyboard.observation_id,
        requestId: keyboard.request_id,
        actions: keyboard.actions,
      },
      deadline,
    );
  }
  if (tool === "jetkvm_input_paste") {
    const paste = input as InputPasteInput;
    return dependencies.browser.paste(
      ref,
      {
        observationId: paste.observation_id,
        requestId: paste.request_id,
        text: paste.text,
      },
      deadline,
    );
  }
  return dependencies.browser.release(
    ref,
    { requestId: input.request_id },
    deadline,
  );
}

async function postCapture(
  dependencies: InputHandlerDependencies,
  context: JetKvmHandlerContext,
  ref: SessionRef,
  scope: HandlerDeadline,
): Promise<BrowserCaptureArtifact> {
  const artifact = await dependencies.browser.capture(
    ref,
    { format: "jpeg", maxWidth: 1280, maxHeight: 720 },
    scope.remaining(),
  );
  const metadata = mapDisplayCaptureArtifact(artifact);
  if (
    context.principalId === null ||
    !dependencies.sessions.acknowledgeCurrentCapture(context.principalId, {
      ref,
      connectionEpoch: metadata.connection_epoch,
      displayGeneration: metadata.display_generation,
    })
  ) {
    throw new Error("Post-capture evidence is no longer current.");
  }
  return artifact;
}

function persistedSuccessResult(
  dependencies: InputHandlerDependencies,
  reservation: LedgerReservation,
  tool: InputTool,
  context: JetKvmHandlerContext,
  scope: HandlerDeadline,
  input: ParsedInput,
  result: InputResult,
  artifact: BrowserCaptureArtifact | null,
): CallToolResult {
  const cachedResult = {
    ...result,
    ...(tool === "jetkvm_input_release" ? {} : { post_capture: null }),
  } as InputResult;
  const terminal: LedgerTerminal<CachedMutationValue> = {
    outcome: "applied",
    verification: result.verification,
    value: { kind: "success", result: cachedResult },
  };
  return dependencies.requestLedger.completeBeforeResponse(
    reservation,
    terminal,
    () => {
      const envelope: Success<InputResult> = {
        ok: true,
        tool,
        operation_id: context.correlationId,
        session_id: input.session_id,
        session_generation: input.session_generation,
        duration_ms: scope.durationMs(),
        result,
      };
      return artifact === null
        ? toMcpSuccessResult(envelope)
        : toMcpSuccessResult(envelope, {
            bytes: artifact.image.bytes,
            mime_type: artifact.image.mimeType,
          });
    },
  );
}

async function executeInputMutation(
  dependencies: InputHandlerDependencies,
  tool: InputTool,
  rawInput: unknown,
  context: JetKvmHandlerContext,
): Promise<CallToolResult> {
  const coordinates = envelopeCoordinates(rawInput);
  const parsed = parsedInputFor(tool, rawInput);
  if (!parsed.success) {
    return mutationErrorResult(tool, context, 0, null, coordinates, {
      code: "CONFIG_INVALID",
      phase: "validate",
      outcome: "not_sent",
      verification: "none",
      safeToRetry: false,
      requiredNextStep: "none",
      downstreamStage: "none",
      failedActionIndex: null,
      dispatchedActionCount: 0,
      completedActionCount: 0,
    });
  }
  const input = parsed.data;
  const scope = createHandlerDeadline(
    input.timeout_ms,
    context.signal,
    dependencies.clock,
  );
  const resolved = resolveMutationSession(dependencies, tool, context, input);
  if (isMutationFailure(resolved)) {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      {
        ...resolved,
        failedActionIndex: null,
        dispatchedActionCount: 0,
        completedActionCount: 0,
      },
    );
  }
  const authorization = authorizeMutation(tool, resolved, input);
  if (authorization !== null) {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      {
        ...authorization,
        failedActionIndex: null,
        dispatchedActionCount: 0,
        completedActionCount: 0,
      },
    );
  }
  if (
    tool !== "jetkvm_input_release" &&
    isInputGenerationClosed(dependencies.sessions, input)
  ) {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      closedGenerationFailure(),
    );
  }
  const decision = acquireMutation(dependencies, tool, input);
  if (decision.kind === "replay") {
    return replayResult(
      tool,
      context,
      scope,
      input,
      coordinates,
      decision.terminal,
    );
  }
  if (decision.kind === "conflict") {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      {
        code: decision.code,
        phase: "validate",
        outcome: "not_sent",
        verification: "none",
        safeToRetry: false,
        requiredNextStep: "none",
        downstreamStage: "none",
        failedActionIndex: null,
        dispatchedActionCount: 0,
        completedActionCount: 0,
      },
    );
  }
  if (decision.kind === "capacity_exceeded") {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      {
        code: "ADMISSION_CAPACITY_EXCEEDED",
        phase: "queue",
        outcome: "not_sent",
        verification: "none",
        safeToRetry: true,
        requiredNextStep: "none",
        downstreamStage: "none",
        failedActionIndex: null,
        dispatchedActionCount: 0,
        completedActionCount: 0,
      },
    );
  }
  if (decision.kind !== "acquired") {
    return mutationErrorResult(
      tool,
      context,
      scope.durationMs(),
      input,
      coordinates,
      unknownAdmissionFailure(tool, input, null),
    );
  }
  const reservation = decision.reservation;
  if (isInputGenerationClosed(dependencies.sessions, input)) {
    return releaseNotSentReservation(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      closedGenerationFailure(),
    );
  }
  const preflight = preflightFailure(scope);
  if (preflight !== null) {
    return releaseNotSentReservation(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      preflight,
    );
  }
  const ref: SessionRef = {
    sessionId: input.session_id,
    sessionGeneration: input.session_generation,
  };
  let receipt: unknown;
  try {
    receipt = await callPlane(dependencies, tool, input, ref, scope);
  } catch (error) {
    const failure = planeMutationFailure(tool, input, error);
    if (tool === "jetkvm_input_release" && failure.outcome !== "not_sent") {
      closeInputGeneration(dependencies.sessions, context.principalId!, input);
    }
    return failure.outcome === "not_sent"
      ? releaseNotSentReservation(
          dependencies,
          reservation,
          tool,
          context,
          scope,
          input,
          coordinates,
          failure,
        )
      : persistedFailureResult(
          dependencies,
          reservation,
          tool,
          context,
          scope,
          input,
          coordinates,
          failure,
        );
  }
  if (tool === "jetkvm_input_release") {
    closeInputGeneration(dependencies.sessions, context.principalId!, input);
  }
  if (!validateMutationReceipt(tool, input, receipt)) {
    return persistedFailureResult(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      planeMutationFailure(tool, input, new Error("Malformed receipt")),
    );
  }
  if (
    tool === "jetkvm_input_keyboard" &&
    heldKeysFromReceipt(receipt) === null
  ) {
    const count = requestedCount(tool, input);
    return persistedFailureResult(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      {
        code: "PARTIAL_VERIFICATION",
        phase: "verify",
        outcome: "applied",
        verification: "device_ack_only",
        safeToRetry: false,
        requiredNextStep: "none",
        downstreamStage: "verification",
        failedActionIndex: null,
        dispatchedActionCount: count,
        completedActionCount: count,
      },
    );
  }
  if (tool === "jetkvm_input_release") {
    const result = resultFromReceipt(tool, input, receipt, null);
    if (result === null) {
      return persistedFailureResult(
        dependencies,
        reservation,
        tool,
        context,
        scope,
        input,
        coordinates,
        planeMutationFailure(tool, input, new Error("Malformed release")),
      );
    }
    return persistedSuccessResult(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      result,
      null,
    );
  }
  let artifact: BrowserCaptureArtifact;
  try {
    artifact = await postCapture(dependencies, context, ref, scope);
  } catch {
    const count = requestedCount(tool, input);
    return persistedFailureResult(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      {
        code: "PARTIAL_VERIFICATION",
        phase: "verify",
        outcome: "applied",
        verification: "device_ack_only",
        safeToRetry: false,
        requiredNextStep: "none",
        downstreamStage: "verification",
        failedActionIndex: null,
        dispatchedActionCount: count,
        completedActionCount: count,
      },
    );
  }
  const postCaptureResult = mapDisplayCaptureArtifact(artifact);
  const result = resultFromReceipt(tool, input, receipt, postCaptureResult);
  if (result === null) {
    return persistedFailureResult(
      dependencies,
      reservation,
      tool,
      context,
      scope,
      input,
      coordinates,
      planeMutationFailure(tool, input, new Error("Malformed receipt")),
    );
  }
  return persistedSuccessResult(
    dependencies,
    reservation,
    tool,
    context,
    scope,
    input,
    result,
    artifact,
  );
}

export function createInputKeyboardHandler(
  dependencies: InputHandlerDependencies,
): JetKvmToolHandler {
  return (input, context) =>
    executeInputMutation(dependencies, "jetkvm_input_keyboard", input, context);
}

export function createInputMouseHandler(
  dependencies: InputHandlerDependencies,
): JetKvmToolHandler {
  return (input, context) =>
    executeInputMutation(dependencies, "jetkvm_input_mouse", input, context);
}

export function createInputPasteHandler(
  dependencies: InputHandlerDependencies,
): JetKvmToolHandler {
  return (input, context) =>
    executeInputMutation(dependencies, "jetkvm_input_paste", input, context);
}

export function createInputReleaseHandler(
  dependencies: InputHandlerDependencies,
): JetKvmToolHandler {
  return (input, context) =>
    executeInputMutation(dependencies, "jetkvm_input_release", input, context);
}

export function createInputHandlers(
  dependencies: InputHandlerDependencies,
): InputHandlerRegistry {
  return Object.freeze({
    jetkvm_input_keyboard: createInputKeyboardHandler(dependencies),
    jetkvm_input_mouse: createInputMouseHandler(dependencies),
    jetkvm_input_paste: createInputPasteHandler(dependencies),
    jetkvm_input_release: createInputReleaseHandler(dependencies),
  });
}
