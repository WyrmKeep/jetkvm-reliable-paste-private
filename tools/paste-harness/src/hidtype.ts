import { checkSaveLanded } from "./rig.js";
import { kvmTarget, runSshCommand, type RigEnv } from "./ssh.js";

export type HidtypeLayout = "uk" | "us";

export interface HidtypeCommandOptions {
  executable?: string;
  device?: string;
  layout?: HidtypeLayout;
  rate?: number;
  clear?: boolean;
}

export interface RunRawHidtypeOptions extends HidtypeCommandOptions {
  saveDevice?: string;
  timeoutMs?: number;
}

interface HidtypeStats {
  charsTyped?: number;
  writes?: number;
  skipped?: number;
  writeErrors?: number;
}

const DEFAULT_HIDTYPE_PATH = "/userdata/hidtype";
const DEFAULT_HID_DEVICE = "/dev/hidg0";
const DEFAULT_HIDTYPE_RATE = 91;

export function buildHidtypeRemoteCommand(options: HidtypeCommandOptions = {}): string {
  const executable = options.executable ?? DEFAULT_HIDTYPE_PATH;
  const device = options.device ?? DEFAULT_HID_DEVICE;
  const layout = options.layout ?? "uk";
  const rate = options.rate ?? DEFAULT_HIDTYPE_RATE;
  if (layout !== "uk" && layout !== "us") {
    throw new Error("--layout must be uk or us");
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("--rate must be positive");
  }

  const parts = [
    executable,
    "-layout",
    layout,
    "-dev",
    device,
    "-rate",
    String(rate),
  ];
  if (options.clear ?? true) {
    parts.push("-clear");
  }
  return parts.map(shellQuote).join(" ");
}

export function buildSaveChordCommand(device = DEFAULT_HID_DEVICE): string {
  const quotedDevice = shellQuote(device);
  return [
    `printf '\\001\\000\\026\\000\\000\\000\\000\\000' > ${quotedDevice}`,
    "sleep 0.08",
    `printf '\\000\\000\\000\\000\\000\\000\\000\\000' > ${quotedDevice}`,
  ].join("; ");
}

export async function runRawHidtypeInjection(
  env: RigEnv,
  corpusText: string,
  options: RunRawHidtypeOptions = {},
): Promise<{ hidOutputReports: number; stats: HidtypeStats }> {
  const startedAtUtc = new Date().toISOString();
  const command = buildHidtypeRemoteCommand(options);
  const result = await runSshCommand(kvmTarget(env.KVM_PRIMARY), command, {
    input: corpusText,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`hidtype failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  const stats = parseHidtypeStats(result.stdout);
  const saveResult = await runSshCommand(kvmTarget(env.KVM_PRIMARY), buildSaveChordCommand(options.saveDevice), {
    timeoutMs: 10_000,
  });
  if (saveResult.exitCode !== 0) {
    throw new Error(`failed to save recv.txt via HID: ${saveResult.stderr || saveResult.stdout}`);
  }

  const saveLanded = await checkSaveLanded(startedAtUtc, env);
  if (saveLanded.ok === false || saveLanded.saveLanded === false) {
    throw new Error(`recv.txt save did not land: ${JSON.stringify(saveLanded)}`);
  }

  return {
    hidOutputReports: (stats.writes ?? 0) + 2,
    stats,
  };
}

export function parseHidtypeStats(stdout: string): HidtypeStats {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) {
      continue;
    }
    const parsed = JSON.parse(line) as HidtypeStats;
    return parsed;
  }
  return {};
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
