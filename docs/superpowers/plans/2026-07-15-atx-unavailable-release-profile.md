# ATX-Unavailable Release Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind an explicit `atx_unavailable` profile into the frozen v0.1 candidate, execute and validate every safe hardware step, exclude only the 17 canonical steps that require physical ATX wiring, and publish machine-verifiable `pass_with_exception` evidence.

**Architecture:** A focused profile module owns the two strict frozen declarations and deterministic exception record. The canonical live plan classifies ATX-dependent and ATX-safe power steps at step granularity; plan materialization turns that classification into immutable `requires_atx_wiring` flags. The runner reads only the candidate-bound profile, records excluded steps without dispatching them, runs and restores every other step, and emits an immutable exception file that the validator independently re-derives and checks.

**Tech Stack:** Node.js 22.23.1 ESM, strict JSON release artifacts, Node test runner, existing manifest-driven hardware runner, SHA-256 canonical evidence, npm package gates.

---

## File map

- Create `tools/jetkvm-mcp/scripts/hardware-validation-profile.mjs`: strict profile parsing/validation, fixed acknowledgement and reason codes, canonical excluded-step derivation, immutable exception record.
- Create `tools/jetkvm-mcp/scripts/hardware-validation-profile.test.mjs`: profile, acknowledgement, classification, and 17-step-set contract tests.
- Modify `tools/jetkvm-mcp/scripts/live-story-plan.json`: reviewed ATX-dependent and ATX-safe hardware step classifications.
- Modify `tools/jetkvm-mcp/scripts/live-story-plan.mjs`: validate classifications, materialize `requires_atx_wiring` on every assignment, and own the shared strict plan validator.
- Modify `tools/jetkvm-mcp/scripts/live-story-plan.test.mjs`: prove exact classification, reject overlap/unclassified hardware power steps, preserve canonical order.
- Modify `tools/jetkvm-mcp/scripts/release-evidence.mjs`: candidate schema v2 and strict `hardware_validation` field.
- Modify `tools/jetkvm-mcp/scripts/release-evidence.test.mjs`: candidate build/validation tests for both profiles and malformed declarations.
- Modify `tools/jetkvm-mcp/scripts/freeze-release-candidate.mjs`: freeze-time profile parsing and candidate binding.
- Modify `tools/jetkvm-mcp/scripts/freeze-release-candidate.test.mjs`: default-full, explicit acknowledgement, and frozen-byte tests.
- Modify `tools/jetkvm-mcp/scripts/live-release-core.mjs`: profile-aware step exclusion while retaining story baseline and unconditional restore.
- Modify `tools/jetkvm-mcp/scripts/live-release-core.test.mjs`: no-dispatch excluded steps, mixed-story continuation, full-mode parity, failure/restore tests.
- Modify `tools/jetkvm-mcp/scripts/run-live-hardware-release.mjs`: candidate-bound selection, conditional ATX preflight, exception file, summary counts/result.
- Modify `tools/jetkvm-mcp/scripts/run-live-hardware-release.test.mjs`: orchestration and immutable exception tests.
- Modify `tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.mjs`: independent profile/exclusion/file/count validation.
- Modify `tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.test.mjs`: exact positive fixtures and fail-closed mutation matrix.
- Modify `tools/jetkvm-mcp/README.md`: freeze command, profile semantics, evidence result, and release disclosure.

---

### Task 1: Strict frozen hardware-validation profile

**Files:**

- Create: `tools/jetkvm-mcp/scripts/hardware-validation-profile.mjs`
- Create: `tools/jetkvm-mcp/scripts/hardware-validation-profile.test.mjs`
- Modify: `tools/jetkvm-mcp/scripts/release-evidence.mjs`
- Modify: `tools/jetkvm-mcp/scripts/release-evidence.test.mjs`
- Modify: `tools/jetkvm-mcp/scripts/freeze-release-candidate.mjs`
- Modify: `tools/jetkvm-mcp/scripts/freeze-release-candidate.test.mjs`

- [ ] **Step 1: Write failing strict-profile tests**

