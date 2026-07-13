import type {
  CapabilityName,
  DisplayCaptureResult,
  PermissionName,
  ToolErrorDetails,
} from "../domain.js";
import {
  ERROR_CODES,
  REQUIRED_NEXT_STEPS,
  type ErrorCode,
  type RequiredNextStep,
} from "../errors.js";
import {
  assertBrowserCaptureArtifact,
  type BrowserCaptureArtifact,
} from "../planes/BrowserPlane.js";

export interface HandlerClock {
  now(): number;
}

export type HandlerDeadline = Readonly<{
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly signal: AbortSignal;
  remaining(): { readonly timeoutMs: number; readonly signal: AbortSignal };
  durationMs(): number;
}>;

export type SanitizedPlaneFailure = Readonly<{
  code: ErrorCode;
  outcome: "not_sent" | "unknown" | "applied";
  stage: "admission" | "write" | "acknowledgement" | "verification";
  writeBegan: boolean;
  acknowledged: boolean;
  dispatchedCount: number;
  completedCount: number;
  failedIndex: number | null;
  safeToRetry: boolean;
  requiredNextStep: RequiredNextStep;
}>;

const SYSTEM_CLOCK: HandlerClock = { now: () => performance.now() };
const PUBLIC_STAGE_BY_INTERNAL = {
  admission: "admission",
  queue: "admission",
  send: "write",
  write: "write",
  ack: "acknowledgement",
  acknowledgement: "acknowledgement",
  post_ack: "verification",
  persisted: "verification",
  verification: "verification",
} as const;
const DEVICE_RPC_ERROR_CODE = {
  INVALID_BINDING: "DOWNSTREAM_MALFORMED_RESPONSE",
  INVALID_DEADLINE: "DOWNSTREAM_MALFORMED_RESPONSE",
  INVALID_REQUEST: "DOWNSTREAM_MALFORMED_RESPONSE",
  STALE_BINDING: "CONNECTION_LOST",
  BINDING_REPLACED: "CONNECTION_LOST",
  CANCELLED: "CANCELLED",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  CONNECTION_LOST: "CONNECTION_LOST",
  WRITE_REJECTED: "CONNECTION_LOST",
  MALFORMED_RESPONSE: "DOWNSTREAM_MALFORMED_RESPONSE",
  DUPLICATE_RESPONSE: "DOWNSTREAM_MALFORMED_RESPONSE",
  DOWNSTREAM_ERROR: "DEVICE_UNREACHABLE",
  INCOMPATIBLE_DOWNSTREAM: "DOWNSTREAM_MALFORMED_RESPONSE",
} as const satisfies Record<string, ErrorCode>;

export function createHandlerDeadline(
  timeoutMs: number,
  signal: AbortSignal,
  clock: HandlerClock = SYSTEM_CLOCK,
): HandlerDeadline {
  const startedAtMs = clock.now();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Handler clock must return a finite value.");
  }
  const expiresAtMs = startedAtMs + timeoutMs;
  return {
    startedAtMs,
    expiresAtMs,
    signal,
    remaining: () => ({
      timeoutMs: Math.max(0, Math.ceil(expiresAtMs - clock.now())),
      signal,
    }),
    durationMs: () =>
      Math.max(0, Math.ceil(Math.max(startedAtMs, clock.now()) - startedAtMs)),
  };
}

export function defaultErrorDetails(
  options: {
    permission?: PermissionName | null | undefined;
    capability?: CapabilityName | null | undefined;
    failedActionIndex?: number | null | undefined;
    dispatchedActionCount?: number | null | undefined;
    completedActionCount?: number | null | undefined;
    downstreamStage?: ToolErrorDetails["downstream_stage"] | undefined;
    expectedGeneration?: number | null | undefined;
    actualGeneration?: number | null | undefined;
    observationId?: string | null | undefined;
  } = {},
): ToolErrorDetails {
  return {
    permission: options.permission ?? null,
    capability: options.capability ?? null,
    failed_action_index: options.failedActionIndex ?? null,
    dispatched_action_count: options.dispatchedActionCount ?? null,
    completed_action_count: options.completedActionCount ?? null,
    downstream_stage: options.downstreamStage ?? "none",
    expected_generation: options.expectedGeneration ?? null,
    actual_generation: options.actualGeneration ?? null,
    observation_id: options.observationId ?? null,
  };
}

function nonNegativeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function mappedErrorCode(value: unknown): ErrorCode | null {
  if (
    typeof value === "string" &&
    ERROR_CODES.some((candidate) => candidate === value)
  ) {
    return value as ErrorCode;
  }
  if (
    typeof value === "string" &&
    Object.hasOwn(DEVICE_RPC_ERROR_CODE, value)
  ) {
    return DEVICE_RPC_ERROR_CODE[value as keyof typeof DEVICE_RPC_ERROR_CODE];
  }
  return null;
}

export function sanitizePlaneFailure(
  error: unknown,
): SanitizedPlaneFailure | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null;
  }
  const candidate = error as Record<string, unknown>;
  const code = mappedErrorCode(candidate.code);
  const outcome = candidate.outcome;
  const internalStage =
    typeof candidate.stage === "string"
      ? candidate.stage
      : typeof candidate.boundary === "string"
        ? candidate.boundary
        : null;
  const stage =
    internalStage !== null &&
    Object.hasOwn(PUBLIC_STAGE_BY_INTERNAL, internalStage)
      ? PUBLIC_STAGE_BY_INTERNAL[
          internalStage as keyof typeof PUBLIC_STAGE_BY_INTERNAL
        ]
      : null;
  const requiredNextStep = candidate.requiredNextStep;
  const dispatchedCount = nonNegativeCount(candidate.dispatchedCount) ?? 0;
  const completedCount = nonNegativeCount(candidate.completedCount) ?? 0;
  const failedIndex = nonNegativeCount(candidate.failedIndex);
  if (
    code === null ||
    (outcome !== "not_sent" &&
      outcome !== "unknown" &&
      outcome !== "applied") ||
    stage === null ||
    completedCount > dispatchedCount
  ) {
    return null;
  }
  const writeBegan = candidate.writeBegan === true;
  const acknowledged = candidate.acknowledged === true;
  const safeToRetry =
    typeof candidate.safeToRetry === "boolean"
      ? candidate.safeToRetry
      : outcome === "not_sent";
  const canonicalNextStep =
    typeof requiredNextStep === "string" &&
    REQUIRED_NEXT_STEPS.some((candidate) => candidate === requiredNextStep)
      ? (requiredNextStep as RequiredNextStep)
      : outcome === "unknown"
        ? "inspect_device_state_before_retry"
        : "none";
  return {
    code,
    outcome,
    stage,
    writeBegan,
    acknowledged,
    dispatchedCount,
    completedCount,
    failedIndex,
    safeToRetry,
    requiredNextStep: canonicalNextStep,
  };
}

export function mapDisplayCaptureArtifact(
  artifact: BrowserCaptureArtifact,
): DisplayCaptureResult {
  assertBrowserCaptureArtifact(artifact);
  const { observation } = artifact;
  return {
    observation_id: observation.observationId,
    connection_epoch: observation.connectionEpoch,
    display_generation: observation.displayGeneration,
    frame_id: observation.frameId,
    captured_at: observation.capturedAt,
    source_width: observation.sourceWidth,
    source_height: observation.sourceHeight,
    image_width: observation.imageWidth,
    image_height: observation.imageHeight,
    rotation: observation.rotation,
    geometry: {
      content_x: observation.geometry.contentX,
      content_y: observation.geometry.contentY,
      content_width: observation.geometry.contentWidth,
      content_height: observation.geometry.contentHeight,
    },
    image: {
      content_index: 1,
      mime_type: artifact.image.mimeType,
      sha256: observation.sha256,
      byte_length: observation.byteLength,
    },
  };
}
