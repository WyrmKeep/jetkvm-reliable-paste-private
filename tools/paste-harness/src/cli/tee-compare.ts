import { readFile } from "node:fs/promises";

import {
  DEFAULT_HIDRPC_DELAY_MS,
  buildKeyboardMacroStepsForText,
  decodeCliText,
} from "../hidrpcClient.js";
import {
  compareTeeLogToKeyboardMacro,
  summarizeTeeBoundary,
} from "../teeCompare.js";

import {
  failCli,
  optionalInteger,
  optionalString,
  parseArgs,
  requiredString,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const teeLogPath = requiredString(args, "tee");
  const teeLog = await readFile(teeLogPath, "utf8");

  if (args.flags.has("zero-boundary")) {
    const summary = summarizeTeeBoundary(teeLog);
    process.stdout.write(`${JSON.stringify({ ok: summary.firstAllZero && summary.lastAllZero, ...summary }, null, 2)}\n`);
    if (!summary.firstAllZero || !summary.lastAllZero) {
      process.exit(1);
    }
    return;
  }

  const text = optionalString(args, "text");
  if (text === undefined) {
    throw new Error("missing required --text unless --zero-boundary is used");
  }
  const steps = buildKeyboardMacroStepsForText(decodeCliText(text), {
    delayMs: optionalInteger(args, "delay-ms", DEFAULT_HIDRPC_DELAY_MS),
  });
  const result = compareTeeLogToKeyboardMacro(teeLog, steps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch(failCli);
