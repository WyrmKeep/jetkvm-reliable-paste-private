import { readFile, writeFile } from "node:fs/promises";

import { FAULT_LABELS, type FaultLabel } from "./classifier.js";
import {
  collectManualExclusions,
  isRunExcludedFromThresholds,
  parseLedgerText,
  thresholdExclusionReason,
  type LedgerRecord,
  type ManualExclusionAnnotationRecord,
  type RunLedgerRecord,
  type StepLedgerRecord,
} from "./ledger.js";

export interface DashboardOptions {
  warnings?: string[];
}

export async function writeDashboardFromLedger(
  ledgerPath: string,
  outputPath: string,
): Promise<void> {
  const ledgerText = await readFile(ledgerPath, "utf8");
  const parsed = parseLedgerText(ledgerText);
  await writeFile(outputPath, renderDashboardHtml(parsed.records, { warnings: parsed.warnings }), "utf8");
}

export function renderDashboardHtml(
  records: readonly LedgerRecord[],
  options: DashboardOptions = {},
): string {
  const runs = records.filter((record): record is RunLedgerRecord => record.record_type === "run");
  const steps = records.filter((record): record is StepLedgerRecord => record.record_type === "step");
  const annotations = records.filter(
    (record): record is ManualExclusionAnnotationRecord => record.record_type === "annotation",
  );
  const manualExclusions = collectManualExclusions(records);
  const incompleteRunIds = findIncompleteRunIds(runs, steps);
  const thresholdEligibleRuns = runs.filter((run) => !isRunExcludedFromThresholds(run, manualExclusions));
  const totals = summarizeTotals(thresholdEligibleRuns);
  const warnings = options.warnings ?? [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paste harness dashboard</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.4}
body{margin:2rem;max-width:1200px}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #999;padding:.35rem .5rem;text-align:left;vertical-align:top}
th{background:#eee;color:#111}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warning{border:1px solid #b7791f;background:#fff7db;color:#4a2a00;padding:.5rem;margin:.5rem 0}
.muted{opacity:.75}
</style>
</head>
<body>
<h1>Paste harness dashboard</h1>
<p class="muted">Deterministic rendering from ledger rows only. No wall-clock or random values are embedded.</p>
${warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join("")}
<h2>Summary</h2>
<table>
<tbody>
<tr><th>Runs</th><td>${runs.length}</td></tr>
<tr><th>Steps</th><td>${steps.length}</td></tr>
<tr><th>Annotations</th><td>${annotations.length}</td></tr>
<tr><th>Threshold-eligible run duration</th><td>${formatDuration(totals.durationMs)}</td></tr>
<tr><th>Excluded from thresholds</th><td>${runs.filter((run) =>
    isRunExcludedFromThresholds(run, manualExclusions),
  ).length}</td></tr>
<tr><th>Threshold-eligible runs</th><td>${thresholdEligibleRuns.length}</td></tr>
</tbody>
</table>
<h2>Threshold-eligible per-class error rates</h2>
<table>
<thead><tr><th>Class</th><th>Errors</th><th>Rate</th></tr></thead>
<tbody>
${FAULT_LABELS.map(
  (label) =>
    `<tr><td>${escapeHtml(label)}</td><td>${totals.errorCounts[label]}</td><td>${formatRate(
      totals.errorCounts[label],
      totals.denominator,
    )}</td></tr>`,
).join("\n")}
</tbody>
</table>
<h2>Runs</h2>
<table>
<thead>
<tr><th>Run</th><th>Timestamp</th><th>Purpose</th><th>Path</th><th>Outcome</th><th>Duration</th>${FAULT_LABELS.map(
    (label) => `<th>${escapeHtml(label)}</th>`,
  ).join("")}</tr>
</thead>
<tbody>
${runs.map(renderRunRow).join("\n")}
</tbody>
</table>
<h2>Steps</h2>
<table>
<thead><tr><th>Run</th><th>Step</th><th>Name</th><th>Outcome</th><th>Timestamp</th><th>Duration</th></tr></thead>
<tbody>
${steps.map(renderStepRow).join("\n")}
</tbody>
</table>
${renderAnnotations(annotations)}
${renderIncompleteRuns(incompleteRunIds, steps)}
<h2>Run details</h2>
${runs.map((run) => renderRunDetail(run, steps.filter((step) => step.run_id === run.run_id), manualExclusions)).join("\n")}
</body>
</html>
`;
}

function renderRunRow(run: RunLedgerRecord): string {
  return `<tr><td><a href="#run-${escapeAttribute(run.run_id)}">${escapeHtml(run.run_id)}</a></td><td>${escapeHtml(
    run.timestamp,
  )}</td><td>${escapeHtml(run.purpose)}</td><td>${escapeHtml(run.injection_path)}</td><td>${escapeHtml(
    run.outcome,
  )}</td><td>${formatDuration(run.duration_ms)}</td>${FAULT_LABELS.map((label) => {
    const count = run.per_class_error_vector[label] ?? 0;
    return `<td>${count} <span class="muted">(${formatRate(count, runDenominator(run))})</span></td>`;
  }).join("")}</tr>`;
}

function renderStepRow(step: StepLedgerRecord): string {
  return `<tr><td><a href="#run-${escapeAttribute(step.run_id)}">${escapeHtml(
    step.run_id,
  )}</a></td><td>${escapeHtml(step.step_id)}</td><td>${escapeHtml(step.name)}</td><td>${escapeHtml(
    step.outcome,
  )}</td><td>${escapeHtml(step.timestamp)}</td><td>${formatDuration(step.duration_ms)}</td></tr>`;
}

function renderRunDetail(
  run: RunLedgerRecord,
  steps: StepLedgerRecord[],
  manualExclusions: ReadonlyMap<string, ManualExclusionAnnotationRecord>,
): string {
  const exclusionReason = thresholdExclusionReason(run, manualExclusions);
  return `<section id="run-${escapeAttribute(run.run_id)}">
<h3>${escapeHtml(run.run_id)}</h3>
<ul>
<li>Corpus: <code>${escapeHtml(run.corpus.id)}</code> (<code>${escapeHtml(run.corpus.hash)}</code>)</li>
<li>Corpus path: <code>${escapeHtml(run.corpus.path)}</code></li>
<li>Build: <code>${escapeHtml(run.build_sha)}</code>, device layout <code>${escapeHtml(
    run.device_layout,
  )}</code>, host decode layout <code>${escapeHtml(run.host_decode_layout)}</code></li>
<li>Focus guard: <code>${escapeHtml(run.focus_guard_result)}</code>, sink RSS ${run.sink_rss_bytes}</li>
<li>Harness: <code>${escapeHtml(run.harness_version)}</code>, classifier <code>${escapeHtml(
    run.classifier_version,
  )}</code></li>
<li>Preflight: ok=${String(run.preflight.ok)}, auto-update=${String(
    run.preflight.device.autoUpdateEnabled,
  )}, capsLockOff=${String(run.preflight.caps_lock_off)}, offset=${run.device_clock_offset_ms.toFixed(3)} ms</li>
<li>Telemetry: calm=${String(run.telemetry_summary.calm)}, max CPU=${run.telemetry_summary.max_cpu_percent}</li>
<li>Garble events pre-repair: ${run.garble_events_pre_repair}, excluded=${String(
    isRunExcludedFromThresholds(run, manualExclusions),
  )}${exclusionReason ? `, excluded reason: <code>${escapeHtml(exclusionReason)}</code>` : ""}</li>
<li>Artifacts: <a href="${escapeAttribute(run.artifacts.tee_log_path)}">${escapeHtml(
    run.artifacts.tee_log_path,
  )}</a>, <a href="${escapeAttribute(run.artifacts.recv_txt_path)}">${escapeHtml(
    run.artifacts.recv_txt_path,
  )}</a></li>
<li>HID output reports: ${run.hid_output_reports}, focus events: ${run.focus_guard_events.length}</li>
</ul>
<p>Steps: ${steps.map((step) => `<code>${escapeHtml(step.name)}:${formatDuration(step.duration_ms)}</code>`).join(
    " ",
  )}</p>
</section>`;
}

function renderAnnotations(annotations: ManualExclusionAnnotationRecord[]): string {
  if (annotations.length === 0) {
    return "";
  }
  return `<h2>Annotations</h2>
<table>
<thead><tr><th>Run</th><th>Type</th><th>Timestamp</th><th>Reason</th><th>Source</th></tr></thead>
<tbody>
${annotations
  .map(
    (annotation) =>
      `<tr><td><a href="#run-${escapeAttribute(annotation.run_id)}">${escapeHtml(
        annotation.run_id,
      )}</a></td><td>${escapeHtml(annotation.annotation_type)}</td><td>${escapeHtml(
        annotation.timestamp,
      )}</td><td>${escapeHtml(annotation.excluded_reason)}</td><td>${escapeHtml(
        annotation.source,
      )}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
}

function findIncompleteRunIds(runs: RunLedgerRecord[], steps: StepLedgerRecord[]): string[] {
  const completeRunIds = new Set(runs.map((run) => run.run_id));
  return [...new Set(steps.map((step) => step.run_id))]
    .filter((runId) => !completeRunIds.has(runId))
    .sort();
}

function renderIncompleteRuns(runIds: string[], steps: StepLedgerRecord[]): string {
  if (runIds.length === 0) {
    return "";
  }
  return `<h2>Incomplete runs</h2>
<table>
<thead><tr><th>Run</th><th>Observed steps</th><th>Last outcome</th></tr></thead>
<tbody>
${runIds
  .map((runId) => {
    const runSteps = steps.filter((step) => step.run_id === runId);
    const lastStep = runSteps[runSteps.length - 1];
    return `<tr><td><code>${escapeHtml(runId)}</code></td><td>${runSteps.length}</td><td>${escapeHtml(
      lastStep?.outcome ?? "unknown",
    )}</td></tr>`;
  })
  .join("\n")}
</tbody>
</table>`;
}

function summarizeTotals(runs: RunLedgerRecord[]): {
  durationMs: number;
  denominator: number;
  errorCounts: Record<FaultLabel, number>;
} {
  const errorCounts = Object.fromEntries(FAULT_LABELS.map((label) => [label, 0])) as Record<
    FaultLabel,
    number
  >;
  let denominator = 0;
  let durationMs = 0;
  for (const run of runs) {
    durationMs += run.duration_ms;
    denominator += runDenominator(run);
    for (const label of FAULT_LABELS) {
      errorCounts[label] += run.per_class_error_vector[label] ?? 0;
    }
  }
  return { durationMs, denominator: Math.max(denominator, 1), errorCounts };
}

function runDenominator(run: RunLedgerRecord): number {
  const explicitSize = typeof run.corpus_size === "number" ? run.corpus_size : undefined;
  if (explicitSize !== undefined && explicitSize > 0) {
    return explicitSize;
  }
  const match = /(?:^|[:;,])size=(\d+)(?:$|[:;,])/.exec(run.corpus.id);
  return match?.[1] ? Number(match[1]) : 1;
}

function formatDuration(durationMs: number): string {
  return `${durationMs.toFixed(0)} ms`;
}

function formatRate(count: number, denominator: number): string {
  return `${((count / Math.max(denominator, 1)) * 100).toFixed(4)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
