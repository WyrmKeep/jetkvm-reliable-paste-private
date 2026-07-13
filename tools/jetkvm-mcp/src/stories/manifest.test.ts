import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";

import { JETKVM_TOOL_NAMES } from "../domain.js";
import * as storyManifest from "./manifest.js";

import {
  ACCEPTANCE_STORY_SCHEMA_NAME,
  BEHAVIOR_REQUIREMENT_IDS,
  CANONICAL_STORY_IDS,
  TOOL_BEHAVIOR_MATRIX,
  acceptanceStorySchema,
  loadAcceptanceStories,
  validateAcceptanceStories,
  type AcceptanceStory,
  type FocusedAssertionOwnerPhase,
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

  it("rejects a declared branch requirement without a linked real call", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const story = stories[1]!;
    const requirement = "branch:deadline-before-admission";
    story.requirements.push(requirement);
    story.pass.push({
      id: "unlinked-deadline-pass",
      requirement,
      assertion: "This assertion has no executable call linked to this story.",
    });
    story.evidence.push({
      id: "unlinked-deadline-evidence",
      requirement,
      field: "requirement_result",
      source: "No linked call exists.",
      retention: "release_manifest",
    });

    expect(() => validateAcceptanceStories(stories)).toThrow(
      /declared requirement.*linked executable call/i,
    );
  });

  it("rejects every matrix-owned story when one of its linked calls is missing", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const story of stories) {
      const linkedCell = TOOL_BEHAVIOR_MATRIX.flatMap((row) =>
        Object.values(row.cells),
      ).find(
        (cell) =>
          cell.applicability === "applicable" && cell.story_id === story.id,
      );
      if (linkedCell?.applicability !== "applicable") {
        continue;
      }
      const malformed = structuredClone(stories);
      const malformedStory = malformed.find(
        ({ id }) => id === linkedCell.story_id,
      )!;
      malformedStory.steps = malformedStory.steps.filter(
        ({ id }) => id !== linkedCell.step_id,
      );

      expect(() => validateAcceptanceStories(malformed), story.id).toThrow(
        /too_small|too small|references an unknown step|linked executable call|executable call.*fault boundary/i,
      );
    }
  });

  it("rejects mutation outcomes in read-tool response envelopes", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const row = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) => requirement === "branch:deadline-before-admission",
    )!;
    const cell = row.cells.jetkvm_display_capture;
    expect(cell.applicability).toBe("applicable");
    if (cell.applicability !== "applicable") {
      return;
    }
    const story = stories.find(({ id }) => id === cell.story_id)!;
    const step = story.steps.find(({ id }) => id === cell.step_id)!;
    step.expect =
      "unknown after a possible downstream write with mutation replay suppressed.";

    expect(() => validateAcceptanceStories(stories)).toThrow(
      /read tool.*mutation outcome/i,
    );
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

