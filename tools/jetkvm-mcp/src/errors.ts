import type { FailureEnvelope, MutationOutcome } from "./domain.js";

export const ERROR_CODES = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "AUTH_RATE_LIMITED",
  "AUTH_EXPIRED",
  "UNSUPPORTED_UI_VERSION",
  "FIRMWARE_INCOMPATIBLE",
  "BROWSER_UNSUPPORTED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "SESSION_TAKEN_OVER",
  "CONTROL_BUSY",
  "VIDEO_UNAVAILABLE",
  "VIDEO_STALLED",
  "FRAME_TIMEOUT",
  "STALE_VIEW",
  "VIEW_CONSUMED",
  "DISPLAY_CHANGED",
  "INVALID_COORDINATE",
  "INVALID_KEY",
  "UNSUPPORTED_CHARACTER",
  "UNSUPPORTED_SCROLL_AXIS",
  "USE_PASTE_TEXT",
  "INPUT_RELEASE_UNKNOWN",
  "PASTE_BUSY",
  "PASTE_REJECTED",
  "PASTE_FAILED",
  "PASTE_TIMEOUT",
  "PASTE_CANCELLED",
  "EVENT_GAP",
  "PASTE_OUTCOME_UNKNOWN",
  "CANCELLED",
  "ACTION_TIMEOUT",
  "ACTION_OUTCOME_UNKNOWN",
  "OBSERVE_ONLY",
  "SAFETY_DENIED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorPhase =
  | "configure"
  | "connect"
  | "observe"
  | "admit"
  | "execute"
  | "release";

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  CONFIG_INVALID: "The server configuration is invalid.",
  AUTH_FAILED: "JetKVM authentication failed.",
  AUTH_RATE_LIMITED: "JetKVM authentication is rate limited.",
  AUTH_EXPIRED: "JetKVM authentication expired.",
  UNSUPPORTED_UI_VERSION: "The JetKVM UI automation contract is unsupported.",
  FIRMWARE_INCOMPATIBLE: "The JetKVM firmware is incompatible.",
  BROWSER_UNSUPPORTED: "The configured browser is unsupported.",
  DEVICE_UNREACHABLE: "The JetKVM device is unreachable.",
  CONNECTION_LOST: "The JetKVM connection was lost.",
  SESSION_TAKEN_OVER: "The JetKVM session was taken over.",
  CONTROL_BUSY: "The JetKVM control session is busy.",
  VIDEO_UNAVAILABLE: "JetKVM video is unavailable.",
  VIDEO_STALLED: "JetKVM video is stalled.",
  FRAME_TIMEOUT: "Timed out waiting for a fresh video frame.",
  STALE_VIEW: "The source view is stale.",
  VIEW_CONSUMED: "The source view has already been consumed.",
  DISPLAY_CHANGED: "The display changed after the source view was captured.",
  INVALID_COORDINATE: "A coordinate is outside the source view.",
  INVALID_KEY: "A key is invalid or unsupported.",
  UNSUPPORTED_CHARACTER:
    "A character cannot be entered with the effective keyboard layout.",
  UNSUPPORTED_SCROLL_AXIS: "Horizontal scrolling is unsupported.",
  USE_PASTE_TEXT: "Use computer_paste_text for this text.",
  INPUT_RELEASE_UNKNOWN: "Input release could not be acknowledged.",
  PASTE_BUSY: "A paste operation is already active.",
  PASTE_REJECTED: "The paste operation was rejected before acceptance.",
  PASTE_FAILED: "The paste operation failed.",
  PASTE_TIMEOUT: "The paste operation timed out before acceptance.",
  PASTE_CANCELLED: "The paste operation was cancelled before acceptance.",
  EVENT_GAP: "Required paste lifecycle events are no longer available.",
  PASTE_OUTCOME_UNKNOWN: "The paste outcome is unknown after acceptance.",
  CANCELLED: "The operation was cancelled before dispatch.",
  ACTION_TIMEOUT: "The action timed out before dispatch.",
  ACTION_OUTCOME_UNKNOWN: "The action outcome is unknown after dispatch began.",
  OBSERVE_ONLY: "Mutation is disabled in observe mode.",
  SAFETY_DENIED: "The operation was denied by safety policy.",
};

type FailureDetails = {
  code: ErrorCode;
  message?: string;
  phase?: ErrorPhase;
  operationId?: string;
  failedActionIndex?: number;
  completedActionCount?: number;
  requiredNextAction?: string;
};

type NotSentFailure = FailureDetails & {
  outcome: "not_sent";
  retryable?: boolean;
};

type DispatchedFailure = FailureDetails & {
  outcome: "sent" | "unknown";
  retryable?: false;
};

export type MakeFailureInput = NotSentFailure | DispatchedFailure;

export function makeFailure(input: MakeFailureInput): FailureEnvelope {
  if (!Object.hasOwn(DEFAULT_MESSAGES, input.code)) {
    throw new Error("Unknown stable error code.");
  }
  const outcome: MutationOutcome = input.outcome;
  const error: FailureEnvelope["error"] = {
    code: input.code,
    message: input.message ?? DEFAULT_MESSAGES[input.code],
    phase: input.phase ?? "execute",
    outcome,
    retryable: outcome === "not_sent" ? (input.retryable ?? false) : false,
    effectsUnknown: outcome === "unknown",
  };
  if (input.failedActionIndex !== undefined)
    error.failedActionIndex = input.failedActionIndex;
  if (input.completedActionCount !== undefined)
    error.completedActionCount = input.completedActionCount;
  if (input.requiredNextAction !== undefined)
    error.requiredNextAction = input.requiredNextAction;

  return input.operationId === undefined
    ? { ok: false, error }
    : { ok: false, operationId: input.operationId, error };
}
