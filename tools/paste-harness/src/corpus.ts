import { SeededPrng, type SeedInput } from "./prng.js";

export const CORPUS_CLASSES = [
  "code",
  "long-text",
  "scripts",
  "binary-patterns",
  "compressed-indexes",
  "angle-dense",
  "shifted-symbol-storm",
  "modifier-boundary",
  "mixed-case",
] as const;

export type CorpusClass = (typeof CORPUS_CLASSES)[number];

export interface GenerateCorpusOptions {
  corpusClass: CorpusClass;
  size: number;
  seed: SeedInput;
}

export interface CorpusValidationResult {
  ok: boolean;
  invalidCharacters: Array<{ char: string; index: number }>;
  duplicateKeys: string[];
  missingKeyLines: number[];
  hasCr: boolean;
}

const MIN_SIZE = 200;
const MAX_SIZE = 100_000;
const KEY_WIDTH = 4;
const KEY_PREFIX = "L";
const MIN_LINE_LENGTH = KEY_PREFIX.length + KEY_WIDTH + 1;
const NEXT_LINE_MIN_COST = 1 + MIN_LINE_LENGTH;

export const UK_REACHABLE_TEXT_CHARS = [
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)),
  "£",
] as const;

const UK_REACHABLE_SET = new Set<string>(UK_REACHABLE_TEXT_CHARS);

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const PLAIN_ALPHABET = `${LETTERS}${LETTERS.toUpperCase()}${DIGITS} _-.,;:()[]{}<>/?"'@#=+*%$£`;
const SHIFTED_SYMBOLS = `!"£$%^&*()_+{}:@~|<>?`;
const CODE_SYMBOLS = `${LETTERS}${LETTERS.toUpperCase()}${DIGITS} _-.,;:()[]{}<>/?"'@#=+*%$£\\|`;
const BINARY_SYMBOLS = "01 abcdefABCDEFx_:-[]{} ";

export function generateCorpus(options: GenerateCorpusOptions): string {
  if (!CORPUS_CLASSES.includes(options.corpusClass)) {
    throw new Error(`unsupported corpus class: ${String(options.corpusClass)}`);
  }
  if (!Number.isInteger(options.size) || options.size < MIN_SIZE || options.size > MAX_SIZE) {
    throw new Error(`size must be an integer in the range ${MIN_SIZE}..${MAX_SIZE}`);
  }

  const prng = new SeededPrng(`${options.seed}:${options.corpusClass}:${options.size}`);
  const lines: string[] = [];
  let remaining = options.size;
  let lineNumber = 0;

  while (remaining > 0) {
    if (lineNumber > 9999) {
      throw new Error("corpus exceeded L#### key space");
    }

    const newlineCost = lineNumber === 0 ? 0 : 1;
    const availableForLine = remaining - newlineCost;
    if (availableForLine < MIN_LINE_LENGTH) {
      const previous = lines.pop();
      if (previous === undefined) {
        throw new Error("size too small for a keyed line");
      }
      lines.push(previous + makeFiller(options.corpusClass, availableForLine, prng));
      remaining = 0;
      break;
    }

    let lineLength = Math.min(availableForLine, prng.int(72, 118));
    const leftover = availableForLine - lineLength;
    if (leftover > 0 && leftover < NEXT_LINE_MIN_COST) {
      lineLength = availableForLine;
    }

    const key = formatLineKey(lineNumber);
    const bodyLength = lineLength - key.length - 1;
    lines.push(`${key} ${generateLineBody(options.corpusClass, lineNumber, bodyLength, prng)}`);

    remaining -= newlineCost + lineLength;
    lineNumber += 1;
  }

  const corpus = lines.join("\n");
  const validation = validateCorpusText(corpus);
  if (!validation.ok) {
    throw new Error(`internal corpus validation failed: ${JSON.stringify(validation)}`);
  }
  return corpus;
}

export function extractLineKeys(corpus: string): string[] {
  return corpus.split("\n").map((line) => {
    const match = line.match(/(L\d{4})/);
    if (!match?.[1]) {
      throw new Error(`line is missing L#### key: ${line}`);
    }
    return match[1];
  });
}

export function validateCorpusText(corpus: string): CorpusValidationResult {
  const invalidCharacters: Array<{ char: string; index: number }> = [];
  for (const [index, char] of [...corpus].entries()) {
    if (char !== "\n" && !UK_REACHABLE_SET.has(char)) {
      invalidCharacters.push({ char, index });
    }
  }

  const missingKeyLines: number[] = [];
  const seen = new Set<string>();
  const duplicateKeys = new Set<string>();
  corpus.split("\n").forEach((line, lineIndex) => {
    const match = line.match(/(L\d{4})/);
    if (!match?.[1]) {
      missingKeyLines.push(lineIndex);
      return;
    }
    if (seen.has(match[1])) {
      duplicateKeys.add(match[1]);
    }
    seen.add(match[1]);
  });

  return {
    ok:
      invalidCharacters.length === 0 &&
      duplicateKeys.size === 0 &&
      missingKeyLines.length === 0 &&
      !corpus.includes("\r"),
    invalidCharacters,
    duplicateKeys: [...duplicateKeys].sort(),
    missingKeyLines,
    hasCr: corpus.includes("\r"),
  };
}

function formatLineKey(lineNumber: number): string {
  return `${KEY_PREFIX}${String(lineNumber).padStart(KEY_WIDTH, "0")}`;
}