describe("every-handler behavior matrix", () => {
  it("is exactly 32 behavior rows by the exact-ten public tools", () => {
    expect(TOOL_BEHAVIOR_MATRIX).toHaveLength(BEHAVIOR_REQUIREMENT_IDS.length);
    expect(TOOL_BEHAVIOR_MATRIX.map(({ requirement }) => requirement)).toEqual([
      ...BEHAVIOR_REQUIREMENT_IDS,
    ]);
    for (const row of TOOL_BEHAVIOR_MATRIX) {
      expect(Object.keys(row.cells)).toEqual([...JETKVM_TOOL_NAMES]);
    }
  });

  it("records every cell as either executable coverage or a reviewed N/A", () => {
    const cells = TOOL_BEHAVIOR_MATRIX.flatMap((row) =>
      Object.values(row.cells),
    );
    expect(cells).toHaveLength(32 * 10);
    expect(
      cells.filter(({ applicability }) => applicability === "applicable"),
    ).toHaveLength(193);
    expect(
      cells.filter(({ applicability }) => applicability === "not_applicable"),
    ).toHaveLength(127);
  });

  it("reviews release partial verification as inapplicable", () => {
    const row = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) => requirement === "branch:partial-verification",
    )!;
    const cell = row.cells.jetkvm_input_release;
    expect(cell.applicability).toBe("not_applicable");
    if (cell.applicability === "not_applicable") {
      expect(cell.rationale).toMatch(
        /device_state_verified|verified device state/i,
      );
    }
  });

  it("gives every applicable cell a stable focused assertion ID and an explicit coverage scope", () => {
    const ids: string[] = [];
    for (const row of TOOL_BEHAVIOR_MATRIX) {
      for (const cell of Object.values(row.cells)) {
        if (cell.applicability !== "applicable") {
          continue;
        }
        const link = cell as unknown as Record<string, unknown>;
        expect(link.coverage_scope).toMatch(/^(?:tool|shared_transport)$/);
        expect(link.focused_assertion_id).toMatch(
          /^(?:unit|adapter|transport):[a-z0-9-]+(?::[a-z0-9-]+)+$/,
        );
        ids.push(cell.focused_assertion_id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks Phase 2 focused IDs as reservations owned by the implementing phase", () => {
    const toolOwnerPhase: Record<
      (typeof JETKVM_TOOL_NAMES)[number],
      FocusedAssertionOwnerPhase
    > = {
      jetkvm_display_capture: "phase_3",
      jetkvm_display_status: "phase_3",
      jetkvm_input_keyboard: "phase_3",
      jetkvm_input_mouse: "phase_3",
      jetkvm_input_paste: "phase_3",
      jetkvm_input_release: "phase_3",
      jetkvm_power_control: "phase_4",
      jetkvm_session_connect: "phase_4",
      jetkvm_session_reconnect: "phase_4",
      jetkvm_session_status: "phase_4",
    };

    for (const row of TOOL_BEHAVIOR_MATRIX) {
      for (const tool of JETKVM_TOOL_NAMES) {
        const cell = row.cells[tool];
        if (cell.applicability !== "applicable") {
          continue;
        }
        expect(cell.focused_assertion_phase_2_status).toBe("reserved");
        expect(cell.focused_assertion_owner_phase).toBe(
          cell.coverage_scope === "shared_transport"
            ? "phase_5"
            : toolOwnerPhase[tool],
        );
      }
    }
  });

  it("does not expose an ungrounded owning-phase or release registration gate", () => {
    expect("validateFocusedAssertionRegistrations" in storyManifest).toBe(
      false,
    );
    expect("FOCUSED_ASSERTION_GATES" in storyManifest).toBe(false);
  });

  it("links serialized cells to compatible per-tool faults", () => {
    const deadline = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) => requirement === "branch:deadline-before-admission",
    )!;
    for (const tool of JETKVM_TOOL_NAMES) {
      const cell = deadline.cells[tool];
      expect(cell.applicability).toBe("applicable");
      if (cell.applicability === "applicable") {
        const slug = tool.replaceAll("_", "-");
        expect(cell.step_id).toBe(`deadline-before-admission-${slug}`);
        expect(cell.fault_id).toBe(`expire-before-admission-${slug}`);
      }
    }

    const cancellation = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) => requirement === "branch:cancellation-before-write",
    )!;
    for (const tool of JETKVM_TOOL_NAMES) {
      const cell = cancellation.cells[tool];
      expect(cell.applicability).toBe("applicable");
      if (cell.applicability !== "applicable") {
        continue;
      }
      const slug = tool.replaceAll("_", "-");
      expect(cell.step_id).toBe(
        tool === "jetkvm_input_keyboard"
          ? "cancel-physical-key-before-write"
          : tool === "jetkvm_input_paste"
            ? "paste-cancel-before-acceptance"
            : `cancel-before-write-${slug}`,
      );
      expect(cell.fault_id).toBe(
        tool === "jetkvm_input_keyboard"
          ? "cancel-keyboard-before-write"
          : tool === "jetkvm_input_paste"
            ? "cancel-before-paste-acceptance"
            : `cancel-before-write-${slug}`,
      );
    }

    const cleanup = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) => requirement === "branch:cleanup-failure",
    )!;
    for (const tool of [
      "jetkvm_input_keyboard",
      "jetkvm_input_mouse",
      "jetkvm_input_paste",
      "jetkvm_input_release",
      "jetkvm_power_control",
      "jetkvm_session_connect",
      "jetkvm_session_reconnect",
    ] as const) {
      const cell = cleanup.cells[tool];
      expect(cell.applicability).toBe("applicable");
      if (cell.applicability === "applicable") {
        const slug = tool.replaceAll("_", "-");
        expect(cell.step_id).toBe(`cleanup-failure-${slug}`);
        expect(cell.fault_id).toBe(`arm-cleanup-failure-${slug}`);
      }
    }
  });

  it("links keyboard partial dispatch to its faulted two-action call", async () => {
    const row = TOOL_BEHAVIOR_MATRIX.find(
      ({ requirement }) =>
        requirement === "branch:partial-multi-event-dispatch",
    )!;
    const cell = row.cells.jetkvm_input_keyboard;
    expect(cell.applicability).toBe("applicable");
    if (cell.applicability !== "applicable") {
      return;
    }
    expect(cell.step_id).toBe("send-partial-physical-keys");
    expect(cell.fault_id).toBe("interrupt-key-sequence");

    const stories = await loadAcceptanceStories(storiesDirectory);
    const story = stories[6]!;
    const fault = story.fault_script.find(
      ({ id }) => id === "interrupt-key-sequence",
    )!;
    fault.after_step = "send-partial-physical-keys";
    expect(() => validateAcceptanceStories(stories)).toThrow(
      /partial multi-event.*armed immediately before.*linked call/i,
    );
  });

  it("rejects a deadline or cancellation fault armed after its linked call", async () => {
    for (const requirement of [
      "branch:deadline-before-admission",
      "branch:cancellation-before-write",
    ] as const) {
      const stories = await loadAcceptanceStories(storiesDirectory);
      const row = TOOL_BEHAVIOR_MATRIX.find(
        (candidate) => candidate.requirement === requirement,
      )!;
      const cell = row.cells.jetkvm_display_capture;
      expect(cell.applicability).toBe("applicable");
      if (cell.applicability !== "applicable") {
        continue;
      }
      const story = stories.find(({ id }) => id === cell.story_id)!;
      const fault = story.fault_script.find(({ id }) => id === cell.fault_id)!;
      fault.after_step = cell.step_id;

      expect(() => validateAcceptanceStories(stories), requirement).toThrow(
        /fault.*armed.*before.*linked call/i,
      );
    }
  });

  it("rejects cross-tool deadline and cancellation fault links", async () => {
    for (const requirement of [
      "branch:deadline-before-admission",
      "branch:cancellation-before-write",
    ] as const) {
      const stories = await loadAcceptanceStories(storiesDirectory);
      const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
      const row = matrix.find(
        (candidate) => candidate.requirement === requirement,
      )!;
      const captureCell = row.cells.jetkvm_display_capture;
      const mouseCell = row.cells.jetkvm_input_mouse;
      expect(captureCell.applicability).toBe("applicable");
      expect(mouseCell.applicability).toBe("applicable");
      if (
        captureCell.applicability !== "applicable" ||
        mouseCell.applicability !== "applicable"
      ) {
        continue;
      }
      (captureCell as unknown as Record<string, unknown>).fault_id =
        mouseCell.fault_id;

      expect(
        () => validateAcceptanceStories(stories, matrix),
        requirement,
      ).toThrow(/compatible per-tool fault/i);
    }
  });

  it("rejects a missing per-tool behavior cell", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
    const row = matrix.find(
      ({ requirement }) => requirement === "branch:strict-schema-rejection",
    )!;
    delete (row.cells as unknown as Record<string, unknown>).jetkvm_input_mouse;

    expect(() => validateAcceptanceStories(stories, matrix)).toThrow(
      /missing behavior matrix cell.*jetkvm_input_mouse/i,
    );
  });

  it("rejects an N/A cell without its reviewed tool-specific rationale", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
    const row = matrix.find(
      ({ requirement }) => requirement === "branch:scroll-validation",
    )!;
    (row.cells as unknown as Record<string, unknown>).jetkvm_session_status = {
      applicability: "not_applicable",
      rationale: "",
    };

    expect(() => validateAcceptanceStories(stories, matrix)).toThrow(
      /reviewed rationale.*jetkvm_session_status.*scroll-validation/i,
    );
  });

  it("rejects a copied link to a different tool's executable step", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
    const row = matrix.find(
      ({ requirement }) => requirement === "branch:strict-schema-rejection",
    )!;
    const connectCell = row.cells.jetkvm_session_connect;
    expect(connectCell.applicability).toBe("applicable");
    (
      row.cells as unknown as Record<string, typeof connectCell>
    ).jetkvm_input_mouse = structuredClone(connectCell);

    expect(() => validateAcceptanceStories(stories, matrix)).toThrow(
      /linked step tool.*jetkvm_input_mouse|cross-tool/i,
    );
  });

  it("rejects missing or prose-only focused assertion IDs", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const focusedAssertionId of [
      undefined,
      "",
      "This prose says a unit test covers the branch.",
    ]) {
      const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
      const row = matrix.find(
        ({ requirement }) => requirement === "branch:strict-schema-rejection",
      )!;
      const cell = row.cells.jetkvm_session_connect;
      expect(cell.applicability).toBe("applicable");
      const mutable = cell as unknown as Record<string, unknown>;
      if (focusedAssertionId === undefined) {
        delete mutable.focused_assertion_id;
      } else {
        mutable.focused_assertion_id = focusedAssertionId;
      }

      expect(
        () => validateAcceptanceStories(stories, matrix),
        String(focusedAssertionId),
      ).toThrow(/focused.*assertion id/i);
    }
  });

  it("links shared SSE rows to their executable route cases", () => {
    for (const [requirement, stepId, faultId, assertionId] of [
      [
        "branch:sse-route-security",
        "secure-sse-get",
        "allow-valid-routes",
        "assert-valid-routes-share-boundary",
      ],
      [
        "branch:sse-routing-close",
        "post-inactive-sdk-stream",
        "disconnect-inactive-stream-after-routing",
        "assert-inactive-sdk-stream-500",
      ],
    ] as const) {
      const row = TOOL_BEHAVIOR_MATRIX.find(
        (candidate) => candidate.requirement === requirement,
      )!;
      const cell = row.cells.jetkvm_session_status;
      expect(cell.applicability).toBe("applicable");
      if (cell.applicability === "applicable") {
        expect(cell.step_id).toBe(stepId);
        expect(cell.fault_id).toBe(faultId);
        expect(cell.assertion_id).toBe(assertionId);
      }
    }
  });

  it("permits null-tool links only for explicitly typed shared SSE transport assertions", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
    const sharedRows = matrix.filter(({ requirement }) =>
      ["branch:sse-route-security", "branch:sse-routing-close"].includes(
        requirement,
      ),
    );
    for (const row of sharedRows) {
      for (const cell of Object.values(row.cells)) {
        expect(cell.applicability).toBe("applicable");
        expect(
          (cell as unknown as Record<string, unknown>).coverage_scope,
        ).toBe("shared_transport");
      }
    }
    expect(() => validateAcceptanceStories(stories, matrix)).not.toThrow();

    const strict = matrix.find(
      ({ requirement }) => requirement === "branch:strict-schema-rejection",
    )!;
    const strictCell = strict.cells.jetkvm_session_connect;
    expect(strictCell.applicability).toBe("applicable");
    (strictCell as unknown as Record<string, unknown>).coverage_scope =
      "shared_transport";
    expect(() => validateAcceptanceStories(stories, matrix)).toThrow(
      /shared transport.*sse/i,
    );
  });

  it("rejects applicable prose-only coverage without any executable call, fault, or pass link", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const [field, missingId] of [
      ["step_id", "prose-only-step"],
      ["fault_id", "prose-only-fault"],
      ["assertion_id", "prose-only-assertion"],
    ] as const) {
      const matrix = structuredClone(TOOL_BEHAVIOR_MATRIX);
      const row = matrix.find(
        ({ requirement }) => requirement === "branch:strict-schema-rejection",
      )!;
      const cell = row.cells.jetkvm_session_connect;
      expect(cell.applicability).toBe("applicable");
      (cell as unknown as Record<string, unknown>)[field] = missingId;

      expect(() => validateAcceptanceStories(stories, matrix), field).toThrow(
        /executable call.*fault boundary.*pass assertion/i,
      );
    }
  });
});
const PROVEN_NON_CLOSING_RELEASE_REQUIREMENTS: Readonly<Record<string, true>> =
  Object.freeze({
    "branch:strict-schema-rejection": true,
    "branch:permission-denied": true,
    "branch:capability-missing": true,
    "branch:deadline-before-admission": true,
    "branch:cancellation-before-write": true,
    "branch:disconnect-before-write": true,
    "branch:stale-session-generation": true,
    "branch:duplicate-changed-digest": true,
  });

