import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { JETKVM_TOOL_NAMES } from "../domain.ts";

export const ACCEPTANCE_STORY_SCHEMA_NAME = "AcceptanceStory";

export const CANONICAL_STORY_IDS = [
  "session-connect-without-takeover-busy",
  "session-explicit-authorized-takeover",
  "session-reconnect-invalidates-observations",
  "display-capture-fresh-frame-and-geometry",
  "display-status-resolution-and-read-only-edid",
  "mouse-observation-fence-and-single-use",
  "keyboard-physical-keys-only",
  "reliable-paste-91cps-correlated-terminal",
  "emergency-release-races-every-writer",
  "power-three-semantic-actions",
  "disconnect-before-write-not-sent",
  "disconnect-after-write-unknown-no-replay",
  "duplicate-request-id-definitive-replay",
  "malformed-response-fails-closed",
  "permission-and-capability-errors-actionable",
  "stale-generation-zero-downstream-write",
  "partial-verification-does-not-replay",
  "transport-reconnect-does-not-own-device",
  "display-status-cached-freshness-and-streaming-omission",
  "edid-low-level-failure-propagates",
  "reconnect-requires-new-channel-observations",
  "atx-extension-serialization-idempotency-and-nonproof",
  "sse-get-and-post-share-http-security-boundary",
  "sse-session-id-is-routing-not-authentication",
] as const;

export const BEHAVIOR_REQUIREMENT_IDS = [
  "branch:strict-schema-rejection",
  "branch:permission-denied",
  "branch:capability-missing",
  "branch:deadline-before-admission",
  "branch:cancellation-before-write",
  "branch:disconnect-before-write",
  "branch:disconnect-after-write",
  "branch:malformed-downstream-response",
  "branch:stale-session-generation",
  "branch:busy-without-takeover",
  "branch:authorized-takeover",
  "branch:unauthorized-takeover",
  "branch:definitive-acknowledgement",
  "branch:duplicate-same-request-digest",
  "branch:duplicate-changed-digest",
  "branch:partial-verification",
  "branch:partial-multi-event-dispatch",
  "branch:post-reconnect-input-without-capture",
  "branch:cleanup-failure",
  "branch:per-fact-status-provenance",
  "branch:edid-capability-absent",
  "branch:edid-successful-empty",
  "branch:edid-lower-layer-failure",
  "branch:reconnect-evidence",
  "branch:atx-gate-and-serialization",
  "branch:atx-acknowledgement-semantics",
  "branch:sse-route-security",
  "branch:sse-routing-close",
  "branch:shared-device-rpc-adapter-binding",
  "branch:device-rpc-adapter-replacement",
  "branch:device-rpc-adapter-mid-flight-loss",
  "branch:scroll-validation",
] as const;

const storyConditionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1),
    required: z.literal(true),
  })
  .strict();

const faultStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    after_step: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .nullable(),
    boundary: z.enum([
      "before_admission",
      "queued",
      "before_write",
      "after_write",
      "after_acknowledgement",
      "during_verification",
      "during_cleanup",
      "transport_route",
    ]),
    action: z.string().min(1),
    expected_effect: z.string().min(1),
  })
  .strict();

const storyStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    tool: z.enum(JETKVM_TOOL_NAMES).nullable(),
    call: z.string().min(1),
    input: z.record(z.unknown()),
    timeout_ms: z.number().int().min(100).max(300_000).nullable(),
    expect: z.string().min(1),
  })
  .strict();

const storyAssertionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    requirement: z
      .string()
      .regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    assertion: z.string().min(1),
  })
  .strict();

const evidenceFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    requirement: z
      .string()
      .regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    field: z.enum([
      "requirement_result",
      "source_hash",
      "artifact_hash",
      "sanitized_version",
      "opaque_identifier",
      "generation_identifier",
      "dimensions",
      "count",
      "duration_ms",
      "outcome",
      "verification",
      "acknowledgement_step",
      "first_mismatch_index",
      "normalized_payload_hash",
      "restore_result",
      "http_status",
    ]),
    source: z.string().min(1),
    retention: z.enum(["test_run", "release_manifest"]),
  })
  .strict();

const restoreStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    action: z.string().min(1),
    assertion: z.string().min(1),
    always: z.literal(true),
  })
  .strict();

const privacyRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    rule: z.string().min(1),
    prohibited: z
      .array(
        z.enum([
          "bearer_tokens",
          "cookies",
          "credentials",
          "headers",
          "lease_proofs",
          "network_topology",
          "raw_payloads",
          "screenshots",
          "sdp_ice",
          "secrets",
          "serial_edid",
          "stack_traces",
          "target_contents",
        ]),
      )
      .min(1),
    always: z.literal(true),
  })
  .strict();

