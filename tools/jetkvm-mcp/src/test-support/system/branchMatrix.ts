import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../../domain.js";
import {
  FOCUSED_ASSERTION_OWNER_PHASES,
  TOOL_BEHAVIOR_MATRIX,
  validateFocusedAssertionExecutions,
  type FocusedAssertionExecutionResult,
  type FocusedAssertionOwnerPhase,
  type ToolBehaviorMatrix,
} from "../../stories/manifest.js";

export interface VitestJsonAssertionResult {
  ancestorTitles: string[];
  fullName: string;
  status: string;
  title: string;
  duration?: number;
  failureMessages: unknown[];
  meta: {
    focused_assertion_ids?: string[];
    focused_test_identity?: string;
    [key: string]: unknown;
  };
  tags?: unknown[];
}

export interface VitestJsonSuiteResult {
  name: string;
  status: string;
  assertionResults: VitestJsonAssertionResult[];
  [key: string]: unknown;
}

export interface VitestJsonReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numPendingTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success: boolean;
  testResults: VitestJsonSuiteResult[];
  [key: string]: unknown;
}

type ApplicableReportCell = Readonly<{
  requirement: string;
  tool: JetKvmToolName;
  applicability: "applicable";
  coverage_scope: "tool" | "shared_transport";
  story_id: string;
  step_id: string;
  fault_id: string;
  assertion_id: string;
  focused_assertion_id: string;
  focused_assertion_owner_phase: FocusedAssertionOwnerPhase;
  test_file: string;
  test_identity: string;
  execution_result: "pass";
}>;

type NotApplicableReportCell = Readonly<{
  requirement: string;
  tool: JetKvmToolName;
  applicability: "not_applicable";
  rationale: string;
}>;

export type GroundedBranchMatrixCell =
  | ApplicableReportCell
  | NotApplicableReportCell;

export type GroundedBranchMatrixReport = Readonly<{
  schema_version: 1;
  evidence_source: "execution-produced-vitest-json";
  summary: Readonly<{
    requirements: number;
    tools: number;
    applicable_cells: number;
    not_applicable_cells: number;
    passed_focused_assertions: number;
  }>;
  cells: readonly GroundedBranchMatrixCell[];
}>;

