import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { buildHidtypeRemoteCommand, buildSaveChordCommand } from "./hidtype.js";
import { buildHttpBaseUrl, loginLocal } from "./hidrpcClient.js";
import { checkSaveLanded } from "./rig.js";
import { kvmTarget, runSshCommand, type RigEnv } from "./ssh.js";

export const PASTE_TRACE_STORAGE_KEY = "jetkvm_reliable_paste_trace";

export type ProductPathProfile = "reliable" | "fast";
export type ProductVerificationMode =
  | "auto-verify-off"
  | "auto-verify"
  | "auto-repair"
  | "manual-confirm-auto-continue";

export interface ProductVerificationOptions {
  autoVerify?: boolean;
  autoRepair?: boolean;
  verifyChunks?: boolean;
}

export interface ProductPathRunOptions {
  host?: string;
  profile?: ProductPathProfile;
  verification?: ProductVerificationOptions;
  timeoutMs?: number;
  headless?: boolean;
  clearBefore?: boolean;
  saveAfter?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  chromiumExecutablePath?: string;
}

export interface ProductPathRunResult {
  completed: boolean;
  doneLine: string;
  traceLines: string[];
  manualConfirmContinuations: number;
  verificationMode: ProductVerificationMode;
  hidOutputReports: number;
  saved: boolean;
  durationMs: number;
}

export interface ProductPathLedgerDetails {
  completion_signal: "done-trace";
  verification_mode: ProductVerificationMode;
  ocr_calibration: "not-requested" | "engaged" | "manual-fallback";
  auto_verify_requested: boolean;
  auto_repair_requested: boolean;
  manual_confirm_continuations: number;
  trace_line_count: number;
  done_line: string;
}

const DEFAULT_PRODUCT_PATH_TIMEOUT_MS = 120_000;
const CLEAR_DOCUMENT_REPORTS = 6;
const SAVE_CHORD_REPORTS = 2;

