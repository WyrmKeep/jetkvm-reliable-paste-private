import { writeFile } from "node:fs/promises";

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--") && arg !== "-o") {
      positional.push(arg);
      continue;
    }

    const normalized = arg === "-o" ? "--output" : arg;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex !== -1) {
      flags.set(normalized.slice(2, equalsIndex), normalized.slice(equalsIndex + 1));
      continue;
    }

    const key = normalized.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positional, flags };
}

export function requiredString(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

export function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function optionalInteger(args: ParsedArgs, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw new Error(`--${name} must be an integer`);
  }
  return Number(raw);
}

export async function writeStdoutOrFile(text: string, outputPath?: string): Promise<void> {
  if (outputPath) {
    await writeFile(outputPath, text, "utf8");
    return;
  }
  process.stdout.write(text);
}

export function failCli(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
