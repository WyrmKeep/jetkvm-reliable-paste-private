import { createSelfValidationArtifact } from "../selfValidation.js";

import { failCli, optionalInteger, optionalString, parseArgs, writeStdoutOrFile } from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifact = createSelfValidationArtifact({
    seedStart: optionalInteger(args, "seed-start", 1),
    seedCount: optionalInteger(args, "seed-count", 20),
  });
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeStdoutOrFile(json, optionalString(args, "output"));
  if (!artifact.ok) {
    process.exit(1);
  }
}

main().catch(failCli);
