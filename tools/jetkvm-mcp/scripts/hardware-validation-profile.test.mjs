import assert from "node:assert/strict";
import test from "node:test";

import {
  ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
  ATX_UNAVAILABLE_EXCEPTION_CODE,
  parseHardwareValidationProfile,
  validateHardwareValidation,
} from "./hardware-validation-profile.mjs";

const FULL = Object.freeze({
  profile: "full",
  exception_code: null,
});
const ATX_UNAVAILABLE = Object.freeze({
  profile: "atx_unavailable",
  exception_code: "ATX_WIRING_UNAVAILABLE",
});

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