export function parsePasteTraceStorage(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

export function findDoneTraceLine(traceLines: readonly string[]): string | undefined {
  return traceLines.find(line => line.startsWith("done: chars="));
}

export function resolveProductVerificationMode(manualConfirmContinuations: number): ProductVerificationMode {
  return manualConfirmContinuations > 0 ? "manual-confirm-auto-continue" : "auto-verify-off";
}

export function resolveProductVerificationModeFromTrace(args: {
  autoVerifyRequested: boolean;
  autoRepairRequested: boolean;
  manualConfirmContinuations: number;
  traceLines: readonly string[];
}): ProductVerificationMode {
  if (args.manualConfirmContinuations > 0) {
    return "manual-confirm-auto-continue";
  }
  if (!args.autoVerifyRequested) {
    return "auto-verify-off";
  }
  return args.autoRepairRequested && resolveOcrCalibration(args.traceLines) === "engaged"
    ? "auto-repair"
    : "auto-verify";
}

export function resolveOcrCalibration(
  traceLines: readonly string[],
): ProductPathLedgerDetails["ocr_calibration"] {
  const calibrationLine = traceLines.find(line => line.startsWith("ocr-calibrate:"));
  if (calibrationLine === undefined) {
    return "not-requested";
  }
  return calibrationLine.includes("counter=") ? "engaged" : "manual-fallback";
}

export function buildProductPathLedgerDetails(args: {
  doneLine: string;
  manualConfirmContinuations: number;
  traceLineCount: number;
  traceLines?: readonly string[];
  autoVerifyRequested?: boolean;
  autoRepairRequested?: boolean;
}): ProductPathLedgerDetails {
  const traceLines = args.traceLines ?? [];
  const autoVerifyRequested = args.autoVerifyRequested === true;
  const autoRepairRequested = args.autoRepairRequested === true;
  return {
    completion_signal: "done-trace",
    verification_mode: resolveProductVerificationModeFromTrace({
      autoVerifyRequested,
      autoRepairRequested,
      manualConfirmContinuations: args.manualConfirmContinuations,
      traceLines,
    }),
    ocr_calibration: autoVerifyRequested ? resolveOcrCalibration(traceLines) : "not-requested",
    auto_verify_requested: autoVerifyRequested,
    auto_repair_requested: autoRepairRequested,
    manual_confirm_continuations: args.manualConfirmContinuations,
    trace_line_count: args.traceLineCount,
    done_line: args.doneLine,
  };
}

export function estimateProductPathHidReports(
  text: string,
  options: { clearBefore?: boolean; saveAfter?: boolean } = {},
): number {
  const textReports = [...text.normalize("NFC")].length * 2;
  const clearReports = options.clearBefore === false ? 0 : CLEAR_DOCUMENT_REPORTS;
  const saveReports = options.saveAfter === false ? 0 : SAVE_CHORD_REPORTS;
  return textReports + clearReports + saveReports;
}

export async function runProductPathText(
  env: RigEnv,
  text: string,
  options: ProductPathRunOptions = {},
): Promise<ProductPathRunResult> {
  const host = options.host ?? env.KVM_PRIMARY;
  const password = env.JETKVM_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error("JETKVM_PASSWORD is required in .env.paste-rig for product path login");
  }

  const startedAtUtc = new Date().toISOString();
  const startedAtMs = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRODUCT_PATH_TIMEOUT_MS;
  const clearBefore = options.clearBefore !== false;
  const saveAfter = options.saveAfter !== false;
  let browser: Browser | undefined;

  try {
    throwIfAborted(options.signal);
    options.onProgress?.(0);

    if (clearBefore) {
      await clearRecvTxtViaHidtype(env, timeoutMs);
      options.onProgress?.(0.05);
    }

    const baseUrl = buildHttpBaseUrl(host);
    const login = await loginLocal(host, password);
    const executablePath = await resolveChromiumExecutablePath(options.chromiumExecutablePath);
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: options.headless !== false,
      args: [
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--disable-webrtc-hide-local-ips-with-mdns",
      ],
    };
    if (executablePath !== undefined) {
      launchOptions.executablePath = executablePath;
    }
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: 1700, height: 1060 },
      deviceScaleFactor: 2,
    });
    await context.addCookies([authCookieToPlaywrightCookie(login.cookie, baseUrl)]);
    const page = await context.newPage();

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await ensureAuthenticated(page, password);
    await waitForWebRtcReady(page);
    await waitForVideoReady(page);
    options.onProgress?.(0.1);

    await openPasteModal(page);
    await selectPasteProfile(page, options.profile ?? "reliable");
    await submitTextThroughPasteModal(page, text);
    await configurePasteVerificationPrompts(page, options.verification);
    await page.evaluate(
      key =>
        (globalThis as unknown as { localStorage: { removeItem: (name: string) => void } }).localStorage.removeItem(
          key,
        ),
      PASTE_TRACE_STORAGE_KEY,
    );
    await page.getByRole("button", { name: /Confirm Paste/i }).first().click({ timeout: 15_000 });
    options.onProgress?.(0.15);

    const waitOptions: {
      timeoutMs: number;
      signal?: AbortSignal;
      onProgress?: (progress: number) => void;
    } = {
      timeoutMs,
      onProgress: progress => options.onProgress?.(0.15 + progress * 0.7),
    };
    if (options.signal !== undefined) {
      waitOptions.signal = options.signal;
    }
    const done = await waitForDoneTrace(page, waitOptions);

    let saved = false;
    if (saveAfter) {
      await saveRecvTxtViaHid(env, startedAtUtc);
      saved = true;
      options.onProgress?.(0.95);
    }

    options.onProgress?.(1);
    return {
      completed: true,
      doneLine: done.doneLine,
      traceLines: done.traceLines,
      manualConfirmContinuations: done.manualConfirmContinuations,
      verificationMode: resolveProductVerificationMode(done.manualConfirmContinuations),
      hidOutputReports: estimateProductPathHidReports(text, { clearBefore, saveAfter }),
      saved,
      durationMs: Date.now() - startedAtMs,
    };
  } finally {
    await browser?.close().catch(() => {
      // Best-effort browser cleanup.
    });
  }
}

export async function resolveChromiumExecutablePath(
  explicitPath?: string,
): Promise<string | undefined> {
  const candidates = [
    explicitPath,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    chromium.executablePath(),
    ...(await cachedChromiumExecutableCandidates()),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate. chromium.launch will surface a clear error if none exist.
    }
  }

  return undefined;
}

