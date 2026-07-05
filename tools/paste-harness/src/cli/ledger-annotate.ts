import { parseLedgerFile, appendLedgerRecord, createManualExclusionAnnotation } from "../ledger.js";

import { failCli, optionalString, parseArgs, requiredString } from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = args.positional[0];
  if (!ledgerPath) {
    throw new Error(
      "usage: node ledger-annotate.js <ledger.jsonl> --run-id <run_id> --excluded-reason <reason> [--source <source>] [--timestamp <iso>] [--annotation-id <id>]",
    );
  }

  const runId = requiredString(args, "run-id");
  const excludedReason = requiredString(args, "excluded-reason");
  const source = optionalString(args, "source") ?? "manual";
  const timestamp = optionalString(args, "timestamp");
  const annotationId = optionalString(args, "annotation-id");

  const parsed = await parseLedgerFile(ledgerPath);
  if (parsed.warnings.length > 0) {
    throw new Error(`ledger has parse warnings: ${parsed.warnings.join("; ")}`);
  }
  const run = parsed.records.find((record) => record.record_type === "run" && record.run_id === runId);
  if (!run) {
    throw new Error(`run_id not found in ledger: ${runId}`);
  }
  const existing = parsed.records.find(
    (record) =>
      record.record_type === "annotation" &&
      record.annotation_type === "manual_exclusion" &&
      record.run_id === runId,
  );
  if (existing) {
    throw new Error(`run_id already has a manual exclusion annotation: ${runId}`);
  }

  const annotation = createManualExclusionAnnotation({
    runId,
    excludedReason,
    source,
    ...(timestamp ? { timestamp } : {}),
    ...(annotationId ? { annotationId } : {}),
  });
  await appendLedgerRecord(ledgerPath, annotation);
  process.stdout.write(`${JSON.stringify(annotation, null, 2)}\n`);
}

main().catch(failCli);