Add tests that require these exact declarations and reject every widened variant:

```js
const FULL = Object.freeze({
  profile: "full",
  exception_code: null,
});
const ATX_UNAVAILABLE = Object.freeze({
  profile: "atx_unavailable",
  exception_code: "ATX_WIRING_UNAVAILABLE",
});

assert.deepEqual(parseHardwareValidationProfile({}), FULL);
assert.deepEqual(
  parseHardwareValidationProfile({
    JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
    JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT:
      "selected_fixture_has_no_usable_atx_motherboard_leads",
  }),
  ATX_UNAVAILABLE,
);
assert.throws(
  () =>
    parseHardwareValidationProfile({
      JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
    }),
  /explicit ATX-unavailable acknowledgement/u,
);
for (const mutated of [
  { profile: "unknown", exception_code: null },
  { profile: "full", exception_code: "ATX_WIRING_UNAVAILABLE" },
  { profile: "atx_unavailable", exception_code: null },
  { profile: "atx_unavailable", exception_code: "custom" },
  {
    profile: "atx_unavailable",
    exception_code: "ATX_WIRING_UNAVAILABLE",
    extra: true,
  },
]) {
  assert.throws(() => validateHardwareValidation(mutated));
}
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```sh
fnm exec --using=22.23.1 node --test \
  scripts/hardware-validation-profile.test.mjs \
  scripts/release-evidence.test.mjs \
  scripts/freeze-release-candidate.test.mjs
```

Expected: failure because `hardware-validation-profile.mjs` and candidate `hardware_validation` do not exist.

- [ ] **Step 3: Implement the strict profile module**

Export only fixed-code APIs; accept no caller-provided reason text:

```js
export const ATX_UNAVAILABLE_ACKNOWLEDGEMENT =
  "selected_fixture_has_no_usable_atx_motherboard_leads";
export const ATX_UNAVAILABLE_EXCEPTION_CODE = "ATX_WIRING_UNAVAILABLE";

export function validateHardwareValidation(value) {
  assertExactKeys(value, ["profile", "exception_code"]);
  if (value.profile === "full" && value.exception_code === null) {
    return deepFreeze(structuredClone(value));
  }
  if (
    value.profile === "atx_unavailable" &&
    value.exception_code === ATX_UNAVAILABLE_EXCEPTION_CODE
  ) {
    return deepFreeze(structuredClone(value));
  }
  throw new Error("Hardware validation profile is invalid.");
}

