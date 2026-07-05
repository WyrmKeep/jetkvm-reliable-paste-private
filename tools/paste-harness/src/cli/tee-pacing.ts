import { readFile } from "node:fs/promises";

import { analyzeTeePacing } from "../teePacing.js";

import { failCli, parseArgs } from "./common.js";

function optionalPositiveNumber(value: string | true | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const teeLogPath = args.positional[0];
  if (!teeLogPath) {
    throw new Error("usage: node tee-pacing.js <tee.log> --expect 11");
  }

  const expectMs = optionalPositiveNumber(args.flags.get("expect"), "expect", 11);
  const text = await readFile(teeLogPath, "utf8");
  const result = analyzeTeePacing(text, { expectMs });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch(failCli);