export const acceptanceStorySchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Story IDs must be lowercase kebab-case",
      ),
    title: z.string().min(1),
    requirements: z
      .array(z.string().regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/))
      .min(1),
    tools: z.array(z.enum(JETKVM_TOOL_NAMES)).min(1),
    environments: z.array(z.enum(["fake", "replay", "live"])).min(1),
    preconditions: z.array(storyConditionSchema).min(1),
    fault_script: z.array(faultStepSchema).min(1),
    steps: z.array(storyStepSchema).min(1),
    pass: z.array(storyAssertionSchema).min(1),
    evidence: z.array(evidenceFieldSchema).min(1),
    restore: z.array(restoreStepSchema).min(1),
    privacy: z.array(privacyRuleSchema).min(1),
  })
  .strict();

export type AcceptanceStory = z.infer<typeof acceptanceStorySchema>;

const BEHAVIOR_REQUIREMENT_LOOKUP: Readonly<Record<string, true>> =
  Object.freeze(
    Object.fromEntries(
      BEHAVIOR_REQUIREMENT_IDS.map((requirement) => [requirement, true]),
    ) as Record<string, true>,
  );

const REQUIRED_RESTORE_IDS = [
  "release-input",
  "stop-paste",
  "zero-held-input",
  "close-story-session",
  "reset-fixture",
] as const;

const REQUIRED_PRIVACY_PROHIBITIONS = [
  "bearer_tokens",
  "cookies",
  "credentials",
  "headers",
  "lease_proofs",
  "network_topology",
  "raw_payloads",
  "screenshots",
  "sdp_ice",
  "secrets",
  "serial_edid",
  "stack_traces",
  "target_contents",
] as const;

const REQUIRED_STORY_OWNERS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "branch:per-fact-status-provenance": [CANONICAL_STORY_IDS[18]],
    "branch:edid-capability-absent": [CANONICAL_STORY_IDS[4]],
    "branch:edid-successful-empty": [CANONICAL_STORY_IDS[4]],
    "branch:edid-lower-layer-failure": [CANONICAL_STORY_IDS[19]],
    "branch:shared-device-rpc-adapter-binding": [CANONICAL_STORY_IDS[20]],
    "branch:device-rpc-adapter-replacement": [CANONICAL_STORY_IDS[20]],
    "branch:device-rpc-adapter-mid-flight-loss": [
      CANONICAL_STORY_IDS[18],
      CANONICAL_STORY_IDS[21],
    ],
    "branch:atx-gate-and-serialization": [CANONICAL_STORY_IDS[21]],
    "branch:atx-acknowledgement-semantics": [CANONICAL_STORY_IDS[21]],
    "branch:scroll-validation": [CANONICAL_STORY_IDS[5]],
  });

const PLACEHOLDER_PATTERN =
  /\b(?:deferred (?:field|implementation|requirement|step|story|work)|fill (?:this|it) later|not implemented|placeholder|tbd|todo)\b/i;
const FIXED_TOPOLOGY_OR_SECRET_PATTERN =
  /(?:https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|invalid)\b|(?:bearer[_ -]?token|cookie|credential|password|secret)\s*[=:]\s*\S+)/i;
const MODEL_VISIBLE_SECRET_FIELD_PATTERN =
  /"(?:bearer_token|cookie|cookies|credential|credentials|password|secret|token|url)"\s*:/i;

