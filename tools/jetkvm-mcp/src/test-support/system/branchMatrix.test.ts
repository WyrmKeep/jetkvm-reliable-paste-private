import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { JETKVM_TOOL_NAMES } from "../../domain.js";
import {
  TOOL_BEHAVIOR_MATRIX,
  loadAcceptanceStories,
  type ToolBehaviorMatrix,
} from "../../stories/manifest.js";
import {
  buildGroundedBranchMatrixReport,
  type VitestJsonReport,
} from "./branchMatrix.js";

function executionReport(
  matrix: ToolBehaviorMatrix = TOOL_BEHAVIOR_MATRIX,
): VitestJsonReport {
  const assertionResults = matrix.flatMap((row) =>
    JETKVM_TOOL_NAMES.flatMap((tool) => {
      const cell = row.cells[tool];
      if (cell.applicability !== "applicable") return [];
      const title = `${tool} ${row.requirement}`;
      const suite = `Focused ${cell.focused_assertion_owner_phase}`;
      return [
        {
          ancestorTitles: [suite],
          fullName: `${suite} ${title}`,
          status: "passed",
          title,
          duration: 1,
          failureMessages: [],
          meta: {
            focused_assertion_ids: [cell.focused_assertion_id],
            focused_test_identity: `${suite} > ${title}`,
          },
          tags: [],
        },
      ];
    }),
  );
  return {
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: assertionResults.length,
    numPassedTests: assertionResults.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [
      {
        name: resolve("src/test-support/system/branchMatrix.test.ts"),
        status: "passed",
        assertionResults,
      },
    ],
  };
}

function cloneReport(): VitestJsonReport {
  return structuredClone(executionReport());
}

describe("grounded branch matrix", () => {
  it("resolves every applicable cell from exact passed Vitest metadata", () => {
    const report = buildGroundedBranchMatrixReport(executionReport());

    expect(report.schema_version).toBe(1);
    expect(report.summary).toEqual({
      requirements: TOOL_BEHAVIOR_MATRIX.length,
      tools: JETKVM_TOOL_NAMES.length,
      applicable_cells: 193,
      not_applicable_cells: 127,
      passed_focused_assertions: 193,
    });
    expect(report.cells).toHaveLength(
      TOOL_BEHAVIOR_MATRIX.length * JETKVM_TOOL_NAMES.length,
    );
    expect(
      report.cells
        .filter((cell) => cell.applicability === "applicable")
        .every(
          (cell) =>
            cell.applicability === "applicable" &&
            cell.execution_result === "pass" &&
            cell.test_identity.length > 0 &&
            cell.test_file.endsWith("branchMatrix.test.ts"),
        ),
    ).toBe(true);
  });

  it("rejects missing, duplicate, unknown, or mismatched focused evidence", () => {
    const missing = cloneReport();
    missing.testResults[0]!.assertionResults.pop();
    missing.numTotalTests -= 1;
    missing.numPassedTests -= 1;
    expect(() => buildGroundedBranchMatrixReport(missing)).toThrowError(
      /Missing focused assertion executions/,
    );

    const duplicate = cloneReport();
    duplicate.testResults[0]!.assertionResults.push(
      structuredClone(duplicate.testResults[0]!.assertionResults[0]!),
    );
    duplicate.numTotalTests += 1;
    duplicate.numPassedTests += 1;
    expect(() => buildGroundedBranchMatrixReport(duplicate)).toThrowError(
      /Duplicate focused assertion ID|Duplicate test identity/,
    );

    const unknown = cloneReport();
    unknown.testResults[0]!.assertionResults[0]!.meta.focused_assertion_ids = [
      "unknown:assertion",
    ];
    expect(() => buildGroundedBranchMatrixReport(unknown)).toThrowError(
      /not reserved/,
    );

    const mismatch = cloneReport();
    mismatch.testResults[0]!.assertionResults[0]!.meta.focused_test_identity =
      "fabricated identity";
    expect(() => buildGroundedBranchMatrixReport(mismatch)).toThrowError(
      /identity.*metadata/i,
    );
  });

  it("rejects failed, skipped, todo, incomplete, and multi-ID executions", () => {
    const failed = cloneReport();
    failed.success = false;
    failed.numFailedTests = 1;
    expect(() => buildGroundedBranchMatrixReport(failed)).toThrowError(
      /must be completely green/,
    );

    const pending = cloneReport();
    pending.numPendingTests = 1;
    expect(() => buildGroundedBranchMatrixReport(pending)).toThrowError(
      /pending|skipped/i,
    );

    const todo = cloneReport();
    todo.numTodoTests = 1;
    expect(() => buildGroundedBranchMatrixReport(todo)).toThrowError(/todo/i);

    const incomplete = cloneReport();
    delete incomplete.testResults[0]!.assertionResults[0]!.meta
      .focused_test_identity;
    expect(() => buildGroundedBranchMatrixReport(incomplete)).toThrowError(
      /incomplete focused assertion metadata/i,
    );

    const multi = cloneReport();
    multi.testResults[0]!.assertionResults[0]!.meta.focused_assertion_ids!.push(
      "second:id",
    );
    expect(() => buildGroundedBranchMatrixReport(multi)).toThrowError(
      /exactly one focused assertion ID/i,
    );
  });
});

const executionReportPath = process.env.JETKVM_FOCUSED_EXECUTION_REPORT;
if (executionReportPath !== undefined) {
  it("grounds the release matrix in this run's exact focused executions", async () => {
    const raw = JSON.parse(
      await readFile(executionReportPath, "utf8"),
    ) as unknown;
    await loadAcceptanceStories(resolve("src/stories"));
    const report = buildGroundedBranchMatrixReport(raw);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = resolve("reports/branch-matrix.json");
    if (process.env.JETKVM_WRITE_BRANCH_MATRIX === "1") {
      await writeFile(reportPath, serialized, "utf8");
    } else {
      expect(await readFile(reportPath, "utf8")).toBe(serialized);
    }
  });
}
