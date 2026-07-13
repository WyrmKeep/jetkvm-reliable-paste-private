import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ERROR_CODES,
  ERROR_PHASES,
  REQUIRED_NEXT_STEPS,
  type ErrorCode,
  type ErrorPhase,
  type RequiredNextStep,
} from "./errors.js";

const expectedErrorCodes = [
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
  "CONTROL_BUSY",
  "SESSION_DRAINED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "DOWNSTREAM_MALFORMED_RESPONSE",
  "VIDEO_UNAVAILABLE",
  "VIDEO_STALLED",
  "FRAME_TIMEOUT",
  "STALE_OBSERVATION",
  "OBSERVATION_CONSUMED",
  "DISPLAY_CHANGED",
  "EDID_READ_FAILED",
  "DISPLAY_STATUS_STALE",
  "INVALID_COORDINATE",
  "INVALID_KEY",
  "UNSUPPORTED_SCROLL_AXIS",
  "PASTE_BUSY",
  "PASTE_REJECTED",
  "PASTE_FAILED",
  "PASTE_CANCELLED",
  "EVENT_GAP",
  "POWER_ACTION_REJECTED",
  "ATX_EXTENSION_INACTIVE",
  "ATX_SERIAL_UNAVAILABLE",
  "ATX_BUSY",
  "POWER_STATE_UNVERIFIED",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "ADMISSION_CAPACITY_EXCEEDED",
  "MUTATION_OUTCOME_UNKNOWN",
  "PARTIAL_VERIFICATION",
  "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
] as const;

describe("stable error contract", () => {
  it("exports exactly the canonical error-code inventory", () => {
    expect(ERROR_CODES).toEqual(expectedErrorCodes);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).not.toContain("STALE_VIEW");
    expect(ERROR_CODES).not.toContain("VIEW_CONSUMED");
    expect(ERROR_CODES).not.toContain("ACTION_TIMEOUT");
    expect(ERROR_CODES).not.toContain("PASTE_TIMEOUT");
  });

  it("exports exact execution phases", () => {
    expect(ERROR_PHASES).toEqual([
      "validate",
      "authorize",
      "queue",
      "connect",
      "execute",
      "verify",
      "cleanup",
    ]);
  });

  it("exports exact recovery steps", () => {
    expect(REQUIRED_NEXT_STEPS).toEqual([
      "none",
      "capture_then_retry",
      "reconnect_then_capture",
      "release_then_reconnect_then_capture",
      "inspect_device_state_before_retry",
      "wait_or_request_takeover",
      "grant_permission",
      "enable_capability",
    ]);
  });

  it("derives public unions from immutable inventories", () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[number]>();
    expectTypeOf<ErrorPhase>().toEqualTypeOf<(typeof ERROR_PHASES)[number]>();
    expectTypeOf<RequiredNextStep>().toEqualTypeOf<
      (typeof REQUIRED_NEXT_STEPS)[number]
    >();
  });
});
