#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NON_GARBLE_ERROR_LABELS = [
  "drop",
  "insertion",
  "same-length-substitution",
  "case-error",
  "stuck-modifier-run",
];

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    ledger: "ledger.jsonl",
    cells: "cell-definitions.json",
    threshold: "threshold-summary.json",
    crossTab: "cross-tab.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--ledger" && value) {
      args.ledger = value;
      index += 1;
    } else if (arg === "--cells" && value) {
      args.cells = value;
      index += 1;
    } else if (arg === "--threshold" && value) {
      args.threshold = value;
      index += 1;
    } else if (arg === "--cross-tab" && value) {
      args.crossTab = value;
      index += 1;
    } else {
      throw new Error(
        "usage: node generate-threshold-reports.mjs [--ledger ledger.jsonl] [--cells cell-definitions.json] [--threshold threshold-summary.json] [--cross-tab cross-tab.json]",
      );
    }
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readLedger(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function collectManualExclusions(records) {
  return new Map(
    records
      .filter(
        (record) =>
          record.record_type === "annotation" &&
          record.annotation_type === "manual_exclusion" &&
          typeof record.run_id === "string",
      )
      .map((record) => [record.run_id, record]),
  );
}

function isExcluded(run, manualExclusions) {
  return run.excluded_from_thresholds === true || manualExclusions.has(run.run_id);
}

function vector(run) {
  return run.per_class_error_vector ?? {};
}

function totalErrors(run) {
  const errorVector = vector(run);
  return NON_GARBLE_ERROR_LABELS.reduce((sum, label) => sum + Number(errorVector[label] ?? 0), 0);
}

function raceErrors(run) {
  const errorVector = vector(run);
  return Number(errorVector["same-length-substitution"] ?? 0) + Number(errorVector["case-error"] ?? 0);
}

function garbleEvents(run) {
  return Number(run.garble_events_pre_repair ?? vector(run)["layout-swap-signature"] ?? 0);
}

function productDetails(run, threshold, pass, reasons) {
  return {
    cell_id: run.cell_id,
    threshold: threshold.name,
    pass,
    reasons,
    run_id: run.run_id,
    outcome: run.outcome,
    corpus_size: Number(run.corpus_size ?? run.corpus?.size ?? 0),
    total_errors: totalErrors(run),
    garble: garbleEvents(run),
    verification_mode: run.product_path?.verification_mode ?? run.injection_details?.product_path?.verification_mode ?? "unknown",
    ocr_calibration: run.product_path?.ocr_calibration ?? run.injection_details?.product_path?.ocr_calibration ?? "unknown",
    duration_ms: run.duration_ms,
  };
}

function evaluateProductRun(run, threshold) {
  const reasons = [];
  if (run.outcome !== "completed") {
    reasons.push(`outcome=${run.outcome}`);
  }
  if (garbleEvents(run) > threshold.max_garble) {
    reasons.push(`garble=${garbleEvents(run)}>${threshold.max_garble}`);
  }
  if (totalErrors(run) > threshold.max_total) {
    reasons.push(`total_errors=${totalErrors(run)}>${threshold.max_total}`);
  }
  if (threshold.max_drop !== undefined && Number(vector(run).drop ?? 0) > threshold.max_drop) {
    reasons.push(`drop=${Number(vector(run).drop ?? 0)}>${threshold.max_drop}`);
  }
  if (threshold.max_race !== undefined && raceErrors(run) > threshold.max_race) {
    reasons.push(`race=${raceErrors(run)}>${threshold.max_race}`);
  }
  return reasons;
}

function summarizeProductCells(runs, manualExclusions, definitions) {
  return definitions.product_cells.map((cell) => {
    const threshold = { name: cell.threshold, ...definitions.thresholds[cell.threshold] };
    const candidates = runs
      .filter((run) => run.cell_id === cell.cell_id && !isExcluded(run, manualExclusions))
      .sort(compareRunTimestamp);
    const evaluated = candidates.map((run) => {
      const reasons = evaluateProductRun(run, threshold);
      return productDetails(run, threshold, reasons.length === 0, reasons);
    });
    const selected = [...evaluated].reverse().find((entry) => entry.pass) ?? evaluated[evaluated.length - 1];
    if (selected) {
      return selected;
    }
    return {
      cell_id: cell.cell_id,
      threshold: cell.threshold,
      pass: false,
      reasons: ["no threshold-eligible run"],
      run_id: null,
      outcome: null,
      corpus_size: 0,
      total_errors: 0,
      garble: 0,
      verification_mode: null,
      ocr_calibration: null,
      duration_ms: 0,
    };
  });
}

function summarizeTargetCells(runs, manualExclusions, definitions) {
  return definitions.target_cells.map((cellId) => {
    const cellRuns = runs.filter((run) => run.cell_id === cellId).sort(compareRunTimestamp);
    return {
      cell_id: cellId,
      completed_runs: cellRuns.filter((run) => run.outcome === "completed").map((run) => run.run_id),
      completed_eligible_runs: cellRuns
        .filter((run) => run.outcome === "completed" && !isExcluded(run, manualExclusions))
        .map((run) => run.run_id),
      all_runs: cellRuns.map((run) => ({
        run_id: run.run_id,
        outcome: run.outcome,
        excluded: isExcluded(run, manualExclusions),
        garble: garbleEvents(run),
        total_errors: totalErrors(run),
      })),
    };
  });
}

function summarizeRobustness(runs, steps, definitions) {
  const robustness = definitions.robustness;
  const runReason = (run) => run.preflight?.reason ?? run.outcome;
  return {
    unattended_batch: {
      attended: robustness.unattended_batch.attended,
      cell_id: robustness.unattended_batch.cell_id,
      purpose: robustness.unattended_batch.purpose,
      completed_runs: runs
        .filter(
          (run) =>
            run.cell_id === robustness.unattended_batch.cell_id &&
            run.purpose === robustness.unattended_batch.purpose &&
            run.outcome === "completed",
        )
        .sort(compareRunTimestamp)
        .map((run) => run.run_id),
    },
    watchdog_abort_rows: runs
      .filter((run) => run.cell_id === robustness.watchdog_cell_id)
      .sort(compareRunTimestamp)
      .map((run) => ({
        run_id: run.run_id,
        outcome: run.outcome,
        reason: runReason(run),
      })),
    focus_lost_rows: runs
      .filter((run) => run.cell_id === robustness.focus_cell_id && run.outcome === "focus_lost")
      .sort(compareRunTimestamp)
      .map((run) => ({
        run_id: run.run_id,
        outcome: run.outcome,
        reason: runReason(run),
      })),
    kill9_resume_rows: runs
      .filter((run) => run.cell_id === robustness.kill9_resume_cell_id)
      .sort(compareRunTimestamp)
      .map((run) => ({
        run_id: run.run_id,
        outcome: run.outcome,
      })),
    kill9_partial_steps: steps
      .filter((step) => step.details?.purpose === robustness.kill9_partial_purpose)
      .sort(compareStepTimestamp)
      .map((step) => step.run_id),
    focus_setup_abort_rows: runs
      .filter((run) => run.cell_id === robustness.focus_cell_id && run.outcome === "abort:focus")
      .sort(compareRunTimestamp)
      .map((run) => ({
        run_id: run.run_id,
        outcome: run.outcome,
        reason: runReason(run),
      })),
  };
}

function findSoakRunsWithoutSpecCell(runs, definitions) {
  const knownCells = new Set([
    ...definitions.product_cells.map((cell) => cell.cell_id),
    ...definitions.target_cells,
    definitions.robustness.watchdog_cell_id,
    definitions.robustness.focus_cell_id,
    definitions.robustness.kill9_resume_cell_id,
  ]);
  return runs
    .filter((run) => run.purpose.startsWith("f14_") && !knownCells.has(run.cell_id))
    .map((run) => ({ run_id: run.run_id, cell_id: run.cell_id, purpose: run.purpose }));
}

function compareRunTimestamp(a, b) {
  return String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.run_id).localeCompare(String(b.run_id));
}

