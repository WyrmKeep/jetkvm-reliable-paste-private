import { lintLedgerFile } from "../ledger.js";

import { failCli, parseArgs } from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = args.positional[0];
  if (!ledgerPath) {
    throw new Error("usage: node ledger-lint.js <ledger.jsonl>");
  }

  const violations = await lintLedgerFile(ledgerPath);
  if (violations.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, violations }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, violations: [] }, null, 2)}\n`);
}

main().catch(failCli);
