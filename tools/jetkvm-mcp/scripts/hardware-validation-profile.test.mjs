import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
  ATX_UNAVAILABLE_EXCEPTION_CODE,
  deriveHardwareValidationException,
  parseHardwareValidationProfile,
  validateHardwareValidation,
} from "./hardware-validation-profile.mjs";
import { materializeLiveExecutionPlan } from "./live-story-plan.mjs";

const FULL = Object.freeze({
  profile: "full",
  exception_code: null,
});
const ATX_UNAVAILABLE = Object.freeze({
  profile: "atx_unavailable",
  exception_code: "ATX_WIRING_UNAVAILABLE",
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadStories() {
  const directory = join(packageRoot, "src", "stories");
  const files = (await readdir(directory))
    .filter((name) => /^\d{2}-.*\.json$/u.test(name))
    .sort();
  return Promise.all(
    files.map((name) =>
      readFile(join(directory, name), "utf8").then(JSON.parse),
    ),
  );
}

test("defaults release candidates to full hardware validation", () => {
  assert.deepEqual(parseHardwareValidationProfile({}), FULL);
  assert.equal(Object.isFrozen(parseHardwareValidationProfile({})), true);
});

test("requires the exact ATX-unavailable acknowledgement", () => {
  assert.equal(
    ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
    "selected_fixture_has_no_usable_atx_motherboard_leads",
  );
  assert.equal(ATX_UNAVAILABLE_EXCEPTION_CODE, "ATX_WIRING_UNAVAILABLE");
  assert.deepEqual(
    parseHardwareValidationProfile({
      JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
      JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT:
        ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
    }),
    ATX_UNAVAILABLE,
  );
  for (const environment of [
    { JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable" },
    {
      JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
      JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT: "yes",
    },
    {
      JETKVM_RELEASE_HARDWARE_PROFILE: "full",
      JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT:
        ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
    },
    { JETKVM_RELEASE_HARDWARE_PROFILE: "unknown" },
  ]) {
    assert.throws(() => parseHardwareValidationProfile(environment));
  }
});

test("accepts only the two exact frozen hardware declarations", () => {
  assert.deepEqual(validateHardwareValidation(FULL), FULL);
  assert.deepEqual(validateHardwareValidation(ATX_UNAVAILABLE), ATX_UNAVAILABLE);
  for (const mutated of [
    null,
    {},
    { profile: "unknown", exception_code: null },
    { profile: "full", exception_code: ATX_UNAVAILABLE_EXCEPTION_CODE },
    { profile: "atx_unavailable", exception_code: null },
    { profile: "atx_unavailable", exception_code: "custom" },
    { ...ATX_UNAVAILABLE, extra: true },
  ]) {
    assert.throws(() => validateHardwareValidation(mutated));
  }
});

test("derives the immutable canonical ATX exception from the live plan", async () => {
  const stories = await loadStories();
  const plan = materializeLiveExecutionPlan(stories, (story, step, mode) => [
    `${mode}:${story.id}:${step.id}`,
  ]);

  assert.equal(
    deriveHardwareValidationException({
      stories,
      plan,
      hardwareValidation: FULL,
    }),
    null,
  );
  const exception = deriveHardwareValidationException({
    stories,
    plan,
    hardwareValidation: ATX_UNAVAILABLE,
  });
  assert.equal(exception.excluded_step_count, 17);
  assert.equal(exception.excluded_steps.length, 17);
  assert.deepEqual(exception.excluded_steps[0], {
    story_id: "power-three-semantic-actions",
    step_id: "establish-definitive-atx-session",
  });
  assert.deepEqual(exception.excluded_steps.at(-1), {
    story_id: "atx-extension-serialization-idempotency-and-nonproof",
    step_id: "restore-and-prove-prewrite-baseline",
  });
  assert.match(exception.excluded_steps_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(exception), true);
  assert.equal(Object.isFrozen(exception.excluded_steps), true);

  const unclassified = structuredClone(plan);
  for (const storyPlan of Object.values(unclassified)) {
    for (const assignment of Object.values(storyPlan.steps)) {
      assignment.requires_atx_wiring = false;
    }
  }
  assert.throws(
    () =>
      deriveHardwareValidationException({
        stories,
        plan: unclassified,
        hardwareValidation: ATX_UNAVAILABLE,
      }),
    /no canonical ATX-wiring exclusions/u,
  );
});
