import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(packageRoot, "node_modules/vitest/vitest.mjs");
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
          `Vitest story-E2E stage failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

async function run() {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "jetkvm-stories-"));
  const executionPath = resolve(temporaryRoot, "system-executions.json");
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
    await mkdir(resolve(packageRoot, "reports"), { recursive: true });
    await runVitest(
      [
        "run",
        "src/test-support/system/branchMatrix.test.ts",
        "src/test-support/system/storyRunner.test.ts",
        "--allowOnly=false",
      ],
      {
        ...process.env,
        JETKVM_FOCUSED_EXECUTION_REPORT: executionPath,
        JETKVM_STORY_EXECUTION_REPORT: executionPath,
        ...(write
          ? {
              JETKVM_WRITE_BRANCH_MATRIX: "1",
              JETKVM_WRITE_STORY_E2E: "1",
            }
          : {}),
      },
    );
    const report = JSON.parse(
      await readFile(resolve(packageRoot, "reports/story-e2e.json"), "utf8"),
    );
    process.stdout.write(
      `story E2E grounded: ${String(report.summary.passed_scenarios)}/${String(report.summary.total_scenarios)} scenarios across ${String(report.summary.stories)} stories\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await run();