async function cachedChromiumExecutableCandidates(): Promise<string[]> {
  const cacheRoot = join(homedir(), "Library", "Caches", "ms-playwright");
  let entries: string[];
  try {
    entries = await readdir(cacheRoot);
  } catch {
    return [];
  }

  const chromiumDirs = entries
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const candidates: string[] = [];
  for (const chromiumDir of chromiumDirs) {
    if (process.platform === "darwin") {
      const macDirs = process.arch === "arm64" ? ["chrome-mac-arm64", "chrome-mac"] : ["chrome-mac"];
      for (const macDir of macDirs) {
        candidates.push(
          join(
            cacheRoot,
            chromiumDir,
            macDir,
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          join(cacheRoot, chromiumDir, macDir, "Chromium.app", "Contents", "MacOS", "Chromium"),
        );
      }
    } else if (process.platform === "linux") {
      candidates.push(join(cacheRoot, chromiumDir, "chrome-linux", "chrome"));
    }
  }
  return candidates;
}

async function clearRecvTxtViaHidtype(env: RigEnv, timeoutMs: number): Promise<void> {
  const result = await runSshCommand(
    kvmTarget(env.KVM_PRIMARY),
    buildHidtypeRemoteCommand({ layout: "uk", rate: 60, clear: true }),
    {
      input: "",
      timeoutMs: Math.min(timeoutMs, 30_000),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`failed to clear recv.txt via hidtype: ${result.stderr || result.stdout}`);
  }
}

async function ensureAuthenticated(page: Page, password: string): Promise<void> {
  const passwordField = page.locator('input[type="password"]').first();
  if ((await passwordField.count()) === 0) {
    return;
  }
  if (!(await passwordField.isVisible().catch(() => false))) {
    return;
  }
  await passwordField.fill(password);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Paste text/i }).first().waitFor({ state: "visible", timeout: 15_000 });
}

async function waitForVideoReady(page: Page): Promise<void> {
  const video = page.locator("video").first();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await video
      .evaluate(element => {
        const media = element as { videoWidth?: number; currentTime?: number };
        return (media.videoWidth ?? 0) > 0 && (media.currentTime ?? 0) > 0;
      })
      .catch(() => false);
    if (ready) {
      return;
    }
    await page.waitForTimeout(1_000);
  }
}

async function waitForWebRtcReady(page: Page, timeoutMs = 45_000): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastStatus: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    lastStatus = await page
      .evaluate(() => {
        const hooks = (globalThis as unknown as {
          __kvmTestHooks?: {
            isWebRTCConnected?: () => boolean;
            isHidRpcReady?: () => boolean;
            isVideoStreamActive?: () => boolean;
          };
        }).__kvmTestHooks;
        return {
          hooks: hooks !== undefined,
          webrtc: hooks?.isWebRTCConnected?.() === true,
          hid: hooks?.isHidRpcReady?.() === true,
          video: hooks?.isVideoStreamActive?.() === true,
        };
      })
      .catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    if (lastStatus.webrtc === true && lastStatus.hid === true) {
      return;
    }
    await page.waitForTimeout(Date.now() - started < 2_000 ? 200 : 1_000);
  }
  throw new Error(`timed out waiting for WebRTC and HIDRPC readiness: ${JSON.stringify(lastStatus)}`);
}

async function openPasteModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Paste text/i }).first().click({ timeout: 30_000 });
  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 15_000 });
}

async function selectPasteProfile(page: Page, profile: ProductPathProfile): Promise<void> {
  const label = profile === "fast" ? /Fast/i : /Reliable/i;
  const radio = page.getByRole("radio", { name: label }).first();
  if (await radio.isVisible().catch(() => false)) {
    const alreadySelected = await radio.evaluate(element => element.getAttribute("aria-checked") === "true")
      .catch(() => false);
    if (alreadySelected) {
      return;
    }
    await radio.click();
  }
}

async function submitTextThroughPasteModal(page: Page, text: string): Promise<void> {
  const textarea = page.locator("textarea").last();
  await textarea.fill(text);
  await page.waitForTimeout(250);
}

async function disablePasteVerificationPrompts(page: Page): Promise<void> {
  await configurePasteVerificationPrompts(page);
}

