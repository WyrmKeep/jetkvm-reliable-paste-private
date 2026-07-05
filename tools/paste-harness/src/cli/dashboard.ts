import { renderDashboardHtml, writeDashboardFromLedger } from "../dashboard.js";
import { parseLedgerFile } from "../ledger.js";

import { failCli, optionalString, parseArgs, writeStdoutOrFile } from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = args.positional[0];
  if (!ledgerPath) {
    throw new Error("usage: node dashboard.js <ledger.jsonl> [-o dashboard.html]");
  }

  const outputPath = optionalString(args, "output");
  if (outputPath) {
    await writeDashboardFromLedger(ledgerPath, outputPath);
    return;
  }

  const parsed = await parseLedgerFile(ledgerPath);
  await writeStdoutOrFile(renderDashboardHtml(parsed.records, { warnings: parsed.warnings }));
}

main().catch(failCli);