export function parseHardwareValidationProfile(environment) {
  const profile = environment.JETKVM_RELEASE_HARDWARE_PROFILE ?? "full";
  if (profile === "full") {
    if (
      environment.JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT !== undefined
    ) {
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
    environment.JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT !==
      ATX_UNAVAILABLE_ACKNOWLEDGEMENT
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
```

Use local strict-object/deep-freeze helpers; do not export mutable constants or free-form waiver parsing.

- [ ] **Step 4: Bind the profile into candidate schema v2**

In `release-evidence.mjs`:

```js
const CANDIDATE_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "package",
  "source",
  "runtime",
  "hardware_validation",
  "artifact",
  "installation",
]);

// validateReleaseCandidateManifest
if (value.schema_version !== 2) {
  throw new Error("Candidate schema version must be 2.");
}
validateHardwareValidation(value.hardware_validation);

// buildReleaseCandidateManifest
const candidate = {
  schema_version: 2,
  // existing fields remain exact
  hardware_validation: validateHardwareValidation(input.hardwareValidation),
};
```

Update every candidate fixture to include the exact full declaration. Add one build/validate test for `atx_unavailable` and mutation tests for missing/extra/wrong profile fields.

- [ ] **Step 5: Freeze the profile before candidate construction**

Extend `freezeReleaseCandidate` with a required validated `hardwareValidation` argument and pass it to `buildReleaseCandidateManifest`. In the CLI entry point parse only process environment:

```js
const hardwareValidation = parseHardwareValidationProfile(process.env);
const result = await freezeReleaseCandidate({
  // existing exact inputs
  hardwareValidation,
});
```

Tests must prove the default is full, the ATX profile requires the exact acknowledgement, and changing profile changes `candidate.json` and `candidate.sha256`.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run the command from Step 2. Expected: all profile/candidate/freeze tests pass.

- [ ] **Step 7: Commit the profile boundary**

```sh
git add tools/jetkvm-mcp/scripts/hardware-validation-profile.mjs \
  tools/jetkvm-mcp/scripts/hardware-validation-profile.test.mjs \
  tools/jetkvm-mcp/scripts/release-evidence.mjs \
  tools/jetkvm-mcp/scripts/release-evidence.test.mjs \
  tools/jetkvm-mcp/scripts/freeze-release-candidate.mjs \
  tools/jetkvm-mcp/scripts/freeze-release-candidate.test.mjs
git commit -m "feat(release): bind hardware validation profile"
```

### Task 2: Canonical step-granular ATX classification

**Files:**

- Modify: `tools/jetkvm-mcp/scripts/live-story-plan.json`
- Modify: `tools/jetkvm-mcp/scripts/live-story-plan.mjs`
- Modify: `tools/jetkvm-mcp/scripts/live-story-plan.test.mjs`
- Modify: `tools/jetkvm-mcp/scripts/live-release-core.mjs`

- [ ] **Step 1: Write failing canonical-classification tests**

Assert exactly 17 ATX-wiring-dependent assignments in canonical order and exactly three safe hardware power calls:

```js
assert.deepEqual(atxUnavailableIds, [
  ["power-three-semantic-actions", "establish-definitive-atx-session"],
  ["power-three-semantic-actions", "prove-press-power-baseline"],
  ["power-three-semantic-actions", "press-power"],
  ["power-three-semantic-actions", "restore-and-prove-hold-power-baseline"],
  ["power-three-semantic-actions", "hold-power"],
  ["power-three-semantic-actions", "restore-and-prove-reset-baseline"],
  ["power-three-semantic-actions", "press-reset"],
  ["power-three-semantic-actions", "restore-and-prove-post-reset-baseline"],
  ["duplicate-request-id-definitive-replay", "prepare-duplicate-power-case"],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-initial-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-same-request-digest-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-changed-digest-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "restore-and-prove-after-duplicate-power",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "prove-serialized-power-baseline",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "serialized-power-short",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "repeat-power-short",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "restore-and-prove-prewrite-baseline",
  ],
]);
assert.deepEqual(atxSafeIds, [
  [
    "session-connect-without-takeover-busy",
    "reject-strict-schema-jetkvm-power-control",
  ],
  ["stale-generation-zero-downstream-write", "stale-power-generation"],
  [
    "stale-generation-zero-downstream-write",
    "stale-keyboard-generation-jetkvm-power-control",
  ],
]);
```

Also mutate a definition to overlap lists, omit a hardware `jetkvm_power_control` step, and classify a non-hardware step; each must fail plan materialization.

- [ ] **Step 2: Run plan tests and confirm RED**

```sh
fnm exec --using=22.23.1 node --test scripts/live-story-plan.test.mjs
```

Expected: failure because the classification fields and assignment boolean are absent.

- [ ] **Step 3: Add the reviewed declarations**

Every story definition must have strict keys:

```json
{
  "step_ids_sha256": "...",
  "hardware_step_ids": [],
  "controlled_step_ids": [],
  "atx_unavailable_step_ids": [],
  "atx_safe_without_wiring_step_ids": []
}
```

Populate only the 17 excluded IDs and three safe IDs listed in Step 1. Both arrays must be subsets of `hardware_step_ids`, disjoint, duplicate-free, and canonical-story-local.

- [ ] **Step 4: Materialize and validate the boolean classification**

Move `validateLiveExecutionPlan` and its plan-shape helpers from `live-release-core.mjs` into `live-story-plan.mjs`, update both test imports, and make every assignment strict and immutable:

```js
steps[step.id] = Object.freeze({
  mode,
  requires_atx_wiring: atxUnavailable.has(step.id),
  ...(mode === "hardware"
    ? {}
    : { assertion_ids: Object.freeze([...assertionIds]) }),
});
```

For each hardware assignment whose canonical `step.tool === "jetkvm_power_control"`, require membership in exactly one of `atx_unavailable_step_ids` or `atx_safe_without_wiring_step_ids`. Reject classifications on non-hardware assignments. Update `validateLiveExecutionPlan` so expected keys always include `requires_atx_wiring` and the value must be boolean.

- [ ] **Step 5: Run plan and core tests**

```sh
fnm exec --using=22.23.1 node --test \
  scripts/live-story-plan.test.mjs \
  scripts/live-release-core.test.mjs