function generateLineBody(
  corpusClass: CorpusClass,
  lineNumber: number,
  bodyLength: number,
  prng: SeededPrng,
): string {
  const fragments = buildFragments(corpusClass, lineNumber, prng);
  let body = fragments.join(" ");
  while (body.length < bodyLength) {
    body += ` ${makeFiller(corpusClass, prng.int(4, 16), prng)}`;
  }
  return body.slice(0, bodyLength);
}

function buildFragments(corpusClass: CorpusClass, lineNumber: number, prng: SeededPrng): string[] {
  switch (corpusClass) {
    case "code": {
      const name = `${makeWord(prng, 4, 9)}_${lineNumber}`;
      return [
        `const ${name} = (${prng.int(1, 999)} < ${prng.int(1000, 9999)}) ? "ok<${prng.int(1, 9)}>" : "£${prng.int(1, 99)}";`,
        `if (${name}.length >= ${prng.int(2, 8)}) { return ${name}; }`,
      ];
    }
    case "long-text":
      return [
        `The ${makeWord(prng, 5, 10)} paste sample tracks ${prng.int(10, 99)} symbols`,
        `with quotes "@", angle pairs <>, and cost £${prng.int(1, 500)}.`,
      ];
    case "scripts":
      return [
        `set -e; printf '%s' "${makeWord(prng, 4, 8)}_${lineNumber}"`,
        `powershell -NoProfile -Command "Write-Output '${makeWord(prng, 3, 7)} #${prng.int(
          10,
          99,
        )}'"`,
      ];
    case "binary-patterns":
      return [
        `bits=${makeBits(prng, 32)} hex=${makeHex(prng, 16)}`,
        `mask[${lineNumber % 64}]=0b${makeBits(prng, 12)} xor=0x${makeHex(prng, 6)}`,
      ];
    case "compressed-indexes":
      return [
        `[idx${String(lineNumber).padStart(4, "0")};off=${prng.int(0, 99999)};len=${prng.int(
          1,
          4096,
        )};rle=${makeRunLength(prng)}]`,
        `{delta:+${prng.int(1, 31)},ref:${makeWord(prng, 3, 6)},crc:${makeHex(prng, 8)}}`,
      ];
    case "angle-dense":
      return [
        `<node id="${lineNumber}"><pair><><><${prng.int(1, 9)}></pair></node>`,
        `sentinel<>${makeWord(prng, 6, 12)}<>tail`,
      ];
    case "shifted-symbol-storm":
      return [
        repeatPattern(SHIFTED_SYMBOLS, prng.int(12, 30), prng),
        `mix ${SHIFTED_SYMBOLS} ${repeatPattern("@\"#£~|<>", prng.int(6, 14), prng)}`,
      ];
    case "modifier-boundary":
      return [
        `aA zZ mM nN 1! 2" 3£ 4$ 5% 6^ 7& 8* 9( 0)`,
        `${makeWord(prng, 3, 5)} ${makeWord(prng, 3, 5).toUpperCase()} <> @ " # £`,
      ];
    case "mixed-case":
      return [
        `${toMixedCase(makeWord(prng, 8, 14), prng)} ${toMixedCase(makeWord(prng, 8, 14), prng)}`,
        `caseRun=${toMixedCase(makeWord(prng, 12, 20), prng)} <> after=${toMixedCase(
          makeWord(prng, 10, 18),
          prng,
        )}`,
      ];
  }
}

function makeFiller(corpusClass: CorpusClass, length: number, prng: SeededPrng): string {
  const alphabet =
    corpusClass === "binary-patterns"
      ? BINARY_SYMBOLS
      : corpusClass === "shifted-symbol-storm"
        ? SHIFTED_SYMBOLS
        : corpusClass === "code" || corpusClass === "scripts"
          ? CODE_SYMBOLS
          : PLAIN_ALPHABET;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += alphabet[prng.int(0, alphabet.length - 1)];
  }
  return text;
}

function makeWord(prng: SeededPrng, minLength: number, maxLength: number): string {
  const length = prng.int(minLength, maxLength);
  let word = "";
  for (let index = 0; index < length; index += 1) {
    word += LETTERS[prng.int(0, LETTERS.length - 1)];
  }
  return word;
}

function makeBits(prng: SeededPrng, length: number): string {
  let bits = "";
  for (let index = 0; index < length; index += 1) {
    bits += prng.pick(["0", "1"]);
  }
  return bits;
}

function makeHex(prng: SeededPrng, length: number): string {
  let hex = "";
  for (let index = 0; index < length; index += 1) {
    hex += prng.pick("0123456789abcdef".split(""));
  }
  return hex;
}

function makeRunLength(prng: SeededPrng): string {
  const parts: string[] = [];
  for (let index = 0; index < prng.int(3, 7); index += 1) {
    parts.push(`${prng.pick(["a", "b", "0", "1", "_"])}${prng.int(1, 9)}`);
  }
  return parts.join(".");
}

function repeatPattern(pattern: string, length: number, prng: SeededPrng): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += pattern[(index + prng.int(0, pattern.length - 1)) % pattern.length];
  }
  return output;
}

function toMixedCase(word: string, prng: SeededPrng): string {
  return [...word]
    .map((char, index) => {
      if ((index + prng.int(0, 1)) % 2 === 0) {
        return char.toUpperCase();
      }
      return char;
    })
    .join("");
}
