import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { AcceptanceStory } from "../../stories/manifest.js";
import type {
  GroundedBranchMatrixCell,
  GroundedBranchMatrixReport,
} from "./branchMatrix.js";

export type StoryScenario = Readonly<{
  scenarioId: string;
  kind: "success" | "fault";
  story: AcceptanceStory;
  fault: AcceptanceStory["fault_script"][number] | null;
}>;

export type SupplementalStoryEvidence = Readonly<{
  requirement: string;
  test_file: string;
  test_identity: string;
  execution_result: "pass";
}>;

export interface StoryScenarioDriver {
  assertPrecondition(
    scenario: StoryScenario,
    condition: AcceptanceStory["preconditions"][number],
  ): Promise<void>;
  begin(scenario: StoryScenario): Promise<void>;
  injectFault(
    scenario: StoryScenario,
    fault: AcceptanceStory["fault_script"][number],
  ): Promise<void>;
  executeStep(
    scenario: StoryScenario,
    step: AcceptanceStory["steps"][number],
  ): Promise<void>;
  assertPassCriterion(
    scenario: StoryScenario,
    criterion: AcceptanceStory["pass"][number],
  ): Promise<void>;
  collectEvidence(
    scenario: StoryScenario,
    evidence: AcceptanceStory["evidence"][number],
  ): Promise<readonly SupplementalStoryEvidence[]>;
  restore(
    scenario: StoryScenario,
    restore: AcceptanceStory["restore"][number],
  ): Promise<void>;
}

export type StoryScenarioExecution = Readonly<{
  scenarioId: string;
  result: "pass";
  collectedEvidence: readonly SupplementalStoryEvidence[];
}>;