```

Expected: all plan tests pass; core fixtures may fail only where they still omit the new required boolean. Update fixtures mechanically to `requires_atx_wiring: false` and rerun to green.

- [ ] **Step 6: Commit the canonical classification**

```sh
git add tools/jetkvm-mcp/scripts/live-story-plan.json \
  tools/jetkvm-mcp/scripts/live-story-plan.mjs \
  tools/jetkvm-mcp/scripts/live-story-plan.test.mjs \
  tools/jetkvm-mcp/scripts/live-release-core.mjs \
  tools/jetkvm-mcp/scripts/live-release-core.test.mjs
git commit -m "feat(release): classify ATX-wiring steps"
```

### Task 3: Profile-aware serial execution

**Files:**

- Modify: `tools/jetkvm-mcp/scripts/hardware-validation-profile.mjs`
- Modify: `tools/jetkvm-mcp/scripts/hardware-validation-profile.test.mjs`
- Modify: `tools/jetkvm-mcp/scripts/live-release-core.mjs`
- Modify: `tools/jetkvm-mcp/scripts/live-release-core.test.mjs`

- [ ] **Step 1: Write failing exception-derivation and executor tests**

Build a mixed story with one flagged step between two safe steps. Assert `atx_unavailable` never calls the flagged driver method, still calls both safe methods, still captures before/after baselines, runs every restore, and records:

```js
{
  step_id: "physical-atx-step",
  mode: "hardware",
  requires_atx_wiring: true,
  result: "excluded",
  exception_code: "ATX_WIRING_UNAVAILABLE",
}
```

The story result must be `pass_with_exception`; full mode must dispatch the same flagged step and produce the existing all-pass record. A failure after an excluded step must still restore and fail the run.

- [ ] **Step 2: Run focused core tests and confirm RED**

```sh
fnm exec --using=22.23.1 node --test \
  scripts/hardware-validation-profile.test.mjs \
  scripts/live-release-core.test.mjs