type GroundedExecution = Readonly<{
  focusedAssertionId: string;
  testIdentity: string;
  testFile: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Vitest JSON report ${name} must be a non-negative integer.`,
    );
  }
  return value as number;
}

function parseReport(value: unknown): VitestJsonReport {
  if (!isRecord(value) || !Array.isArray(value.testResults)) {
    throw new Error("Vitest JSON report is malformed.");
  }
  const report = value as unknown as VitestJsonReport;
  const counts = [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ] as const;
  for (const name of counts) finiteCount(report[name], name);
  if (typeof report.success !== "boolean") {
    throw new Error("Vitest JSON report success must be boolean.");
  }
  return report;
}

function assertGreen(report: VitestJsonReport): void {
  if (
    !report.success ||
    report.numFailedTestSuites !== 0 ||
    report.numFailedTests !== 0
  ) {
    throw new Error("Focused Vitest execution must be completely green.");
  }
  if (report.numPendingTestSuites !== 0 || report.numPendingTests !== 0) {
    throw new Error(
      "Focused Vitest execution contains pending or skipped tests.",
    );
  }
  if (report.numTodoTests !== 0) {
    throw new Error("Focused Vitest execution contains todo tests.");
  }
  if (
    report.numPassedTests !== report.numTotalTests ||
    report.numPassedTestSuites !== report.numTotalTestSuites
  ) {
    throw new Error(
      "Focused Vitest execution did not pass every test and suite.",
    );
  }
}

function parseFocusedExecutions(report: VitestJsonReport): GroundedExecution[] {
  const executions: GroundedExecution[] = [];
  for (const suite of report.testResults) {
    if (
      !isRecord(suite) ||
      typeof suite.name !== "string" ||
      !Array.isArray(suite.assertionResults)
    ) {
      throw new Error("Vitest JSON suite result is malformed.");
    }
    if (!isAbsolute(suite.name) || !existsSync(suite.name)) {
      throw new Error(`Focused test file does not exist: ${suite.name}.`);
    }
    for (const assertion of suite.assertionResults) {
      if (
        !isRecord(assertion) ||
        !Array.isArray(assertion.ancestorTitles) ||
        typeof assertion.title !== "string" ||
        !isRecord(assertion.meta)
      ) {
        throw new Error("Vitest JSON assertion result is malformed.");
      }
      const ids = assertion.meta.focused_assertion_ids;
      const identity = assertion.meta.focused_test_identity;
      const hasIds = ids !== undefined;
      const hasIdentity = identity !== undefined;
      if (!hasIds && !hasIdentity) continue;
      if (!hasIds || !hasIdentity) {
        throw new Error(
          "Vitest assertion has incomplete focused assertion metadata.",
        );
      }
      if (
        !Array.isArray(ids) ||
        ids.length !== 1 ||
        typeof ids[0] !== "string" ||
        ids[0].length === 0
      ) {
        throw new Error(
          "Each Vitest assertion must carry exactly one focused assertion ID.",
        );
      }
      if (typeof identity !== "string" || identity.length === 0) {
        throw new Error(
          "Focused test identity metadata must be a non-empty string.",
        );
      }
      const ancestors = assertion.ancestorTitles;
      if (
        ancestors.some(
          (entry) => typeof entry !== "string" || entry.length === 0,
        )
      ) {
        throw new Error("Focused assertion ancestor titles are malformed.");
      }
      const actualIdentity = [...ancestors, assertion.title].join(" > ");
      if (identity !== actualIdentity) {
        throw new Error(
          `Focused test identity metadata ${identity} does not match executed identity ${actualIdentity}.`,
        );
      }
      if (assertion.status !== "passed") {
        throw new Error(
          `Focused assertion ${ids[0]} execution was ${assertion.status}.`,
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
          `Focused test identity ${identity} is outside the package.`,
        );
      }
      executions.push({
        focusedAssertionId: ids[0],
        testIdentity: identity,
        testFile,
      });
    }
  }
  return executions;
}

export function buildGroundedBranchMatrixReport(
  rawReport: unknown,
  matrix: ToolBehaviorMatrix = TOOL_BEHAVIOR_MATRIX,
): GroundedBranchMatrixReport {
  const report = parseReport(rawReport);
  assertGreen(report);
  const executions = parseFocusedExecutions(report);

  const ownerById = new Map<string, FocusedAssertionOwnerPhase>();
  for (const row of matrix) {
    for (const cell of Object.values(row.cells)) {
      if (cell.applicability !== "applicable") continue;
      if (ownerById.has(cell.focused_assertion_id)) {
        throw new Error(
          `Behavior matrix has duplicate focused assertion ID ${cell.focused_assertion_id}.`,
        );
      }
      ownerById.set(
        cell.focused_assertion_id,
        cell.focused_assertion_owner_phase,
      );
    }
  }

  const evidenceById = new Map<string, GroundedExecution>();
  const grouped = new Map<
    FocusedAssertionOwnerPhase,
    FocusedAssertionExecutionResult[]
  >(FOCUSED_ASSERTION_OWNER_PHASES.map((phase) => [phase, []]));
  const seenIdentities = new Set<string>();
  for (const execution of executions) {
    const owner = ownerById.get(execution.focusedAssertionId);
    if (owner === undefined) {
      throw new Error(
        `Focused assertion ${execution.focusedAssertionId} is not reserved by the behavior matrix.`,
      );
    }
    if (evidenceById.has(execution.focusedAssertionId)) {
      throw new Error(
        `Duplicate focused assertion ID ${execution.focusedAssertionId}.`,
      );
    }
    if (seenIdentities.has(execution.testIdentity)) {
      throw new Error(`Duplicate test identity ${execution.testIdentity}.`);
    }
    evidenceById.set(execution.focusedAssertionId, execution);
    seenIdentities.add(execution.testIdentity);
    grouped.get(owner)!.push({
      focused_assertion_id: execution.focusedAssertionId,
      test_identity: execution.testIdentity,
      result: "pass",
    });
  }

  for (const owner of FOCUSED_ASSERTION_OWNER_PHASES) {
    validateFocusedAssertionExecutions(owner, grouped.get(owner)!, matrix);
  }

  const cells: GroundedBranchMatrixCell[] = [];
  let applicableCells = 0;
  let notApplicableCells = 0;
  for (const row of matrix) {
    for (const tool of JETKVM_TOOL_NAMES) {
      const cell = row.cells[tool];
      if (cell.applicability === "not_applicable") {
        notApplicableCells += 1;
        cells.push({
          requirement: row.requirement,
          tool,
          applicability: "not_applicable",
          rationale: cell.rationale,
        });
        continue;
      }
      applicableCells += 1;
      const evidence = evidenceById.get(cell.focused_assertion_id);
      if (evidence === undefined) {
        throw new Error(
          `Missing grounded evidence for ${cell.focused_assertion_id}.`,
        );
      }
      cells.push({
        requirement: row.requirement,
        tool,
        applicability: "applicable",
        coverage_scope: cell.coverage_scope,
        story_id: cell.story_id,
        step_id: cell.step_id,
        fault_id: cell.fault_id,
        assertion_id: cell.assertion_id,
        focused_assertion_id: cell.focused_assertion_id,
        focused_assertion_owner_phase: cell.focused_assertion_owner_phase,
        test_file: evidence.testFile,
        test_identity: evidence.testIdentity,
        execution_result: "pass",
      });
    }
  }

  return {
    schema_version: 1,
    evidence_source: "execution-produced-vitest-json",
    summary: {
      requirements: matrix.length,
      tools: JETKVM_TOOL_NAMES.length,
      applicable_cells: applicableCells,
      not_applicable_cells: notApplicableCells,
      passed_focused_assertions: evidenceById.size,
    },
    cells,
  };
}
