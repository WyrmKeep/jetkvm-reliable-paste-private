import { mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { generateCorpus, generateUkCharsetCorpus, type CorpusClass } from "../corpus.js";
import { DEFAULT_HIDRPC_DELAY_MS } from "../hidrpcClient.js";
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
  const corpus = await loadCorpus(args);
  const corpusText = corpus.text;
  const corpusHash = await sha256(corpusText);
  const injectionPath = optionalString(args, "path") ?? "synthetic";
  const physicalTypingPath = injectionPath === "raw" || injectionPath === "hidtype" || injectionPath === "hidrpc";
  const watchdogDefault = physicalTypingPath ? 180_000 : 30_000;
  const focusPollDefault = physicalTypingPath ? 600_000 : 1_000;

  const orchestratorOptions: OrchestratorOptions = {
    ledgerPath,
    artifactsRoot,
    injectionPath,
    purpose: optionalString(args, "purpose") ?? "f2_probe",
    cellId: optionalString(args, "cell-id") ?? "F2-RIG-CONTROL",
    corpus: {
      id: corpus.id,
      hash: `sha256:${corpusHash}`,
      path: corpus.path,
      size: corpusText.length,
    },
    corpusText,
    watchdogMs: optionalInteger(args, "watchdog-ms", watchdogDefault),
    focusPollMs: optionalInteger(args, "focus-poll-ms", focusPollDefault),
    syntheticDurationMs: optionalInteger(args, "synthetic-duration-ms", 250),
    forceChurnTelemetry: args.flags.has("force-churn"),
  };
  const hidtypeLayout = optionalString(args, "hidtype-layout");
  if (hidtypeLayout !== undefined) {
    if (hidtypeLayout !== "uk" && hidtypeLayout !== "us") {
      throw new Error("--hidtype-layout must be uk or us");
    }
    orchestratorOptions.hidtypeLayout = hidtypeLayout;
  }
  const hidtypeRate = optionalInteger(args, "hidtype-rate", 91);
  orchestratorOptions.hidtypeRate = hidtypeRate;
  if (args.flags.has("no-hidtype-clear")) {
    orchestratorOptions.hidtypeClear = false;
  }
  orchestratorOptions.hidrpcDelayMs = optionalInteger(args, "hidrpc-delay-ms", DEFAULT_HIDRPC_DELAY_MS);
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

async function loadCorpus(args: ReturnType<typeof parseArgs>): Promise<{ id: string; path: string; text: string }> {
  const textFile = optionalString(args, "text-file");
  if (textFile !== undefined) {
    const resolved = resolve(textFile);
    return {
      id: `file:${basename(resolved)}`,
      path: resolved,
      text: await readFile(resolved, "utf8"),
    };
  }

  if (args.flags.has("uk-charset")) {
    const repetitions = optionalInteger(args, "repetitions", 20);
    return {
      id: `uk-charset:repetitions=${repetitions}`,
      path: "synthetic://uk-charset",
      text: generateUkCharsetCorpus({ repetitions }),
    };
  }

  const corpusClass = (optionalString(args, "class") ?? "mixed-case") as CorpusClass;
  const size = optionalInteger(args, "size", 200);
  const seed = optionalString(args, "seed") ?? "f2";
  return {
    id: `${corpusClass}:seed=${seed}:size=${size}`,
    path: "synthetic://generated",
    text: generateCorpus({ corpusClass, size, seed }),
  };
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

main().catch(failCli);