```

Expected: exclusion tests fail because all hardware assignments are still dispatched.

- [ ] **Step 3: Implement deterministic exception derivation**

In `hardware-validation-profile.mjs`, derive from validated `stories + plan + candidate.hardware_validation`; accept no exclusion list argument:

```js
export function deriveHardwareValidationException({
  stories,
  plan,
  hardwareValidation,
}) {
  validateHardwareValidation(hardwareValidation);
  validateLiveExecutionPlan(stories, plan);
  const excluded_steps = [];
  for (const story of stories.filter((item) =>
    item.environments.includes("live"),
  )) {
    for (const step of story.steps) {
      if (plan[story.id].steps[step.id].requires_atx_wiring) {
        excluded_steps.push(
          Object.freeze({ story_id: story.id, step_id: step.id }),
        );
      }
    }
  }
  if (hardwareValidation.profile === "full") return null;
  if (excluded_steps.length !== 17) {
    throw new Error("Canonical ATX-wiring exclusion set drifted.");
  }
  return deepFreeze({
    schema_version: 1,
    kind: "jetkvm-mcp-hardware-exception",
    profile: "atx_unavailable",
    exception_code: ATX_UNAVAILABLE_EXCEPTION_CODE,
    reason_code: ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
    excluded_step_count: excluded_steps.length,
    excluded_steps,
    excluded_steps_sha256: sha256Canonical(excluded_steps),
  });
}
```

`hardware-validation-profile.mjs` imports the shared `validateLiveExecutionPlan` from `live-story-plan.mjs`. `live-release-core.mjs` imports both modules, so there is no cycle; `live-story-plan.mjs` must not import either the profile module or the core executor.

- [ ] **Step 4: Skip only derived excluded assignments**

Extend `runCanonicalLiveStories` with required `hardwareValidation`. Derive the immutable exception once. In the step loop:

```js
if (
  hardwareValidation.profile === "atx_unavailable" &&
  assignment.requires_atx_wiring
) {
  steps.push({
    step_id: step.id,
    mode: assignment.mode,
    requires_atx_wiring: true,
    result: "excluded",
    exception_code: ATX_UNAVAILABLE_EXCEPTION_CODE,
  });
  continue;
}
```

Pass records include `requires_atx_wiring`. Record result is `pass_with_exception` iff it contains excluded steps and has no failures. Baseline capture, every restore, baseline comparison, record write, failure propagation, and canonical story order remain unchanged.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run the command from Step 2. Expected: all tests pass, with explicit assertions that excluded driver calls remain zero.

- [ ] **Step 6: Commit profile-aware execution**

```sh
git add tools/jetkvm-mcp/scripts/hardware-validation-profile.mjs \
  tools/jetkvm-mcp/scripts/hardware-validation-profile.test.mjs \
  tools/jetkvm-mcp/scripts/live-release-core.mjs \
  tools/jetkvm-mcp/scripts/live-release-core.test.mjs
git commit -m "feat(release): execute ATX-unavailable profile"
```

### Task 4: Runner orchestration and immutable exception evidence

**Files:**

- Modify: `tools/jetkvm-mcp/scripts/run-live-hardware-release.mjs`
- Modify: `tools/jetkvm-mcp/scripts/run-live-hardware-release.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Add tests that inject a full candidate and an ATX-unavailable candidate. Assert:

- full calls `driver.proveAtx()` exactly once, writes no `hardware-exception.json`, uses `result: "pass"`, `excluded_step_count: 0`, and a non-null ATX preflight digest;
- ATX-unavailable never calls `driver.proveAtx()`, writes the exact derived exception before sealing evidence, uses `result: "pass_with_exception"`, `excluded_step_count: 17`, `executed_step_count = step_count - 17`, and `atx_preflight_sha256: null`;
- candidate/profile mutation after freeze fails before device contact.

- [ ] **Step 2: Run runner tests and confirm RED**

```sh
fnm exec --using=22.23.1 node --test scripts/run-live-hardware-release.test.mjs
```

Expected: profile orchestration assertions fail.

- [ ] **Step 3: Make the candidate the sole profile authority**

After candidate validation, derive the exception from `candidate.hardware_validation`, stories, and plan. Do not read a runtime profile environment variable. Replace unconditional preflight with:

```js
const hardwareException = deriveHardwareValidationException({
  stories,
  plan,
  hardwareValidation: candidate.hardware_validation,
});
const atxPreflight =
  candidate.hardware_validation.profile === "full"
    ? await driver.proveAtx()
    : null;
const records = await runCanonicalLiveStories({
  stories,
  plan,
  driver,
  runId,
  hardwareValidation: candidate.hardware_validation,
  writeRecord,
});
```

- [ ] **Step 4: Write and bind exception evidence**

For `atx_unavailable`, write `hardware-exception.json` through `writeAndFlush` before summary/manifest creation. For full, forbid that file. Extend summary schema:

```js
hardware_validation: candidate.hardware_validation,
result: hardwareException === null ? "pass" : "pass_with_exception",
story_count: records.length,
step_count: totalSteps,
executed_step_count: passedSteps,
excluded_step_count: excludedSteps,
hardware_exception_sha256:
  hardwareException === null ? null : sha256Canonical(hardwareException),
atx_preflight_sha256:
  atxPreflight === null ? null : atxPreflight.evidence_sha256,
```

Require every record to be `pass` or `pass_with_exception` according to its actual excluded steps; never infer success merely from counts.

- [ ] **Step 5: Run runner tests and confirm GREEN**

