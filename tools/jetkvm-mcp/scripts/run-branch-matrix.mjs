import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(packageRoot, "node_modules/vitest/vitest.mjs");
const reportPath = resolve(packageRoot, "reports/branch-matrix.json");
const write = process.argv.slice(2).includes("--write");

function runVitest(args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd: packageRoot,
      env: environment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `Vitest branch-matrix stage failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

async function run() {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "jetkvm-matrix-"));
  const executionPath = resolve(temporaryRoot, "focused-executions.json");
  try {
    await runVitest([
      "run",
      "src/handlers/inputDisplay.matrix.test.ts",
      "src/handlers/powerSession.matrix.test.ts",
      "src/mcp/legacySse.test.ts",
      "--allowOnly=false",
      "--reporter=json",
      `--outputFile=${executionPath}`,
    ]);
    await mkdir(dirname(reportPath), { recursive: true });
    await runVitest(
      [
        "run",
        "src/test-support/system/branchMatrix.test.ts",
        "--allowOnly=false",
      ],
      {
        ...process.env,
        JETKVM_FOCUSED_EXECUTION_REPORT: executionPath,
        ...(write ? { JETKVM_WRITE_BRANCH_MATRIX: "1" } : {}),
      },
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    process.stdout.write(
      `branch matrix grounded: ${String(report.summary.passed_focused_assertions)} applicable, ${String(report.summary.not_applicable_cells)} reviewed non-applicable\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await run();
