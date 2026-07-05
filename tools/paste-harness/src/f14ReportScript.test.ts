import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("F14 report generation script", () => {
  it("reproduces threshold summary and cross-tab artifacts", async () => {
    const campaignDir = resolve(
      import.meta.dirname,
      "../campaigns/f14-soak-matrix-20260705",
    );
    const tempDir = await mkdtemp(join(tmpdir(), "f14-report-test-"));
    try {
      const thresholdPath = join(tempDir, "threshold-summary.json");
      const crossTabPath = join(tempDir, "cross-tab.json");
      await execFileAsync(
        process.execPath,
        [
          join(campaignDir, "generate-threshold-reports.mjs"),
          "--threshold",
          thresholdPath,
          "--cross-tab",
          crossTabPath,
        ],
        { cwd: campaignDir },
      );

      await expect(readFile(thresholdPath, "utf8")).resolves.toBe(
        await readFile(join(campaignDir, "threshold-summary.json"), "utf8"),
      );
      await expect(readFile(crossTabPath, "utf8")).resolves.toBe(
        await readFile(join(campaignDir, "cross-tab.json"), "utf8"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