export function generateStoryScenarios(
  stories: readonly AcceptanceStory[],
): StoryScenario[] {
  const scenarios = stories.flatMap((story) => [
    {
      scenarioId: `${story.id}:success`,
      kind: "success" as const,
      story,
      fault: null,
    },
    ...story.fault_script.map((fault) => ({
      scenarioId: `${story.id}:fault:${fault.id}`,
      kind: "fault" as const,
      story,
      fault,
    })),
  ]);
  const ids = new Set(scenarios.map(({ scenarioId }) => scenarioId));
  if (ids.size !== scenarios.length) {
    throw new Error("Generated story scenario IDs must be unique.");
  }
  return scenarios;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function runStoryScenario(
  scenario: StoryScenario,
  driver: StoryScenarioDriver,
): Promise<StoryScenarioExecution> {
  const collectedEvidence: SupplementalStoryEvidence[] = [];
  const failures: Error[] = [];
  let faultInjected = false;
  try {
    for (const condition of scenario.story.preconditions) {
      await driver.assertPrecondition(scenario, condition);
    }
    await driver.begin(scenario);
    if (scenario.fault?.after_step === null) {
      await driver.injectFault(scenario, scenario.fault);
      faultInjected = true;
    }
    for (const step of scenario.story.steps) {
      await driver.executeStep(scenario, step);
      if (scenario.fault?.after_step === step.id) {
        await driver.injectFault(scenario, scenario.fault);
        faultInjected = true;
      }
    }
    if (scenario.fault !== null && !faultInjected) {
      throw new Error(
        `Scenario ${scenario.scenarioId} did not reach fault ${scenario.fault.id}.`,
      );
    }
    for (const criterion of scenario.story.pass) {
      await driver.assertPassCriterion(scenario, criterion);
    }
    for (const evidence of scenario.story.evidence) {
      collectedEvidence.push(
        ...(await driver.collectEvidence(scenario, evidence)),
      );
    }
  } catch (error) {
    failures.push(asError(error));
  } finally {
    for (const restore of scenario.story.restore) {
      try {
        await driver.restore(scenario, restore);
      } catch (error) {
        failures.push(asError(error));
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Story scenario ${scenario.scenarioId} and restoration failed.`,
    );
  }
  return {
    scenarioId: scenario.scenarioId,
    result: "pass",
    collectedEvidence,
  };
}

type StoryReportScenario = Readonly<{
  story_id: string;
  scenario_id: string;
  kind: "success" | "fault";
  fault_id: string | null;
  fault_boundary: string | null;
  environment: "fake_replay_execution_evidence";
  precondition_ids: readonly string[];
  step_ids: readonly string[];
  pass_assertion_ids: readonly string[];
  evidence_ids: readonly string[];
  restore_ids: readonly string[];
  grounded_test_identities: readonly string[];
  result: "pass";
}>;

export type GroundedStoryE2EReport = Readonly<{
  schema_version: 1;
  evidence_source: "reviewed-story-manifest-and-execution-produced-tests";
  summary: Readonly<{
    stories: number;
    success_scenarios: number;
    fault_scenarios: number;
    total_scenarios: number;
    passed_scenarios: number;
    source_steps_executed: number;
    restore_steps_executed: number;
  }>;
  scenarios: readonly StoryReportScenario[];
}>;

function applicableCells(
  report: GroundedBranchMatrixReport,
): Extract<GroundedBranchMatrixCell, { applicability: "applicable" }>[] {
  const applicable = report.cells.filter(
    (
      cell,
    ): cell is Extract<
      GroundedBranchMatrixCell,
      { applicability: "applicable" }
    > =>
      cell.applicability === "applicable" && cell.execution_result === "pass",
  );
  const notApplicable = report.cells.filter(
    (cell) => cell.applicability === "not_applicable",
  );
  if (
    report.schema_version !== 1 ||
    report.evidence_source !== "execution-produced-vitest-json" ||
    report.summary.passed_focused_assertions !==
      report.summary.applicable_cells ||
    applicable.length !== report.summary.applicable_cells ||
    notApplicable.length !== report.summary.not_applicable_cells ||
    report.cells.length !== applicable.length + notApplicable.length
  ) {
    throw new Error("Grounded branch matrix report is incomplete.");
  }
  return applicable;
}

function evidenceIdentities(
  story: AcceptanceStory,
  requirement: string,
  cells: readonly Extract<
    GroundedBranchMatrixCell,
    { applicability: "applicable" }
  >[],
  supplemental: ReadonlyMap<string, SupplementalStoryEvidence>,
): string[] {
  const exact = cells.filter(
    (cell) => cell.story_id === story.id && cell.requirement === requirement,
  );
  if (exact.length > 0) return exact.map(({ test_identity }) => test_identity);
  if (requirement.startsWith("contract:")) {
    const storyCells = cells.filter((cell) => cell.story_id === story.id);
    if (storyCells.length > 0) {
      return storyCells.map(({ test_identity }) => test_identity);
    }
    const evidence = supplemental.get(requirement);
    if (evidence !== undefined && evidence.execution_result === "pass") {
      return [evidence.test_identity];
    }
  }
  throw new Error(
    `Story ${story.id} requirement ${requirement} has no grounded execution evidence.`,
  );
}

export async function buildGroundedStoryE2EReport(
  stories: readonly AcceptanceStory[],
  matrixReport: GroundedBranchMatrixReport,
  supplementalEvidence: readonly SupplementalStoryEvidence[],
): Promise<GroundedStoryE2EReport> {
  const cells = applicableCells(matrixReport);
  const supplemental = new Map<string, SupplementalStoryEvidence>();
  const fileByIdentity = new Map<string, string>(
    cells.map((cell) => [cell.test_identity, cell.test_file]),
  );
  const contractRequirements = new Set(
    stories.flatMap((story) => [
      ...story.requirements.filter((requirement) =>
        requirement.startsWith("contract:"),
      ),
      ...story.pass
        .map(({ requirement }) => requirement)
        .filter((requirement) => requirement.startsWith("contract:")),
      ...story.evidence
        .map(({ requirement }) => requirement)
        .filter((requirement) => requirement.startsWith("contract:")),
    ]),
  );
  for (const evidence of supplementalEvidence) {
    if (
      evidence.execution_result !== "pass" ||
      evidence.requirement.length === 0 ||
      evidence.test_file.length === 0 ||
      evidence.test_identity.length === 0
    ) {
      throw new Error("Supplemental story evidence is malformed.");
    }
    if (!contractRequirements.has(evidence.requirement)) {
      throw new Error(
        `Unknown supplemental story evidence ${evidence.requirement}.`,
      );
    }
    if (supplemental.has(evidence.requirement)) {
      throw new Error(
        `Duplicate supplemental story evidence ${evidence.requirement}.`,
      );
    }
    supplemental.set(evidence.requirement, evidence);
    fileByIdentity.set(evidence.test_identity, evidence.test_file);
  }

  const scenarios = generateStoryScenarios(stories);
  const reportScenarios: StoryReportScenario[] = [];
  let sourceStepsExecuted = 0;
  let restoreStepsExecuted = 0;
  for (const scenario of scenarios) {
    const story = scenario.story;
    const identities = new Set<string>();
    const preconditionIds: string[] = [];
    const stepIds: string[] = [];
    const passAssertionIds: string[] = [];
    const evidenceIds: string[] = [];
    const restoreIds: string[] = [];

    const addRequirementEvidence = (requirement: string): string[] => {
      const grounded = evidenceIdentities(
        story,
        requirement,
        cells,
        supplemental,
      );
      for (const identity of grounded) identities.add(identity);
      return grounded;
    };
    const driver: StoryScenarioDriver = {
      assertPrecondition: async (actualScenario, condition) => {
        if (actualScenario !== scenario || condition.required !== true) {
          throw new Error(
            `Scenario ${scenario.scenarioId} has an invalid precondition.`,
          );
        }
        preconditionIds.push(condition.id);
      },
      begin: async (actualScenario) => {
        if (actualScenario !== scenario) {
          throw new Error("Story scenario driver identity changed.");
        }
        for (const requirement of story.requirements) {
          addRequirementEvidence(requirement);
        }
      },
      injectFault: async (actualScenario, fault) => {
        if (
          actualScenario !== scenario ||
          scenario.fault === null ||
          fault.id !== scenario.fault.id
        ) {
          throw new Error(`Scenario ${scenario.scenarioId} fault drifted.`);
        }
        for (const cell of cells) {
          if (cell.story_id === story.id && cell.fault_id === fault.id) {
            identities.add(cell.test_identity);
          }
        }
      },
      executeStep: async (actualScenario, step) => {
        if (
          actualScenario !== scenario ||
          !story.steps.some((candidate) => candidate === step) ||
          (step.tool !== null && !story.tools.includes(step.tool))
        ) {
          throw new Error(`Scenario ${scenario.scenarioId} step drifted.`);
        }
        stepIds.push(step.id);
        sourceStepsExecuted += 1;
      },
      assertPassCriterion: async (actualScenario, criterion) => {
        if (
          actualScenario !== scenario ||
          !story.pass.some((candidate) => candidate === criterion)
        ) {
          throw new Error(
            `Scenario ${scenario.scenarioId} pass criterion drifted.`,
          );
        }
        addRequirementEvidence(criterion.requirement);
        passAssertionIds.push(criterion.id);
      },
      collectEvidence: async (actualScenario, evidence) => {
        if (
          actualScenario !== scenario ||
          !story.evidence.some((candidate) => candidate === evidence)
        ) {
          throw new Error(`Scenario ${scenario.scenarioId} evidence drifted.`);
        }
        const grounded = addRequirementEvidence(evidence.requirement);
        evidenceIds.push(evidence.id);
        return grounded.map((testIdentity) => {
          const testFile = fileByIdentity.get(testIdentity);
          if (testFile === undefined) {
            throw new Error(
              `Grounded test identity ${testIdentity} has no source file.`,
            );
          }
          return {
            requirement: evidence.requirement,
            test_file: testFile,
            test_identity: testIdentity,
            execution_result: "pass" as const,
          };
        });
      },
      restore: async (actualScenario, restore) => {
        if (
          actualScenario !== scenario ||
          restore.always !== true ||
          !story.restore.some((candidate) => candidate === restore)
        ) {
          throw new Error(`Scenario ${scenario.scenarioId} restore drifted.`);
        }
        restoreIds.push(restore.id);
        restoreStepsExecuted += 1;
      },
    };

    const execution = await runStoryScenario(scenario, driver);
    if (
      execution.result !== "pass" ||
      preconditionIds.length !== story.preconditions.length ||
      stepIds.length !== story.steps.length ||
      passAssertionIds.length !== story.pass.length ||
      evidenceIds.length !== story.evidence.length ||
      restoreIds.length !== story.restore.length ||
      execution.collectedEvidence.length === 0 ||
      identities.size === 0
    ) {
      throw new Error(
        `Scenario ${scenario.scenarioId} did not execute its complete source contract.`,
      );
    }
    reportScenarios.push({
      story_id: story.id,
      scenario_id: scenario.scenarioId,
      kind: scenario.kind,
      fault_id: scenario.fault?.id ?? null,
      fault_boundary: scenario.fault?.boundary ?? null,
      environment: "fake_replay_execution_evidence",
      precondition_ids: preconditionIds,
      step_ids: stepIds,
      pass_assertion_ids: passAssertionIds,
      evidence_ids: evidenceIds,
      restore_ids: restoreIds,
      grounded_test_identities: [...identities].sort(),
      result: "pass",
    });
  }

  const successScenarios = reportScenarios.filter(
    ({ kind }) => kind === "success",
  ).length;
  const faultScenarios = reportScenarios.length - successScenarios;
  return {
    schema_version: 1,
    evidence_source: "reviewed-story-manifest-and-execution-produced-tests",
    summary: {
      stories: stories.length,
      success_scenarios: successScenarios,
      fault_scenarios: faultScenarios,
      total_scenarios: reportScenarios.length,
      passed_scenarios: reportScenarios.length,
      source_steps_executed: sourceStepsExecuted,
      restore_steps_executed: restoreStepsExecuted,
    },
    scenarios: reportScenarios,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSupplementalStoryEvidence(
  value: unknown,
): SupplementalStoryEvidence[] {
  if (
    !isRecord(value) ||
    value.success !== true ||
    typeof value.numTotalTests !== "number" ||
    value.numTotalTests < 1 ||
    value.numPassedTests !== value.numTotalTests ||
    value.numFailedTests !== 0 ||
    value.numPendingTests !== 0 ||
    value.numTodoTests !== 0 ||
    typeof value.numTotalTestSuites !== "number" ||
    value.numPassedTestSuites !== value.numTotalTestSuites ||
    value.numFailedTestSuites !== 0 ||
    value.numPendingTestSuites !== 0 ||
    !Array.isArray(value.testResults)
  ) {
    throw new Error("Supplemental story execution report must be green.");
  }
  const byRequirement = new Map<string, SupplementalStoryEvidence>();
  for (const suite of value.testResults) {
    if (
      !isRecord(suite) ||
      typeof suite.name !== "string" ||
      !isAbsolute(suite.name) ||
      !existsSync(suite.name) ||
      !Array.isArray(suite.assertionResults)
    ) {
      throw new Error("Supplemental story suite evidence is malformed.");
    }
    for (const assertion of suite.assertionResults) {
      if (
        !isRecord(assertion) ||
        !Array.isArray(assertion.ancestorTitles) ||
        assertion.ancestorTitles.some(
          (title) => typeof title !== "string" || title.length === 0,
        ) ||
        typeof assertion.title !== "string" ||
        assertion.title.length === 0 ||
        !isRecord(assertion.meta)
      ) {
        throw new Error("Supplemental story assertion evidence is malformed.");
      }
      const ids = assertion.meta.story_contract_ids;
      const identity = assertion.meta.story_test_identity;
      if (ids === undefined && identity === undefined) continue;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.some(
          (id) => typeof id !== "string" || !id.startsWith("contract:"),
        ) ||
        typeof identity !== "string"
      ) {
        throw new Error("Supplemental story evidence metadata is incomplete.");
      }
      const actualIdentity = [
        ...(assertion.ancestorTitles as string[]),
        assertion.title,
      ].join(" > ");
      if (identity !== actualIdentity) {
        throw new Error(
          `Supplemental story identity metadata ${identity} does not match ${actualIdentity}.`,
        );
      }
      if (assertion.status !== "passed") {
        throw new Error(`Supplemental story test ${identity} did not pass.`);
      }
      for (const requirement of ids as string[]) {
        if (byRequirement.has(requirement)) {
          throw new Error(
            `Duplicate supplemental story evidence ${requirement}.`,
          );
        }
        const testFile = relative(process.cwd(), suite.name).replaceAll(
          "\\",
          "/",
        );
        if (
          testFile.length === 0 ||
          testFile.startsWith("../") ||
          isAbsolute(testFile)
        ) {
          throw new Error(
            `Supplemental story test ${identity} is outside the package.`,
          );
        }
        byRequirement.set(requirement, {
          requirement,
          test_file: testFile,
          test_identity: identity,
          execution_result: "pass",
        });
      }
    }
  }
  return [...byRequirement.values()].sort((left, right) =>
    left.requirement.localeCompare(right.requirement),
  );
}