Run the command from Step 2. Expected: all runner tests pass for both profiles and immutable sealing order.

- [ ] **Step 6: Commit orchestration**

```sh
git add tools/jetkvm-mcp/scripts/run-live-hardware-release.mjs \
  tools/jetkvm-mcp/scripts/run-live-hardware-release.test.mjs
git commit -m "feat(release): seal ATX exception evidence"
```

### Task 5: Independent evidence validation

**Files:**

- Modify: `tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.mjs`
- Modify: `tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.test.mjs`

- [ ] **Step 1: Write failing validator mutation tests**

Start from complete full and ATX-unavailable fixtures. For ATX-unavailable, individually mutate:

- candidate profile or exception code;
- missing, extra, duplicate, reordered, or renamed excluded step;
- an excluded safe step or an executed ATX-required step;
- excluded step with duration/evidence, or pass step without evidence;
- story/result/count/hash mismatch;
- missing or extra `hardware-exception.json`;
- non-null ATX preflight digest;
- missing non-ATX story/step/restore/baseline;
- summary `pass` instead of `pass_with_exception`.

Each mutation must throw before returning an audit. Full fixtures must reject any exclusion file/count/result.

- [ ] **Step 2: Run validator tests and confirm RED**

```sh
fnm exec --using=22.23.1 node --test \
  scripts/validate-hardware-release-evidence.test.mjs
```

Expected: new profile assertions fail.

- [ ] **Step 3: Re-derive and validate every exclusion**

Extend `validateHardwareReleaseEvidence` with `hardwareException`. Independently call `deriveHardwareValidationException` from candidate/stories/plan; compare canonical bytes, profile, code, reason, count, ordered `(story_id, step_id)` pairs, and hash. In `validateRecord`:

```js
if (assignment.requires_atx_wiring && profile === "atx_unavailable") {
  assertExactKeys(
    result,
    ["step_id", "mode", "requires_atx_wiring", "result", "exception_code"],
    label,
  );
  if (
    result.result !== "excluded" ||
    result.exception_code !== ATX_UNAVAILABLE_EXCEPTION_CODE
  )
    throw new Error(`${label} exclusion drifted.`);
  return;
}
```

Every other assignment must be strict pass evidence with exact assertions and `requires_atx_wiring: false` (or true only in full mode where it executed).

- [ ] **Step 4: Enforce summary and directory contracts**

The expected terminal result is derived from candidate profile. Validate exact total/executed/excluded/restore counts, candidate profile identity, exception digest/null, ATX preflight digest/null, finalization/device-test hashes, and all existing package/device/source identities. `validateEvidenceDirectory` conditionally reads exactly one `hardware-exception.json` for ATX-unavailable and rejects it for full before manifest acceptance.

Return:

```js
Object.freeze({
  schema_version: 1,
  result: expectedResult,
  hardware_validation: candidate.hardware_validation,
  candidate_commit: candidate.source.commit_sha,
  run_id: summary.run_id,
  story_count,
  step_count,
  executed_step_count,
  excluded_step_count,
  restore_count,
  records_sha256: sha256Canonical(records),
});
```

- [ ] **Step 5: Run validator and complete release-script regressions**

```sh
fnm exec --using=22.23.1 node --test \
  scripts/hardware-validation-profile.test.mjs \
  scripts/release-evidence.test.mjs \
  scripts/freeze-release-candidate.test.mjs \
  scripts/live-story-plan.test.mjs \
  scripts/live-release-core.test.mjs \
  scripts/run-live-hardware-release.test.mjs \
  scripts/validate-hardware-release-evidence.test.mjs
```

Expected: all tests pass, including full-profile parity and ATX-unavailable fail-closed mutations.

- [ ] **Step 6: Commit validator changes**

```sh
git add tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.mjs \
  tools/jetkvm-mcp/scripts/validate-hardware-release-evidence.test.mjs
git commit -m "feat(release): validate ATX exception profile"
```

### Task 6: Operator contract, full gates, review, and new candidate

**Files:**

