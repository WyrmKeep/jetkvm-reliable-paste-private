import { createHash } from "node:crypto";

import { validateLiveExecutionPlan } from "./live-plan-validation.mjs";

export const ATX_UNAVAILABLE_ACKNOWLEDGEMENT =
  "selected_fixture_has_no_usable_atx_motherboard_leads";
export const ATX_UNAVAILABLE_EXCEPTION_CODE = "ATX_WIRING_UNAVAILABLE";
export const CANONICAL_ATX_UNAVAILABLE_STEPS = deepFreeze([
  {
    story_id: "power-three-semantic-actions",
    step_id: "establish-definitive-atx-session",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "prove-press-power-baseline",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "press-power",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "restore-and-prove-hold-power-baseline",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "hold-power",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "restore-and-prove-reset-baseline",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "press-reset",
  },
  {
    story_id: "power-three-semantic-actions",
    step_id: "restore-and-prove-post-reset-baseline",
  },
  {
    story_id: "duplicate-request-id-definitive-replay",
    step_id: "prepare-duplicate-power-case",
  },
  {
    story_id: "duplicate-request-id-definitive-replay",
    step_id: "duplicate-initial-jetkvm-power-control",
  },
  {
    story_id: "duplicate-request-id-definitive-replay",
    step_id: "duplicate-same-request-digest-jetkvm-power-control",
  },
  {
    story_id: "duplicate-request-id-definitive-replay",
    step_id: "duplicate-changed-digest-jetkvm-power-control",
  },
  {
    story_id: "duplicate-request-id-definitive-replay",
    step_id: "restore-and-prove-after-duplicate-power",
  },
  {
    story_id: "atx-extension-serialization-idempotency-and-nonproof",
    step_id: "prove-serialized-power-baseline",
  },
  {
    story_id: "atx-extension-serialization-idempotency-and-nonproof",
    step_id: "serialized-power-short",
  },
  {
    story_id: "atx-extension-serialization-idempotency-and-nonproof",
    step_id: "repeat-power-short",
  },
  {
    story_id: "atx-extension-serialization-idempotency-and-nonproof",
    step_id: "restore-and-prove-prewrite-baseline",
  },
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected) {
  if (!isRecord(value)) {
    throw new Error("Hardware validation profile is malformed.");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("Hardware validation profile fields drifted.");
  }
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function excludedStepsSha256(steps) {
  const canonical = steps.map(({ story_id, step_id }) => ({
    step_id,
    story_id,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function freezeDeclaration(value) {
  return Object.freeze({
    profile: value.profile,
    exception_code: value.exception_code,
  });
}

export function validateHardwareValidation(value) {
  assertExactKeys(value, ["profile", "exception_code"]);
  if (value.profile === "full" && value.exception_code === null) {
    return freezeDeclaration(value);
  }
  if (
    value.profile === "atx_unavailable" &&
    value.exception_code === ATX_UNAVAILABLE_EXCEPTION_CODE
  ) {
    return freezeDeclaration(value);
  }
  throw new Error("Hardware validation profile is invalid.");
}

export function parseHardwareValidationProfile(environment = {}) {
  if (!isRecord(environment)) {
    throw new Error("Hardware validation environment is malformed.");
  }
  const profile = environment.JETKVM_RELEASE_HARDWARE_PROFILE ?? "full";
  const acknowledgement =
    environment.JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT;
  if (profile === "full") {
    if (acknowledgement !== undefined) {
      throw new Error(
        "Full hardware validation forbids an ATX exception acknowledgement.",
      );
    }
    return validateHardwareValidation({
      profile: "full",
      exception_code: null,
    });
  }
  if (
    profile !== "atx_unavailable" ||
    acknowledgement !== ATX_UNAVAILABLE_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      "ATX-unavailable release requires the explicit ATX-unavailable acknowledgement.",
    );
  }
  return validateHardwareValidation({
    profile,
    exception_code: ATX_UNAVAILABLE_EXCEPTION_CODE,
  });
}

export function deriveHardwareValidationException({
  stories,
  plan,
  hardwareValidation,
}) {
  const validated = validateHardwareValidation(hardwareValidation);
  validateLiveExecutionPlan(stories, plan);
  if (validated.profile === "full") return null;

  const excludedSteps = [];
  for (const story of stories.filter(
    (value) =>
      Array.isArray(value.environments) && value.environments.includes("live"),
  )) {
    for (const step of story.steps) {
      if (plan[story.id].steps[step.id].requires_atx_wiring) {
        excludedSteps.push({ story_id: story.id, step_id: step.id });
      }
    }
  }
  if (
    JSON.stringify(excludedSteps) !==
    JSON.stringify(CANONICAL_ATX_UNAVAILABLE_STEPS)
  ) {
    throw new Error("Canonical ATX-wiring exclusion set drifted.");
  }
  return deepFreeze({
    schema_version: 1,
    kind: "jetkvm-mcp-hardware-exception",
    profile: validated.profile,
    exception_code: validated.exception_code,
    reason_code: ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
    excluded_step_count: excludedSteps.length,
    excluded_steps: excludedSteps,
    excluded_steps_sha256: excludedStepsSha256(excludedSteps),
  });
}