function compareStepTimestamp(a, b) {
  return String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.step_id).localeCompare(String(b.step_id));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = resolve(__dirname, args.ledger);
  const definitionsPath = resolve(__dirname, args.cells);
  const thresholdPath = resolve(__dirname, args.threshold);
  const crossTabPath = resolve(__dirname, args.crossTab);

  const definitions = await readJson(definitionsPath);
  const records = await readLedger(ledgerPath);
  const runs = records.filter((record) => record.record_type === "run").sort(compareRunTimestamp);
  const steps = records.filter((record) => record.record_type === "step").sort(compareStepTimestamp);
  const manualExclusions = collectManualExclusions(records);

  const productSummary = summarizeProductCells(runs, manualExclusions, definitions);
  const targetSummary = summarizeTargetCells(runs, manualExclusions, definitions);
  const robustnessSummary = summarizeRobustness(runs, steps, definitions);

  const productOrphans = productSummary
    .filter((entry) => entry.run_id === null || entry.pass !== true)
    .map((entry) => entry.cell_id);
  const targetOrphans = targetSummary
    .filter((entry) => entry.completed_runs.length === 0)
    .map((entry) => entry.cell_id);
  const soakRunsWithoutSpecCell = findSoakRunsWithoutSpecCell(runs, definitions);

  const thresholdSummary = {
    generated_at: definitions.generated_at,
    build: definitions.build,
    product_summary: productSummary,
    robustness_summary: robustnessSummary,
  };
  const crossTab = {
    product_orphans: productOrphans,
    target_orphans: targetOrphans,
    soak_runs_without_spec_cell: soakRunsWithoutSpecCell,
    product_summary: productSummary,
    target_summary: targetSummary,
    robustness_summary: robustnessSummary,
  };

  await writeFile(thresholdPath, `${JSON.stringify(thresholdSummary, null, 2)}\n`, "utf8");
  await writeFile(crossTabPath, `${JSON.stringify(crossTab, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