- Modify: `tools/jetkvm-mcp/README.md`
- Verify: all files changed in Tasks 1–5

- [ ] **Step 1: Smoke-test the complete behavior before cleanup**

Run the seven-file command from Task 5 Step 5. Expected: all focused tests pass. Confirm a synthetic ATX-unavailable fixture reports exactly 17 excluded steps and zero calls to their driver methods.

- [ ] **Step 2: Document the exact freeze and evidence contract**

Add the explicit freeze environment:

```sh
export JETKVM_RELEASE_HARDWARE_PROFILE='atx_unavailable'
export JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT=\
'selected_fixture_has_no_usable_atx_motherboard_leads'
```

State that `full` is the default; the acknowledgement is rejected in full mode; the profile is frozen into `candidate.json`; the unavailable profile skips only the 17 reviewed physical/dependent steps across three mixed stories, runs all remaining steps/restores, and returns `pass_with_exception`; controlled/fake/unit ATX semantics remain evidence, but physical switching and host-state change are not release claims.

- [ ] **Step 3: Run formatter and complete hardware-free gates**

```sh
fnm exec --using=22.23.1 npx prettier --write \
  scripts/hardware-validation-profile.mjs \
  scripts/hardware-validation-profile.test.mjs \
  scripts/release-evidence.mjs \
  scripts/release-evidence.test.mjs \
  scripts/freeze-release-candidate.mjs \
  scripts/freeze-release-candidate.test.mjs \
  scripts/live-story-plan.json \
  scripts/live-story-plan.mjs \
  scripts/live-story-plan.test.mjs \
  scripts/live-release-core.mjs \
  scripts/live-release-core.test.mjs \
  scripts/run-live-hardware-release.mjs \
  scripts/run-live-hardware-release.test.mjs \
  scripts/validate-hardware-release-evidence.mjs \
  scripts/validate-hardware-release-evidence.test.mjs \
  README.md
fnm exec --using=22.23.1 npm test
fnm exec --using=22.23.1 npm run typecheck
fnm exec --using=22.23.1 npm run schemas:check
fnm exec --using=22.23.1 npm run docs:check
fnm exec --using=22.23.1 npm run package:check
```

Expected: all tests and five gates pass.

- [ ] **Step 4: Commit documentation and final integration**

```sh
git add tools/jetkvm-mcp/README.md tools/jetkvm-mcp/scripts
git commit -m "docs(release): disclose ATX hardware exception"
```

- [ ] **Step 5: Obtain fresh review and exact-head CI**

Push `feat/jetkvm-mcp-hardware-release`. Request release-safety and evidence-integrity review of the complete exception diff. Resolve all P0/P1 findings, rerun affected focused/full gates, and require exact-head GitHub Actions success.

- [ ] **Step 6: Freeze and install a new ATX-unavailable candidate**

Use exact Node 22.23.1 and the two profile environment variables. The candidate must be schema v2, bind `hardware_validation.profile === "atx_unavailable"`, and have a verified `candidate.sha256`. Rebuild/download the native device artifact from the exact reviewed head, install only from the frozen consumer lock, and verify the installed package closure before import.

- [ ] **Step 7: Execute and validate the real non-ATX hardware release**

Run the installed lease wrapper once with the frozen candidate. Require:

- exact reviewed device deployment and Go-test evidence;
- every non-ATX step, story baseline, and restore passes serially;
- exactly 17 exclusions and no physical power dispatch;
- producer-zero release, fresh transport proof, final device integrity, safe fixture baseline, and released lease;
- immutable evidence directory with `summary.result === "pass_with_exception"` and a validator-clean `hardware-exception.json`.

- [ ] **Step 8: Merge, release, and clean-download verify**

Merge only the reviewed candidate tree, tag `jetkvm-mcp-v0.1.0`, attach the exact tarball/checksum/candidate/hardware manifest, and prominently disclose the physical ATX validation gap. From a fresh checkout and empty install, verify checksums, consumer-lock installation, exactly ten tools, installed stdio/SSE smokes, docs/schema/package gates, and no device access from offline checks.
