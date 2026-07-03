import {
  CORPUS_CLASSES,
  generateCorpus,
  generateUkCharsetCorpus,
  type CorpusClass,
} from "../corpus.js";

import {
  failCli,
  optionalInteger,
  optionalString,
  parseArgs,
  requiredString,
  writeStdoutOrFile,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("list")) {
    process.stdout.write(`${[...CORPUS_CLASSES, "uk-charset"].join("\n")}\n`);
    return;
  }

  if (args.flags.has("uk-charset")) {
    const corpus = generateUkCharsetCorpus({
      repetitions: optionalInteger(args, "repetitions", 20),
    });
    await writeStdoutOrFile(corpus, optionalString(args, "output"));
    return;
  }

  const corpusClass = requiredString(args, "class");
  if (!CORPUS_CLASSES.includes(corpusClass as CorpusClass)) {
    throw new Error(`--class must be one of: ${CORPUS_CLASSES.join(", ")}`);
  }

  const sizeRaw = requiredString(args, "size");
  const seed = requiredString(args, "seed");
  const size = Number(sizeRaw);
  if (!Number.isInteger(size)) {
    throw new Error("--size must be an integer");
  }

  const corpus = generateCorpus({
    corpusClass: corpusClass as CorpusClass,
    size,
    seed,
  });
  await writeStdoutOrFile(corpus, optionalString(args, "output"));
}

main().catch(failCli);
