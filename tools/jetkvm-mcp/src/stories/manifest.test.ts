import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_STORY_SCHEMA_NAME,
  BEHAVIOR_REQUIREMENT_IDS,
  CANONICAL_STORY_IDS,
  acceptanceStorySchema,
  loadAcceptanceStories,
  validateAcceptanceStories,
  type AcceptanceStory,
} from "./manifest.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const storiesDirectory = import.meta.dirname;
const generatedSchemaPath = resolve(
  packageRoot,
  "schemas/story-manifest.schema.json",
);

function makeStory(overrides: Partial<AcceptanceStory> = {}): AcceptanceStory {
  const requirement = "branch:strict-schema-rejection";
  return {
    id: CANONICAL_STORY_IDS[0],
    title: "A complete acceptance story",
    requirements: [requirement],
    tools: ["jetkvm_session_connect"],
    environments: ["fake", "replay", "live"],
    preconditions: [
      {
        id: "configured-device",
        description:
          "An operator-configured device fixture is available under the outer lease.",
        required: true,
      },
    ],
    fault_script: [
      {
        id: "reject-before-dispatch",
        after_step: null,
        boundary: "before_admission",
        action:
          "Submit a schema-invalid request before any controller admission.",
        expected_effect:
          "The request is rejected before any controller or plane call.",
      },
    ],
    steps: [
      {
        id: "call-connect",
        tool: "jetkvm_session_connect",
        call: "tools/call",
        input: { request_id: "opaque-request", timeout_ms: 1_000 },
        timeout_ms: 1_000,
        expect: "A protocol schema rejection with zero downstream calls.",
      },
    ],
    pass: [
      {
        id: "schema-rejected",
        requirement,
        assertion: "The controller and both planes record zero calls.",
      },
    ],
    evidence: [
      {
        id: "schema-rejection-evidence",
        requirement,
        field: "requirement_result",
        source: "The focused handler assertion and fake plane event count.",
        retention: "release_manifest",
      },
    ],
    restore: [
      {
        id: "release-input",
        action:
          "Invoke generation-correlated emergency input release when a session exists.",
        assertion:
          "No held key, button, wheel producer, or paste producer remains.",
        always: true,
      },
      {
        id: "stop-paste",
        action: "Stop and join any Reliable Paste producer.",
        assertion: "Reliable Paste is inactive.",
        always: true,
      },
      {
        id: "zero-held-input",
        action: "Verify the fixture reports zero held keys and buttons.",
        assertion: "Held input state is empty.",
        always: true,
      },
      {
        id: "close-story-session",
        action: "Close only the device session created by this story.",
        assertion: "No story-owned browser or device session remains.",
        always: true,
      },
      {
        id: "reset-fixture",
        action: "Reset deterministic faults and restore the fixture baseline.",
        assertion: "The next story starts from the recorded safe baseline.",
        always: true,
      },
    ],
    privacy: [
      {
        id: "privacy-safe-evidence",
        rule: "Persist only allowlisted opaque identifiers, counts, durations, hashes, and result classifications.",
        prohibited: [
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
        ],
        always: true,
      },
    ],
    ...overrides,
  };
}

function makeCanonicalSet(story: AcceptanceStory): AcceptanceStory[] {
  return CANONICAL_STORY_IDS.map((id, index) => {
    const canonicalStory = {
      ...structuredClone(story),
      id,
      title: `Canonical story ${index + 1}`,
    };
    if (id === "power-three-semantic-actions") {
      canonicalStory.restore.push({
        id: "restore-power-baseline",
        action: "Restore the recorded safe ATX-observable baseline.",
        assertion: "The baseline ATX-observable state is proven.",
        always: true,
      });
    }
    return canonicalStory;
  });
}

describe("AcceptanceStory schema", () => {
  it("rejects an unknown top-level field", () => {
    const story = { ...makeStory(), deferred: true };
    expect(() => acceptanceStorySchema.parse(story)).toThrow(
      /unrecognized key/i,
    );
  });

  it("rejects an unknown nested field", () => {
    const story = makeStory();
    const condition = story.preconditions[0];
    expect(condition).toBeDefined();
    const candidate = {
      ...story,
      preconditions: [{ ...condition, topology: "lab-device" }],
    };
    expect(() => acceptanceStorySchema.parse(candidate)).toThrow(
      /unrecognized key/i,
    );
  });

  it("rejects placeholder and deferred text", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = { ...stories[0]!, title: "TODO fill this later" };
    expect(() => validateAcceptanceStories(stories)).toThrow(/placeholder/i);
  });
});

