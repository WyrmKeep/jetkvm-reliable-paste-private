import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { generateCorpus, type CorpusClass } from "../corpus.js";
import { installNucBoxRigScripts, pinUkLayout, resetNotepad } from "../rig.js";
import { runOrchestrator } from "../orchestrator.js";
import type { OrchestratorOptions } from "../orchestrator.js";

import {
  failCli,
  optionalInteger,
  optionalString,
  parseArgs,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = resolve(optionalString(args, "ledger") ?? "ledger.jsonl");
  const artifactsRoot = resolve(optionalString(args, "artifacts") ?? "artifacts");

  if (args.flags.has("install-rig-scripts")) {
    const result = await installNucBoxRigScripts();
    process.stdout.write(`${JSON.stringify({ ok: true, install: result }, null, 2)}\n`);
    return;
  }

  if (args.flags.has("pin-layout")) {
    const result = await pinUkLayout();
    process.stdout.write(`${JSON.stringify({ ok: true, layout: result }, null, 2)}\n`);
    return;
  }

  if (args.flags.has("reset-notepad")) {
    const result = await resetNotepad();
    process.stdout.write(`${JSON.stringify({ ok: true, reset: result }, null, 2)}\n`);
    return;
  }

  await mkdir(artifactsRoot, { recursive: true });
  const corpusClass = (optionalString(args, "class") ?? "mixed-case") as CorpusClass;
  const size = optionalInteger(args, "size", 200);
  const seed = optionalString(args, "seed") ?? "f2";
  const corpusText = generateCorpus({ corpusClass, size, seed });
  const corpusHash = await sha256(corpusText);

  const orchestratorOptions: OrchestratorOptions = {
    ledgerPath,
    artifactsRoot,
    injectionPath: optionalString(args, "path") ?? "synthetic",
    purpose: optionalString(args, "purpose") ?? "f2_probe",
    cellId: optionalString(args, "cell-id") ?? "F2-RIG-CONTROL",
    corpus: {
      id: `${corpusClass}:seed=${seed}:size=${size}`,
      hash: `sha256:${corpusHash}`,
      path: "synthetic://generated",
      size,
    },
    watchdogMs: optionalInteger(args, "watchdog-ms", 30_000),
    focusPollMs: optionalInteger(args, "focus-poll-ms", 1_000),
    syntheticDurationMs: optionalInteger(args, "synthetic-duration-ms", 250),
    forceChurnTelemetry: args.flags.has("force-churn"),
  };
  const expectedBuildIdentity = optionalString(args, "expected-build");
  if (expectedBuildIdentity !== undefined) {
    orchestratorOptions.expectedBuildIdentity = expectedBuildIdentity;
  }
  const hostDecodeLayout = optionalString(args, "host-decode-layout");
  if (hostDecodeLayout !== undefined) {
    orchestratorOptions.hostDecodeLayout = hostDecodeLayout;
  }

  const result = await runOrchestrator(orchestratorOptions);

  process.stdout.write(`${JSON.stringify({ ok: result.outcome === "completed", ...result }, null, 2)}\n`);
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

main().catch(failCli);
