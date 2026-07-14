import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAcceptanceStories } from "../../stories/manifest.js";
import type { GroundedBranchMatrixReport } from "./branchMatrix.js";
import {
  buildGroundedStoryE2EReport,
  generateStoryScenarios,
  parseSupplementalStoryEvidence,
  runStoryScenario,
  type StoryScenarioDriver,
} from "./storyRunner.js";

const stories = await loadAcceptanceStories(resolve("src/stories"));
const matrixReport = JSON.parse(
  await readFile(resolve("reports/branch-matrix.json"), "utf8"),
) as GroundedBranchMatrixReport;
const transportEvidence = [
  {
    requirement: "contract:transport-session-independence",
    test_file: "src/mcp/legacySse.test.ts",
    test_identity:
      "Phase 5 supplemental story contracts > transport reconnect preserves application session",
    execution_result: "pass" as const,
  },
];

describe("story-driven system E2E runner", () => {
  it("generates exactly one success and every declared fault scenario", () => {
    const scenarios = generateStoryScenarios(stories);
    const faultCount = stories.reduce(
      (total, story) => total + story.fault_script.length,
      0,
    );

    expect(stories).toHaveLength(24);
    expect(scenarios).toHaveLength(stories.length + faultCount);
    expect(
      scenarios.filter((scenario) => scenario.kind === "success"),
    ).toHaveLength(24);
    expect(
      scenarios.filter((scenario) => scenario.kind === "fault"),
    ).toHaveLength(229);
    expect(new Set(scenarios.map((scenario) => scenario.scenarioId)).size).toBe(
      scenarios.length,
    );
  });

  it("runs source steps and always restores after an execution failure", async () => {
    const story = stories[0]!;
    const scenario = generateStoryScenarios([story])[0]!;
    const restore = vi.fn(async () => undefined);
    const driver: StoryScenarioDriver = {
      assertPrecondition: vi.fn(async () => undefined),
      begin: vi.fn(async () => undefined),
      injectFault: vi.fn(async () => undefined),
      executeStep: vi.fn(async () => {
        throw new Error("injected execution failure");
      }),
      assertPassCriterion: vi.fn(async () => undefined),
      collectEvidence: vi.fn(async () => []),
      restore,
    };

    await expect(runStoryScenario(scenario, driver)).rejects.toThrowError(
      "injected execution failure",
    );
    expect(restore).toHaveBeenCalledTimes(story.restore.length);
    const restoreCalls = restore.mock.calls as unknown as Array<
      [typeof scenario, (typeof story.restore)[number]]
    >;
    expect(restoreCalls.map((call) => call[1].id)).toEqual(
      story.restore.map(({ id }) => id),
    );
  });

  it("grounds all scenarios, pass criteria, evidence, and restoration", async () => {
    const report = await buildGroundedStoryE2EReport(
      stories,
      matrixReport,
      transportEvidence,
    );

    expect(report.summary).toMatchObject({
      stories: 24,
      success_scenarios: 24,
      fault_scenarios: 229,
      total_scenarios: 253,
      passed_scenarios: 253,
    });
    expect(report.scenarios).toHaveLength(253);
    expect(
      report.scenarios.every(
        (scenario) =>
          scenario.result === "pass" &&
          scenario.precondition_ids.length > 0 &&
          scenario.step_ids.length > 0 &&
          scenario.pass_assertion_ids.length > 0 &&
          scenario.evidence_ids.length > 0 &&
          scenario.restore_ids.length > 0 &&
          scenario.grounded_test_identities.length > 0,
      ),
    ).toBe(true);
  });

  it("rejects missing contract evidence and fabricated supplemental identities", async () => {
    await expect(
      buildGroundedStoryE2EReport(stories, matrixReport, []),
    ).rejects.toThrowError(/transport-session-independence/);

    const raw = {
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: resolve("src/mcp/legacySse.test.ts"),
          assertionResults: [
            {
              ancestorTitles: ["actual suite"],
              title: "actual test",
              status: "passed",
              meta: {
                story_contract_ids: ["contract:transport-session-independence"],
                story_test_identity: "fabricated identity",
              },
            },
          ],
        },
      ],
    };
    expect(() => parseSupplementalStoryEvidence(raw)).toThrowError(
      /identity.*metadata/i,
    );
  });
});

const storyExecutionPath = process.env.JETKVM_STORY_EXECUTION_REPORT;
if (storyExecutionPath !== undefined) {
  it("grounds the release story report in exact execution metadata", async () => {
    const raw = JSON.parse(
      await readFile(storyExecutionPath, "utf8"),
    ) as unknown;
    const supplemental = parseSupplementalStoryEvidence(raw);
    const report = await buildGroundedStoryE2EReport(
      stories,
      matrixReport,
      supplemental,
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = resolve("reports/story-e2e.json");
    if (process.env.JETKVM_WRITE_STORY_E2E === "1") {
      await writeFile(reportPath, serialized, "utf8");
    } else {
      expect(await readFile(reportPath, "utf8")).toBe(serialized);
    }
  });
}