describe("manifest invariants", () => {
  it("rejects a missing, extra, renamed, or duplicate canonical ID", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[23] = { ...stories[23]!, id: stories[0]!.id };
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /canonical story ids/i,
    );

    stories[23] = { ...stories[23]!, id: "story25" };
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /canonical story ids/i,
    );
  });

  it("rejects non-lowercase story IDs", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = {
      ...stories[0]!,
      id: "Session-Connect-Without-Takeover-Busy",
    };
    expect(() => validateAcceptanceStories(stories)).toThrow(/lowercase/i);
  });

  it("rejects incomplete tool and requirement references", () => {
    const missingTool = makeCanonicalSet(makeStory());
    missingTool[0] = { ...missingTool[0]!, tools: ["jetkvm_session_status"] };
    expect(() => validateAcceptanceStories(missingTool)).toThrow(/step tool/i);

    const missingRequirement = makeCanonicalSet(makeStory());
    missingRequirement[0] = {
      ...missingRequirement[0]!,
      requirements: ["branch:not-canonical"],
      pass: [
        {
          id: "invalid-requirement-pass",
          requirement: "branch:not-canonical",
          assertion: "Rejected.",
        },
      ],
      evidence: [
        {
          id: "invalid-requirement-evidence",
          requirement: "branch:not-canonical",
          field: "requirement_result",
          source: "Focused assertion.",
          retention: "release_manifest",
        },
      ],
    };
    expect(() => validateAcceptanceStories(missingRequirement)).toThrow(
      /requirement reference/i,
    );
  });

  it("rejects a step tool omitted from the story tool inventory", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = { ...stories[0]!, tools: ["jetkvm_session_status"] };
    expect(() => validateAcceptanceStories(stories)).toThrow(/step tool/i);
  });

  it("rejects duplicate nested IDs, unknown fault step references, and unbounded tool steps", () => {
    const duplicateIds = makeCanonicalSet(makeStory());
    duplicateIds[0]!.pass.push({ ...duplicateIds[0]!.pass[0]! });
    expect(() => validateAcceptanceStories(duplicateIds)).toThrow(
      /duplicate pass assertion id/i,
    );

    const unknownFaultStep = makeCanonicalSet(makeStory());
    unknownFaultStep[0]!.fault_script[0] = {
      ...unknownFaultStep[0]!.fault_script[0]!,
      after_step: "unknown-step",
    };
    expect(() => validateAcceptanceStories(unknownFaultStep)).toThrow(
      /references an unknown step/i,
    );

    const unboundedStep = makeCanonicalSet(makeStory());
    unboundedStep[0]!.steps[0] = {
      ...unboundedStep[0]!.steps[0]!,
      timeout_ms: null,
    };
    expect(() => validateAcceptanceStories(unboundedStep)).toThrow(
      /no bounded timeout/i,
    );
  });

  it("rejects pass and evidence references not declared by the story", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0]!.pass.push({
      id: "undeclared-pass-reference",
      requirement: "contract:undeclared",
      assertion: "This reference is not declared.",
    });
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /reference not declared/i,
    );
  });

  it("rejects requirements without pass assertions or evidence", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = {
      ...stories[0]!,
      requirements: ["branch:strict-schema-rejection", "contract:fresh-frame"],
    };
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /pass assertion|evidence/i,
    );
  });

  it("rejects missing or conditional restoration", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = {
      ...stories[0]!,
      restore: stories[0]!.restore.filter(({ id }) => id !== "release-input"),
    };
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /unconditional restore/i,
    );

    const conditional = structuredClone(stories[1]!);
    conditional.restore[0] = {
      ...conditional.restore[0]!,
      always: false as true,
    };
    expect(() =>
      validateAcceptanceStories([conditional, ...stories.slice(1)]),
    ).toThrow();
  });

  it("requires unconditional power-baseline restoration for the power story", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[9]!.restore = stories[9]!.restore.filter(
      ({ id }) => id !== "restore-power-baseline",
    );
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /power-baseline restoration/i,
    );
  });

  it("rejects missing or conditional privacy policy", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0] = { ...stories[0]!, privacy: [] };
    expect(() => validateAcceptanceStories(stories)).toThrow(/privacy/i);

    const conditional = structuredClone(stories[1]!);
    conditional.privacy[0] = {
      ...conditional.privacy[0]!,
      always: false as true,
    };
    expect(() =>
      validateAcceptanceStories([conditional, ...stories.slice(1)]),
    ).toThrow();
  });

  it("rejects fixed URLs, IP addresses, hostnames, and credentials anywhere in a story", () => {
    const forbidden = [
      "Connect to https://device.example.invalid.",
      "Connect to 192.0.2.10.",
      "Connect to jetkvm-lab.local.",
      "Use bearer_token=secret-value.",
    ];

    for (const title of forbidden) {
      const stories = makeCanonicalSet(makeStory());
      stories[0] = { ...stories[0]!, title };
      expect(() => validateAcceptanceStories(stories), title).toThrow(
        /topology|credential|secret/i,
      );
    }
  });

  it("rejects model-visible URL and credential fields even when their values are opaque", () => {
    const stories = makeCanonicalSet(makeStory());
    stories[0]!.steps[0] = {
      ...stories[0]!.steps[0]!,
      input: { credential: "opaque-credential-reference", timeout_ms: 1_000 },
    };
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /credential|secret/i,
    );
  });

  it("rejects every unmapped canonical behavior requirement", () => {
    const stories = makeCanonicalSet(makeStory());
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /unmapped behavior requirement/i,
    );
  });

  it("rejects behavior rows folded into the wrong canonical story", async () => {
    const misplaced = [
      ["branch:per-fact-status-provenance", CANONICAL_STORY_IDS[0]],
      ["branch:edid-capability-absent", CANONICAL_STORY_IDS[19]],
      ["branch:edid-successful-empty", CANONICAL_STORY_IDS[19]],
      ["branch:edid-lower-layer-failure", CANONICAL_STORY_IDS[4]],
      ["branch:shared-device-rpc-adapter-binding", CANONICAL_STORY_IDS[18]],
      ["branch:device-rpc-adapter-replacement", CANONICAL_STORY_IDS[18]],
      ["branch:device-rpc-adapter-mid-flight-loss", CANONICAL_STORY_IDS[20]],
      ["branch:atx-gate-and-serialization", CANONICAL_STORY_IDS[20]],
      ["branch:scroll-validation", CANONICAL_STORY_IDS[4]],
    ] as const;

    for (const [requirement, storyId] of misplaced) {
      const stories = await loadAcceptanceStories(storiesDirectory);
      const storyIndex = CANONICAL_STORY_IDS.indexOf(storyId);
      const story = stories[storyIndex]!;
      story.requirements.push(requirement);
      story.pass.push({
        id: `misplaced-pass-${storyIndex}`,
        requirement,
        assertion: "An observable misplaced assertion.",
      });
      story.evidence.push({
        id: `misplaced-evidence-${storyIndex}`,
        requirement,
        field: "requirement_result",
        source: "A misplaced focused assertion.",
        retention: "release_manifest",
      });
      expect(() => validateAcceptanceStories(stories), requirement).toThrow(
        /story ownership/i,
      );
    }
  });

  it("rejects a manifest that does not reference the complete exact-ten tool catalogue", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const story of stories) {
      story.tools = story.tools.map((tool) =>
        tool === "jetkvm_power_control" ? "jetkvm_input_release" : tool,
      );
      story.steps = story.steps.map((storyStep) => ({
        ...storyStep,
        tool:
          storyStep.tool === "jetkvm_power_control"
            ? "jetkvm_input_release"
            : storyStep.tool,
      }));
    }
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /exact-ten tool reference inventory/i,
    );
  });
});

it("rejects a story directory with any noncanonical filename", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "jetkvm-story-files-"));
  try {
    await writeFile(resolve(directory, "01-story25.json"), "{}\n");
    await expect(loadAcceptanceStories(directory)).rejects.toThrow(
      /exactly the 24 canonical numbered JSON files/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("canonical story files", () => {
  it("loads and validates exactly the 24 canonical stories with every behavior row mapped", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    expect(stories.map(({ id }) => id)).toEqual([...CANONICAL_STORY_IDS]);
    expect(stories).toHaveLength(24);

    const mappedRequirements = new Set(
      stories.flatMap(({ requirements }) => requirements),
    );
    expect(
      BEHAVIOR_REQUIREMENT_IDS.every((id) => mappedRequirements.has(id)),
    ).toBe(true);
  });

  it("matches the one tracked JSON Schema generated from the strict Zod type", async () => {
    const expected = `${JSON.stringify(
      zodToJsonSchema(acceptanceStorySchema, {
        name: ACCEPTANCE_STORY_SCHEMA_NAME,
        $refStrategy: "root",
      }),
      null,
      2,
    )}\n`;
    await expect(readFile(generatedSchemaPath, "utf8")).resolves.toBe(expected);
  });
});
