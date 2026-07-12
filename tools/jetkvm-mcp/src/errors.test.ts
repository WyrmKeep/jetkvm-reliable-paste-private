import { describe, expect, expectTypeOf, it } from "vitest";
import { ERROR_CODES, makeFailure, type ErrorCode } from "./errors.js";

const expectedCodes = [
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
] as const satisfies readonly ErrorCode[];

function assertRetryabilityTypeContract(): void {
  // @ts-expect-error Repeating a sent mutation is never safe.
  makeFailure({ code: "CONNECTION_LOST", outcome: "sent", retryable: true });
  // @ts-expect-error Repeating an unknown mutation is never safe.
  makeFailure({ code: "CONNECTION_LOST", outcome: "unknown", retryable: true });
}
void assertRetryabilityTypeContract;

describe("stable failures", () => {
  it("exports the complete stable error-code inventory", () => {
    expect(ERROR_CODES).toEqual(expectedCodes);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("marks an unknown mutation as effect-unknown and never retryable", () => {
    expect(makeFailure({ code: "ACTION_OUTCOME_UNKNOWN", outcome: "unknown" })).toMatchObject({
      ok: false,
      error: { retryable: false, effectsUnknown: true },
    });
  });

  it("makes sent and unknown outcomes non-retryable even for untyped hostile input", () => {
    expect(makeFailure({ code: "CONNECTION_LOST", outcome: "sent", retryable: true as false }).error.retryable).toBe(false);
    expect(makeFailure({ code: "CONNECTION_LOST", outcome: "unknown", retryable: true as false }).error.retryable).toBe(false);
  });

  it("fails closed when an untyped caller supplies a non-stable code", () => {
    expect(() =>
      makeFailure({ code: "NOT_STABLE" as ErrorCode, outcome: "not_sent" }),
    ).toThrowError("Unknown stable error code.");
  });

  it("allows retryable only before dispatch and tracks known effects", () => {
    const failure = makeFailure({
      code: "DEVICE_UNREACHABLE",
      outcome: "not_sent",
      retryable: true,
      operationId: "op_1",
      phase: "connect",
    });
    expect(failure).toEqual({
      ok: false,
      operationId: "op_1",
      error: {
        code: "DEVICE_UNREACHABLE",
        message: "The JetKVM device is unreachable.",
        phase: "connect",
        outcome: "not_sent",
        retryable: true,
        effectsUnknown: false,
      },
    });
    expectTypeOf(failure.error.retryable).toEqualTypeOf<boolean>();
  });
});