async function configurePasteVerificationPrompts(
  page: Page,
  verification: ProductVerificationOptions = {},
): Promise<void> {
  await setCheckboxByLabel(page, /Verify each chunk/i, verification.verifyChunks === true);
  await setCheckboxByLabel(page, /Auto-verify/i, verification.autoVerify === true);
  await page.waitForTimeout(100);
  await setCheckboxByLabel(page, /Auto-repair/i, verification.autoRepair === true);
}

async function setCheckboxByLabel(page: Page, label: RegExp, checked: boolean): Promise<void> {
  const checkbox = page.locator("label").filter({ hasText: label }).locator('input[type="checkbox"]');
  const count = await checkbox.count();
  for (let index = 0; index < count; index += 1) {
    const item = checkbox.nth(index);
    const isChecked = await item.isChecked().catch(() => false);
    if (checked && !isChecked) {
      await item.check().catch(() => {
        // If a checkbox disappears between discovery and check, treat it as unavailable for this run.
      });
    }
    if (!checked && isChecked) {
      await item.uncheck().catch(() => {
        // If a checkbox disappears between discovery and uncheck, it is already disabled for this run.
      });
    }
  }
}

async function waitForDoneTrace(
  page: Page,
  args: {
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
  },
): Promise<{ doneLine: string; traceLines: string[]; manualConfirmContinuations: number }> {
  const started = Date.now();
  const deadline = started + args.timeoutMs;
  let manualConfirmContinuations = 0;
  let lastTraceLines: string[] = [];

  while (Date.now() < deadline) {
    throwIfAborted(args.signal);
    const traceValue = await page
      .evaluate(
        key =>
          (globalThis as unknown as { localStorage: { getItem: (name: string) => string | null } }).localStorage.getItem(
            key,
          ),
        PASTE_TRACE_STORAGE_KEY,
      )
      .catch(() => null);
    lastTraceLines = parsePasteTraceStorage(traceValue);
    const doneLine = findDoneTraceLine(lastTraceLines);
    if (doneLine !== undefined) {
      return { doneLine, traceLines: lastTraceLines, manualConfirmContinuations };
    }

    if (await continueManualConfirmIfVisible(page)) {
      manualConfirmContinuations += 1;
    }

    args.onProgress?.(Math.min(0.95, (Date.now() - started) / Math.max(args.timeoutMs, 1)));
    await page.waitForTimeout(1_000);
  }

  const tail = lastTraceLines.slice(-3).join(" | ");
  throw new Error(`product path paste did not emit done trace within ${args.timeoutMs}ms; trace_tail=${tail}`);
}

async function continueManualConfirmIfVisible(page: Page): Promise<boolean> {
  const prompt = page.getByText(/delivered.*target should now show/i).first();
  if (!(await prompt.isVisible().catch(() => false))) {
    return false;
  }
  await page.getByRole("button", { name: /^Continue$/i }).first().click().catch(() => {
    // The prompt may disappear if the app auto-resolved it between visibility and click.
  });
  return true;
}

async function saveRecvTxtViaHid(env: RigEnv, startedAtUtc: string): Promise<void> {
  const saveResult = await runSshCommand(kvmTarget(env.KVM_PRIMARY), buildSaveChordCommand(), {
    timeoutMs: 10_000,
  });
  if (saveResult.exitCode !== 0) {
    throw new Error(`failed to save recv.txt via HID: ${saveResult.stderr || saveResult.stdout}`);
  }

  const saveLanded = await checkSaveLanded(startedAtUtc, env);
  if (saveLanded.ok === false || saveLanded.saveLanded === false) {
    throw new Error(`recv.txt save did not land: ${JSON.stringify(saveLanded)}`);
  }
}

function authCookieToPlaywrightCookie(cookieHeader: string, baseUrl: string): {
  name: string;
  value: string;
  url: string;
  httpOnly: boolean;
  sameSite: "Lax";
} {
  const cookiePair = cookieHeader.split(";")[0] ?? "";
  const equalsIndex = cookiePair.indexOf("=");
  if (equalsIndex <= 0) {
    throw new Error("authToken cookie was malformed");
  }
  return {
    name: cookiePair.slice(0, equalsIndex),
    value: cookiePair.slice(equalsIndex + 1),
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }
}