function generationClosingReleaseCoordinates(
  stories: readonly AcceptanceStory[],
): readonly {
  readonly storyIndex: number;
  readonly releaseIndex: number;
  readonly label: string;
}[] {
  const provenNonClosing = new Set(
    TOOL_BEHAVIOR_MATRIX.flatMap((row) => {
      if (PROVEN_NON_CLOSING_RELEASE_REQUIREMENTS[row.requirement] !== true) {
        return [];
      }
      const cell = row.cells.jetkvm_input_release;
      return cell.applicability === "applicable"
        ? [`${cell.story_id}\u0000${cell.step_id}`]
        : [];
    }),
  );
  return stories.flatMap((story, storyIndex) =>
    story.steps.flatMap((step, releaseIndex) =>
      step.tool === "jetkvm_input_release" &&
      !provenNonClosing.has(`${story.id}\u0000${step.id}`)
        ? [{ storyIndex, releaseIndex, label: `${story.id}/${step.id}` }]
        : [],
    ),
  );
}

describe("reviewed story branch execution", () => {
  it("rejects one-shot faults without an immediate linked-call clear", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const [storyIndex, clearId] of [
      [1, "clear-permission-denied-unauthorized-takeover"],
      [6, "clear-cancel-keyboard-before-write"],
      [7, "clear-disconnect-after-paste-write"],
      [8, "clear-restore-cleanup-failure-jetkvm-power-control"],
      [10, "clear-disconnect-before-write-jetkvm-display-capture"],
      [11, "clear-disconnect-after-write-jetkvm-display-capture"],
      [13, "clear-malformed-after-write-jetkvm-power-control"],
      [
        18,
        "clear-rebind-device-rpc-adapter-mid-flight-loss-jetkvm-display-capture",
      ],
      [23, "clear-disconnect-inactive-stream-after-routing"],
    ] as const) {
      const malformed = structuredClone(stories);
      const clear = malformed[storyIndex]!.fault_script.find(
        ({ id }) => id === clearId,
      )!;
      clear.boundary = "during_verification";

      expect(() => validateAcceptanceStories(malformed), clearId).toThrow(
        /one-shot fault.*immediate.*clear|bracket.*linked call/i,
      );
    }
  });

  it("rejects unknown or closed generations used by later cases before recovery", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);

    const missingReconnect = structuredClone(stories);
    missingReconnect[7]!.steps = missingReconnect[7]!.steps.filter(
      ({ id }) => id !== "reconnect-disconnect-after-write-unknown",
    );
    expect(() => validateAcceptanceStories(missingReconnect)).toThrow(
      /unknown|closed generation.*recover/i,
    );

    const reusedGeneration = structuredClone(stories);
    const recovery = reusedGeneration[11]!.steps.find(
      ({ id }) => id === "recover-after-postwrite-jetkvm-input-keyboard",
    )!;
    recovery.input.next_generation = 9;
    expect(() => validateAcceptanceStories(reusedGeneration)).toThrow(
      /(?:unknown|closed generation).*recover/i,
    );
  });

  it("derives every generation-closing release from machine-readable call coverage, not expectation prose", async () => {
    const canonical = await loadAcceptanceStories(storiesDirectory);
    const releases = generationClosingReleaseCoordinates(canonical);
    expect(releases.length).toBeGreaterThan(0);

    for (const { storyIndex, releaseIndex, label } of releases) {
      const exactReplay = structuredClone(canonical);
      const replayStory = exactReplay[storyIndex]!;
      const replayRelease = replayStory.steps[releaseIndex]!;
      replayRelease.expect =
        "The release is applied under its contract-defined terminal result.";
      replayStory.steps.splice(releaseIndex + 1, 0, {
        ...structuredClone(replayRelease),
        id: `exact-replay-after-${replayRelease.id}`,
      });
      expect(
        () => validateAcceptanceStories(exactReplay),
        `${label} exact replay`,
      ).not.toThrow();

      const freshAdmission = structuredClone(canonical);
      const admissionStory = freshAdmission[storyIndex]!;
      const admissionRelease = admissionStory.steps[releaseIndex]!;
      admissionRelease.expect =
        "The release is applied under its contract-defined terminal result.";
      admissionStory.steps.splice(releaseIndex + 1, 0, {
        ...structuredClone(admissionRelease),
        id: `fresh-admission-after-${admissionRelease.id}`,
        input: {
          ...admissionRelease.input,
          request_id: `${String(admissionRelease.input.request_id)}-fresh`,
        },
      });
      expect(
        () => validateAcceptanceStories(freshAdmission),
        `${label} fresh admission`,
      ).toThrow(/generation-closing release.*later mutation/i);
    }
  });

  it("rejects deleting any declared successor recovery after a generation-closing release", async () => {
    const canonical = await loadAcceptanceStories(storiesDirectory);
    const recoveryCases: string[] = [];

    for (const {
      storyIndex,
      releaseIndex,
      label,
    } of generationClosingReleaseCoordinates(canonical)) {
      const originalStory = canonical[storyIndex]!;
      const originalRelease = originalStory.steps[releaseIndex]!;
      const recoveryIndex = originalStory.steps.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > releaseIndex &&
          candidate.tool === null &&
          candidate.input.closed_session_id ===
            originalRelease.input.session_id &&
          (candidate.input.closed_generation === undefined ||
            candidate.input.closed_generation ===
              originalRelease.input.session_generation) &&
          candidate.call.includes("recover-for-next-tool"),
      );
      if (recoveryIndex < 0) {
        continue;
      }
      recoveryCases.push(label);
      const malformed = structuredClone(canonical);
      const story = malformed[storyIndex]!;
      const recovery = story.steps[recoveryIndex]!;
      const release = story.steps[releaseIndex]!;
      release.expect =
        "The release is applied under its contract-defined terminal result.";
      story.steps.splice(recoveryIndex, 1);
      for (const fault of story.fault_script) {
        if (fault.after_step === recovery.id) {
          fault.after_step = originalRelease.id;
        }
      }

      expect(
        () => validateAcceptanceStories(malformed),
        `${label} deleted recovery`,
      ).toThrow(
        /generation-closing release.*explicit recovery|closed generation.*recover/i,
      );
    }

    expect(recoveryCases.length).toBeGreaterThan(0);
  });

  it("keeps the Story 10 and Story 21 release-to-power cases serially executable", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const story10 = stories[9]!;
    expect(story10.steps.slice(-4).map(({ id }) => id)).toEqual([
      "prove-definitive-power-baseline",
      "definitive-acknowledgement-jetkvm-power-control",
      "restore-and-prove-after-definitive-power",
      "definitive-acknowledgement-jetkvm-input-release",
    ]);

    const story21 = stories[20]!;
    for (const orderedIds of [
      [
        "shared-device-rpc-adapter-binding-jetkvm-power-control",
        "restore-and-prove-after-shared-power",
        "shared-device-rpc-adapter-binding-jetkvm-input-release",
        "prepare-shared-session-connect-case",
      ],
      [
        "device-rpc-adapter-replacement-jetkvm-power-control",
        "device-rpc-adapter-replacement-jetkvm-input-release",
        "prepare-replacement-session-connect-case",
      ],
    ] as const) {
      const positions = orderedIds.map((id) =>
        story21.steps.findIndex((candidate) => candidate.id === id),
      );
      expect(positions, orderedIds.join(" -> ")).not.toContain(-1);
      expect(
        positions.every(
          (position, index) => index === 0 || position > positions[index - 1]!,
        ),
        orderedIds.join(" -> "),
      ).toBe(true);
    }
  });

  it("rejects fixture recovery state that cannot reach the next tool call", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const staleGeneration = structuredClone(stories);
    const staleRecovery = staleGeneration[12]!.steps.find(
      ({ id }) => id === "prepare-duplicate-keyboard-case",
    )!;
    staleRecovery.input.next_generation = 10;
    expect(() => validateAcceptanceStories(staleGeneration)).toThrow(
      /fixture recovery.*next tool.*generation/i,
    );

    const staleObservation = structuredClone(stories);
    const observationRecovery = staleObservation[12]!.steps.find(
      ({ id }) => id === "prepare-duplicate-keyboard-case",
    )!;
    observationRecovery.input.next_observation_id =
      "opaque-observation-from-closed-generation";
    expect(() => validateAcceptanceStories(staleObservation)).toThrow(
      /fixture recovery.*next tool.*observation/i,
    );

    const missingRecovery = structuredClone(stories);
    missingRecovery[12]!.steps = missingRecovery[12]!.steps.filter(
      ({ id }) => id !== "prepare-duplicate-session-connect-case",
    );
    expect(() => validateAcceptanceStories(missingRecovery)).toThrow(
      /generation-closing release.*explicit recovery|drained or replaced session.*fixture recovery/i,
    );

    const missingCapture = structuredClone(stories);
    missingCapture[20]!.steps = missingCapture[20]!.steps.filter(
      ({ id }) => id !== "capture-shared-keyboard-observation",
    );
    expect(() => validateAcceptanceStories(missingCapture)).toThrow(
      /observation-consuming call.*immediate fresh capture/i,
    );
  });

  it("requires every partial-verification mutation to have an exact immediate fault arm, call, and clear", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const misplacedInitialArm = structuredClone(stories);
    const initialArm = misplacedInitialArm[16]!.fault_script.find(
      ({ id }) => id === "arm-power-with-post-read-failure",
    )!;
    initialArm.after_step = "restore-and-prove-after-power-post-read-failure";
    expect(() => validateAcceptanceStories(misplacedInitialArm)).toThrow(
      /partial-verification.*arm.*call.*clear|partial verification.*bracket/i,
    );

    for (const clearId of [
      "clear-power-with-post-read-failure",
      "clear-partial-verification-jetkvm-session-connect",
      "clear-partial-verification-jetkvm-session-reconnect",
      "clear-partial-verification-jetkvm-input-keyboard",
      "clear-partial-verification-jetkvm-input-mouse",
      "clear-partial-verification-jetkvm-input-paste",
      "clear-partial-verification-jetkvm-power-control",
    ]) {
      const missingClear = structuredClone(stories);
      missingClear[16]!.fault_script = missingClear[16]!.fault_script.filter(
        ({ id }) => id !== clearId,
      );
      expect(() => validateAcceptanceStories(missingClear), clearId).toThrow(
        /partial-verification.*arm.*call.*clear|partial verification.*bracket/i,
      );
    }
  });

  it("rejects applied connect and reconnect calls with impossible session lifecycle state", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const [storyIndex, retireId, reconnectId] of [
      [
        9,
        "retire-definitive-session-before-connect",
        "definitive-acknowledgement-jetkvm-session-reconnect",
      ],
      [
        16,
        "retire-partial-session-before-connect",
        "partial-verification-jetkvm-session-reconnect",
      ],
    ] as const) {
      const activeIncumbent = structuredClone(stories);
      const lifecycleStory = activeIncumbent[storyIndex]!;
      const retireIndex = lifecycleStory.steps.findIndex(
        ({ id }) => id === retireId,
      );
      const precedingStepId = lifecycleStory.steps[retireIndex - 1]!.id;
      for (const fault of lifecycleStory.fault_script) {
        if (fault.after_step === retireId) {
          fault.after_step = precedingStepId;
        }
      }
      lifecycleStory.steps = lifecycleStory.steps.filter(
        ({ id }) => id !== retireId,
      );
      expect(
        () => validateAcceptanceStories(activeIncumbent),
        `${activeIncumbent[storyIndex]!.id}:connect`,
      ).toThrow(/session lifecycle.*connect.*incumbent/i);

      const staleReconnect = structuredClone(stories);
      const reconnect = staleReconnect[storyIndex]!.steps.find(
        ({ id }) => id === reconnectId,
      )!;
      reconnect.input.session_id = "opaque-stale-incumbent";
      reconnect.input.session_generation = 7;
      expect(
        () => validateAcceptanceStories(staleReconnect),
        `${staleReconnect[storyIndex]!.id}:reconnect`,
      ).toThrow(/session lifecycle.*reconnect.*(?:current|returned)/i);
    }
  });

  it("rejects later input calls that use a stale reconnect predecessor instead of the returned successor", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const [storyIndex, inputId] of [
      [9, "definitive-acknowledgement-jetkvm-input-keyboard"],
      [16, "partial-verification-jetkvm-input-keyboard"],
    ] as const) {
      const staleSuccessor = structuredClone(stories);
      const input = staleSuccessor[storyIndex]!.steps.find(
        ({ id }) => id === inputId,
      )!;
      input.input.session_id = "opaque-stale-reconnect-predecessor";
      input.input.session_generation = 8;
      expect(
        () => validateAcceptanceStories(staleSuccessor),
        staleSuccessor[storyIndex]!.id,
      ).toThrow(/session lifecycle.*(?:stale|successor|current)/i);
    }
  });

  it("rejects ATX cases without inter-case baseline restoration and reproof", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    for (const [storyIndex, proofId] of [
      [9, "restore-and-prove-hold-power-baseline"],
      [20, "restore-and-prove-after-shared-power"],
      [21, "restore-and-prove-prewrite-baseline"],
    ] as const) {
      const malformed = structuredClone(stories);
      const proof = malformed[storyIndex]!.steps.find(
        ({ id }) => id === proofId,
      )!;
      proof.call = "acceptance-fixture/noop";
      expect(() => validateAcceptanceStories(malformed), proofId).toThrow(
        /ATX.*baseline.*(?:restore|reproof)|inter-case/i,
      );
    }
  });

  it("requires exact Story 21 power outcomes before ATX recovery", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const malformed = structuredClone(stories);
    const power = malformed[20]!.steps.find(
      ({ id }) =>
        id === "shared-device-rpc-adapter-binding-jetkvm-power-control",
    )!;
    power.expect = "The power call succeeds.";
    expect(() => validateAcceptanceStories(malformed)).toThrow(
      /power call.*exact outcome.*verification/i,
    );
  });

  it("rejects ATX binding-loss cases without exact duplicate and recovery order", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);

    const misplacedPrewrite = structuredClone(stories);
    const prewriteFault = misplacedPrewrite[21]!.fault_script.find(
      ({ id }) => id === "atx-prewrite-binding-loss",
    )!;
    prewriteFault.after_step = "power-before-write-binding-loss";
    expect(() => validateAcceptanceStories(misplacedPrewrite)).toThrow(
      /ATX binding-loss.*duplicate.*recovery|bracket/i,
    );

    const changedDuplicate = structuredClone(stories);
    const duplicate = changedDuplicate[21]!.steps.find(
      ({ id }) => id === "repeat-power-after-on-binding-loss",
    )!;
    duplicate.input.request_id = "opaque-different-request";
    expect(() => validateAcceptanceStories(changedDuplicate)).toThrow(
      /ATX binding-loss.*duplicate.*recovery|bracket/i,
    );
  });

  it("story 1 executes strict-schema, deadline-release, and busy as distinct calls and faults", async () => {
    const [story] = await loadAcceptanceStories(storiesDirectory);
    expect(story!.steps.slice(0, 4).map(({ id }) => id)).toEqual([
      "reject-strict-schema",
      "deadline-before-admission",
      "retry-expired-connect-request",
      "connect-without-takeover",
    ]);
    expect(
      story!.fault_script.slice(0, 4).map(({ id, boundary }) => [id, boundary]),
    ).toEqual([
      ["strict-schema-before-controller", "before_admission"],
      ["expire-before-admission", "before_admission"],
      ["clear-expired-deadline", "during_cleanup"],
      ["incumbent-busy", "before_admission"],
    ]);
  });

  it("story 1 retries the expired connect reservation with the same normalized request and reaches ordinary busy handling", async () => {
    const [story] = await loadAcceptanceStories(storiesDirectory);
    const expired = story!.steps.find(
      ({ id }) => id === "deadline-before-admission",
    )!;
    const retry = story!.steps.find(
      ({ id }) => id === "retry-expired-connect-request",
    )!;

    expect(retry.tool).toBe("jetkvm_session_connect");
    expect(retry.input).toEqual(expired.input);
    expect(retry.expect).toMatch(/CONTROL_BUSY/);

    const missingRetry = await loadAcceptanceStories(storiesDirectory);
    missingRetry[0]!.steps = missingRetry[0]!.steps.filter(
      ({ id }) => id !== "retry-expired-connect-request",
    );
    expect(() => validateAcceptanceStories(missingRetry)).toThrow(
      /deadline.*reservation.*retry/i,
    );
  });

  it("serializes per-tool deadline and cancellation faults with clear steps and mutation retries", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const mutationTools: Partial<
      Record<(typeof JETKVM_TOOL_NAMES)[number], true>
    > = {
      jetkvm_input_keyboard: true,
      jetkvm_input_mouse: true,
      jetkvm_input_paste: true,
      jetkvm_input_release: true,
      jetkvm_power_control: true,
      jetkvm_session_connect: true,
      jetkvm_session_reconnect: true,
    };

    for (const {
      storyIndex,
      requirement,
      faultPrefix,
      clearPrefix,
      stepPrefix,
      retryPrefix,
      tools,
      expectedRequestIds,
    } of [
      {
        tools: JETKVM_TOOL_NAMES,
        expectedRequestIds: 7,
        storyIndex: 0,
        requirement: "branch:deadline-before-admission",
        faultPrefix: "expire-before-admission",
        clearPrefix: "clear-expired-deadline",
        stepPrefix: "deadline-before-admission",
        retryPrefix: "retry-deadline-before-admission",
      },
      {
        tools: JETKVM_TOOL_NAMES.filter(
          (tool) =>
            tool !== "jetkvm_input_keyboard" && tool !== "jetkvm_input_paste",
        ),
        expectedRequestIds: 5,
        storyIndex: 5,
        requirement: "branch:cancellation-before-write",
        faultPrefix: "cancel-before-write",
        clearPrefix: "clear-cancel-before-write",
        stepPrefix: "cancel-before-write",
        retryPrefix: "retry-cancel-before-write",
      },
    ] as const) {
      const story = stories[storyIndex]!;
      const row = TOOL_BEHAVIOR_MATRIX.find(
        (candidate) => candidate.requirement === requirement,
      )!;
      const requestIds = new Set<string>();

      for (const tool of tools) {
        const slug = tool.replaceAll("_", "-");
        const cell = row.cells[tool];
        expect(cell.applicability).toBe("applicable");
        const call = story.steps.find(
          ({ id }) => id === `${stepPrefix}-${slug}`,
        )!;
        const fault = story.fault_script.find(
          ({ id }) => id === `${faultPrefix}-${slug}`,
        );
        const clear = story.fault_script.find(
          ({ id }) => id === `${clearPrefix}-${slug}`,
        );
        expect(fault, `${requirement} ${tool} fault`).toBeDefined();
        expect(clear, `${requirement} ${tool} clear`).toBeDefined();
        expect(clear?.after_step).toBe(call.id);

        if (mutationTools[tool] !== true) {
          continue;
        }
        const requestId = call.input.request_id;
        expect(requestId).toEqual(expect.any(String));
        expect(requestIds.has(requestId as string)).toBe(false);
        requestIds.add(requestId as string);

        const retry = story.steps.find(
          ({ id }) => id === `${retryPrefix}-${slug}`,
        );
        expect(retry, `${requirement} ${tool} retry`).toBeDefined();
        expect(retry?.tool).toBe(tool);
        expect(retry?.input).toEqual(call.input);
        expect(story.steps.indexOf(retry!)).toBeGreaterThan(
          story.steps.indexOf(call),
        );
      }
      expect(requestIds).toHaveLength(expectedRequestIds);
    }
  });

  it("rejects a missing per-tool mutation retry after fault clear", async () => {
    for (const [storyIndex, retryId, nextFaultId, nextArmStepId] of [
      [
        0,
        "retry-deadline-before-admission-jetkvm-input-keyboard",
        "expire-before-admission-jetkvm-input-mouse",
        "deadline-before-admission-jetkvm-input-keyboard",
      ],
      [
        5,
        "retry-cancel-before-write-jetkvm-input-release",
        "cancel-before-write-jetkvm-power-control",
        "cancel-before-write-jetkvm-input-release",
      ],
    ] as const) {
      const stories = await loadAcceptanceStories(storiesDirectory);
      stories[storyIndex]!.steps = stories[storyIndex]!.steps.filter(
        ({ id }) => id !== retryId,
      );
      const nextFault = stories[storyIndex]!.fault_script.find(
        ({ id }) => id === nextFaultId,
      )!;
      nextFault.after_step = nextArmStepId;
      expect(() => validateAcceptanceStories(stories), retryId).toThrow(
        /per-tool.*reservation.*retry/i,
      );
    }
  });

  it("story 6 requires fresh observations for both accepted scroll bounds and rejects consumed reuse", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const story = stories[5]!;
    const negative = story.steps.find(
      ({ id }) => id === "scroll-negative-bound",
    )!;
    const positive = story.steps.find(
      ({ id }) => id === "scroll-positive-bound",
    )!;
    const consumed = story.steps.find(
      ({ id }) => id === "reuse-consumed-negative-observation",
    )!;

    expect(negative.input.observation_id).not.toBe(
      positive.input.observation_id,
    );
    expect(consumed.input.observation_id).toBe(negative.input.observation_id);

    const reusedAccepted = structuredClone(stories);
    const reusedPositive = reusedAccepted[5]!.steps.find(
      ({ id }) => id === "scroll-positive-bound",
    )!;
    reusedPositive.input.observation_id = negative.input.observation_id;
    expect(() => validateAcceptanceStories(reusedAccepted)).toThrow(
      /accepted scroll.*fresh observation/i,
    );

    const noConsumedProof = structuredClone(stories);
    const changedConsumed = noConsumedProof[5]!.steps.find(
      ({ id }) => id === "reuse-consumed-negative-observation",
    )!;
    changedConsumed.input.observation_id = "opaque-unconsumed-observation";
    expect(() => validateAcceptanceStories(noConsumedProof)).toThrow(
      /consumed-observation reuse/i,
    );
  });

  it("story 6 executes every observation fence with a fresh observation and observable write counts", async () => {
    const stories = await loadAcceptanceStories(storiesDirectory);
    const story = stories[5]!;
    const expectedCases = [
      [
        "retry-cancelled-reservation",
        "opaque-observation-cancel",
        /applied.*one downstream write/i,
      ],
      [
        "reject-foreign-observation",
        "opaque-observation-foreign",
        /STALE_OBSERVATION.*zero downstream writes/i,
      ],
      [
        "reject-stale-age-observation",
        "opaque-observation-stale-age",
        /STALE_OBSERVATION.*zero downstream writes/i,
      ],
      [
        "reuse-consumed-observation",
        "opaque-observation-consumed",
        /OBSERVATION_CONSUMED.*zero downstream writes/i,
      ],
      [
        "reject-display-change-before-dispatch",
        "opaque-observation-display-before",
        /DISPLAY_CHANGED.*zero downstream writes/i,
      ],
      [
        "display-change-after-first-dispatch",
        "opaque-observation-display-after",
        /outcome unknown.*dispatched_action_count 2.*completed_action_count 1.*suppressed/i,
      ],
    ] as const;
    const observationIds = new Set<string>();

    for (const [stepId, observationId, expected] of expectedCases) {
      const step = story.steps.find(({ id }) => id === stepId)!;
      expect(step.tool).toBe("jetkvm_input_mouse");
      expect(step.input.observation_id).toBe(observationId);
      expect(step.expect).toMatch(expected);
      expect(observationIds.has(observationId)).toBe(false);
      observationIds.add(observationId);
    }

    const cancellation = story.steps.find(
      ({ id }) => id === "cancel-before-write",
    )!;
    const cancellationRetry = story.steps.find(
      ({ id }) => id === "retry-cancelled-reservation",
    )!;
    expect(cancellationRetry.input).toEqual(cancellation.input);

    for (const [stepId] of expectedCases) {
      const incomplete = await loadAcceptanceStories(storiesDirectory);
      incomplete[5]!.steps = incomplete[5]!.steps.filter(
        ({ id }) => id !== stepId,
      );
      expect(() => validateAcceptanceStories(incomplete), stepId).toThrow(
        /story 6.*observation|reservation release/i,
      );
    }
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