function assertUniqueIds(story: AcceptanceStory): void {
  const collections = [
    ["precondition", story.preconditions],
    ["fault", story.fault_script],
    ["step", story.steps],
    ["pass assertion", story.pass],
    ["evidence", story.evidence],
    ["restore", story.restore],
    ["privacy", story.privacy],
  ] as const;

  for (const [label, values] of collections) {
    const ids = values.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Story ${story.id} has a duplicate ${label} id`);
    }
  }
}

function assertCompleteReferences(story: AcceptanceStory): void {
  const tools = new Set(story.tools);
  for (const step of story.steps) {
    if (step.tool !== null && !tools.has(step.tool)) {
      throw new Error(
        `Story ${story.id} step tool ${step.tool} is absent from its tool reference list`,
      );
    }
    if (step.tool !== null && step.timeout_ms === null) {
      throw new Error(
        `Story ${story.id} tool step ${step.id} has no bounded timeout`,
      );
    }
  }

  const stepIds = new Set(story.steps.map(({ id }) => id));
  for (const fault of story.fault_script) {
    if (fault.after_step !== null && !stepIds.has(fault.after_step)) {
      throw new Error(
        `Story ${story.id} fault ${fault.id} references an unknown step`,
      );
    }
  }

  const requirements = new Set(story.requirements);
  for (const requirement of requirements) {
    if (
      requirement.startsWith("branch:") &&
      BEHAVIOR_REQUIREMENT_LOOKUP[requirement] !== true
    ) {
      throw new Error(
        `Story ${story.id} has an incomplete requirement reference: ${requirement}`,
      );
    }
    if (
      !story.pass.some((assertion) => assertion.requirement === requirement)
    ) {
      throw new Error(
        `Story ${story.id} requirement ${requirement} has no pass assertion`,
      );
    }
    if (!story.evidence.some((field) => field.requirement === requirement)) {
      throw new Error(
        `Story ${story.id} requirement ${requirement} has no evidence row`,
      );
    }
  }

  for (const reference of [...story.pass, ...story.evidence]) {
    if (!requirements.has(reference.requirement)) {
      throw new Error(
        `Story ${story.id} has a requirement reference not declared by the story`,
      );
    }
  }
}

function assertSafetyPolicy(story: AcceptanceStory): void {
  const restoreIds = new Set(story.restore.map(({ id }) => id));
  if (REQUIRED_RESTORE_IDS.some((id) => !restoreIds.has(id))) {
    throw new Error(
      `Story ${story.id} lacks the complete unconditional restore sequence`,
    );
  }
  if (
    story.id === "power-three-semantic-actions" &&
    !story.restore.some(({ id }) => id === "restore-power-baseline")
  ) {
    throw new Error(
      `Story ${story.id} lacks unconditional power-baseline restoration`,
    );
  }

  const prohibited = new Set(story.privacy.flatMap((rule) => rule.prohibited));
  if (REQUIRED_PRIVACY_PROHIBITIONS.some((field) => !prohibited.has(field))) {
    throw new Error(
      `Story ${story.id} lacks a complete unconditional privacy policy`,
    );
  }

  const serialized = JSON.stringify(story);
  if (PLACEHOLDER_PATTERN.test(serialized)) {
    throw new Error(`Story ${story.id} contains placeholder or deferred text`);
  }
  if (
    FIXED_TOPOLOGY_OR_SECRET_PATTERN.test(serialized) ||
    MODEL_VISIBLE_SECRET_FIELD_PATTERN.test(serialized)
  ) {
    throw new Error(
      `Story ${story.id} contains fixed network topology or credential/secret material`,
    );
  }
}

export function validateAcceptanceStories(
  values: readonly unknown[],
): AcceptanceStory[] {
  const stories = values.map((value) => acceptanceStorySchema.parse(value));
  const actualIds = stories.map(({ id }) => id);

  if (actualIds.some((id) => id !== id.toLowerCase())) {
    throw new Error("Acceptance story IDs must be lowercase");
  }
  if (
    actualIds.length !== CANONICAL_STORY_IDS.length ||
    actualIds.some((id, index) => id !== CANONICAL_STORY_IDS[index])
  ) {
    throw new Error(
      "Manifest must contain the exact canonical story IDs once, in canonical order",
    );
  }

  for (const story of stories) {
    assertUniqueIds(story);
    assertCompleteReferences(story);
    assertSafetyPolicy(story);
  }

  const mappedByRequirement: Record<string, string[]> = Object.fromEntries(
    BEHAVIOR_REQUIREMENT_IDS.map((requirement) => [requirement, []]),
  );
  for (const story of stories) {
    for (const requirement of story.requirements) {
      if (requirement.startsWith("branch:")) {
        mappedByRequirement[requirement]!.push(story.id);
      }
    }
  }

  const unmapped = BEHAVIOR_REQUIREMENT_IDS.filter(
    (requirement) => mappedByRequirement[requirement]!.length === 0,
  );
  if (unmapped.length > 0) {
    throw new Error(
      `Manifest has unmapped behavior requirement rows: ${unmapped.join(", ")}`,
    );
  }

  for (const [requirement, expectedOwners] of Object.entries(
    REQUIRED_STORY_OWNERS,
  )) {
    const actualOwners = mappedByRequirement[requirement] ?? [];
    if (
      actualOwners.length !== expectedOwners.length ||
      actualOwners.some((owner, index) => owner !== expectedOwners[index])
    ) {
      throw new Error(
        `Manifest story ownership for ${requirement} must be ${expectedOwners.join(", ")}`,
      );
    }
  }

  const referencedTools = new Set(stories.flatMap(({ tools }) => tools));
  if (JETKVM_TOOL_NAMES.some((tool) => !referencedTools.has(tool))) {
    throw new Error(
      "Manifest does not contain a complete exact-ten tool reference inventory",
    );
  }

  return stories;
}

export async function loadAcceptanceStories(
  directory: string,
): Promise<AcceptanceStory[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(({ name }) => name)
    .sort();
  const expectedFiles = CANONICAL_STORY_IDS.map(
    (id, index) => `${String(index + 1).padStart(2, "0")}-${id}.json`,
  );

  if (
    entries.length !== expectedFiles.length ||
    entries.some((name, index) => name !== expectedFiles[index])
  ) {
    throw new Error(
      "Story directory must contain exactly the 24 canonical numbered JSON files",
    );
  }

  const parsed = await Promise.all(
    entries.map(
      async (name) =>
        JSON.parse(await readFile(resolve(directory, name), "utf8")) as unknown,
    ),
  );
  return validateAcceptanceStories(parsed);
}
