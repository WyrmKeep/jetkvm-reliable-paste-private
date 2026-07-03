import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  classifyDifference,
  CLASSIFIER_VERSION,
  emptyErrorVector,
  type ErrorVector,
} from "./classifier.js";
import {
  runRawHidtypeInjection,
  type HidtypeLayout,
  type RunRawHidtypeOptions,
} from "./hidtype.js";
import {
  DEFAULT_HIDRPC_DELAY_MS,
  runHidRpcText,
} from "./hidrpcClient.js";
import {
  buildProductPathLedgerDetails,
  runProductPathText,
  type ProductPathProfile,
  type ProductPathRunOptions,
} from "./productPath.js";
import {
  HARNESS_VERSION,
  LedgerWriter,
  parseLedgerText,
  type CorpusLedgerInfo,
  type RunLedgerRecord,
  type StepLedgerRecord,
  type TelemetrySummary,
} from "./ledger.js";
import {
  isFreshSink,
  readRecvSnapshot,
  runFocusGuard,
  runForegroundProbe,
  sampleCpuTelemetry,
  type FocusGuardEvent,
  type SinkState,
} from "./rig.js";
import {
  kvmTarget,
  loadRigEnv,
  runSshCommand,
  type RigEnv,
} from "./ssh.js";

export { parseLedgerText };

export type RunOutcome =
  | "completed"
  | "abort:preflight"
  | "abort:focus"
  | "focus_lost"
  | "watchdog_abort"
  | "failed";

export interface FocusResult {
  ok: boolean;
  foregroundTitle: string;
  capsLock: boolean;
  reason?: string;
  events: FocusGuardEvent[];
  sink?: SinkState;
}

export interface DevicePreflightResult {
  ok: boolean;
  buildIdentity: string;
  expectedBuildIdentity: string;
  autoUpdateEnabled: boolean;
  deviceLayout: string;
  reason?: string;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InjectionRunArgs {
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}

export interface InjectionRunResult {
  hidOutputReports: number;
  details?: Record<string, unknown>;
}

export interface ClassificationSummary {
  per_class_error_vector: ErrorVector;
  garble_events_pre_repair: number;
}

export interface OrchestratorDeps {
  now: () => Date;
  newRunId: () => string;
  getDevicePreflight: (expectedBuildIdentity?: string) => Promise<DevicePreflightResult>;
  measureDeviceClockOffset: () => Promise<number>;
  ensureFocus: () => Promise<FocusResult>;
  probeFocus: () => Promise<FocusResult>;
  sampleCpu: () => Promise<TelemetrySummary>;
  getSinkState: () => Promise<SinkState>;
  readRecvSnapshot: () => Promise<Buffer>;
  fetchTeeLog: () => Promise<string>;
  classifyRun: (args: { recvSnapshot: Buffer; teeLog: string }) => Promise<ClassificationSummary>;
  runInjection: (args: InjectionRunArgs) => Promise<InjectionRunResult>;
}

export interface OrchestratorOptions {
  ledgerPath: string;
  artifactsRoot: string;
  injectionPath: string;
  purpose: string;
  cellId: string;
  corpus: CorpusLedgerInfo & { size?: number };
  corpusText?: string;
  watchdogMs?: number;
  focusPollMs?: number;
  syntheticDurationMs?: number;
  expectedBuildIdentity?: string;
  hostDecodeLayout?: string;
  hidtypeLayout?: HidtypeLayout;
  hidtypeRate?: number;
  hidtypeClear?: boolean;
  hidrpcDelayMs?: number;
  productProfile?: ProductPathProfile;
  forceChurnTelemetry?: boolean;
}

export interface OrchestratorRunResult {
  runId: string;
  outcome: RunOutcome;
  ledgerPath: string;
  artifactsDir: string;
}

interface ArtifactSummary {
  tee_log_path: string;
  recv_txt_path: string;
  [key: string]: unknown;
}

interface RunState {
  telemetry: TelemetrySummary;
  sink: SinkState;
  devicePreflight: DevicePreflightResult;
  focus: FocusResult;
  focusEvents: FocusGuardEvent[];
  hidOutputReports: number;
  injectionDetails: Record<string, unknown>;
  artifactSummary: ArtifactSummary;
  recvSnapshot: Buffer;
  teeLog: string;
  classification: ClassificationSummary;
}

const DEFAULT_WATCHDOG_MS = 30_000;
const DEFAULT_FOCUS_POLL_MS = 1_000;
const DEFAULT_SYNTHETIC_DURATION_MS = 250;

export async function runOrchestrator(
  options: OrchestratorOptions,
  deps?: OrchestratorDeps,
): Promise<OrchestratorRunResult> {
  const runtimeDeps = deps ?? (await createRealDeps(options));
  const runId = runtimeDeps.newRunId();
  const startedAt = runtimeDeps.now();
  const writer = new LedgerWriter(options.ledgerPath);
  const artifactsDir = join(options.artifactsRoot, runId);
  await mkdir(artifactsDir, { recursive: true });

  await appendStep(writer, runId, "run-start", "ok", runtimeDeps.now, {
    injection_path: options.injectionPath,
    purpose: options.purpose,
  });

  let state: RunState | undefined;
  let outcome: RunOutcome = "failed";
  let failureReason = "";

  const telemetry = await safeTelemetry(runtimeDeps, options.forceChurnTelemetry === true);
  const sink = await safeSinkState(runtimeDeps);
  const deviceClockOffsetMs = await runtimeDeps.measureDeviceClockOffset().catch(() => 0);
  const devicePreflight = await runtimeDeps.getDevicePreflight(options.expectedBuildIdentity);

  if (!devicePreflight.ok || devicePreflight.autoUpdateEnabled) {
    outcome = "abort:preflight";
    failureReason = devicePreflight.reason ?? "device_preflight_failed";
    const artifacts = await collectArtifacts(artifactsDir, options.artifactsRoot, runId, runtimeDeps);
    state = await makeState({
      deps: runtimeDeps,
      telemetry,
      sink,
      devicePreflight,
      focus: emptyFocus("not_checked"),
      focusEvents: [],
      hidOutputReports: 0,
      artifactSummary: artifacts.summary,
      recvSnapshot: artifacts.recvSnapshot,
      teeLog: artifacts.teeLog,
    });
    await appendStep(writer, runId, "preflight", outcome, runtimeDeps.now, { reason: failureReason });
  } else {
    const focus = await runtimeDeps.ensureFocus();
    const focusEvents = [...focus.events];
    if (!focus.ok) {
      outcome = "abort:focus";
      failureReason = focus.reason ?? "cannot_confirm_focus";
      const artifacts = await collectArtifacts(artifactsDir, options.artifactsRoot, runId, runtimeDeps);
      state = await makeState({
        deps: runtimeDeps,
        telemetry,
        sink: focus.sink ?? sink,
        devicePreflight,
        focus,
        focusEvents,
        hidOutputReports: 0,
        artifactSummary: artifacts.summary,
        recvSnapshot: artifacts.recvSnapshot,
        teeLog: artifacts.teeLog,
      });
      await appendStep(writer, runId, "focus-guard", outcome, runtimeDeps.now, { reason: failureReason });
    } else if (focus.capsLock) {
      outcome = "abort:preflight";
      failureReason = "caps_lock_on";
      const artifacts = await collectArtifacts(artifactsDir, options.artifactsRoot, runId, runtimeDeps);
      state = await makeState({
        deps: runtimeDeps,
        telemetry,
        sink: focus.sink ?? sink,
        devicePreflight,
        focus,
        focusEvents,
        hidOutputReports: 0,
        artifactSummary: artifacts.summary,
        recvSnapshot: artifacts.recvSnapshot,
        teeLog: artifacts.teeLog,
      });
      await appendStep(writer, runId, "preflight", outcome, runtimeDeps.now, { reason: failureReason });
    } else {
      await appendStep(writer, runId, "preflight", "ok", runtimeDeps.now, {
        build_identity: devicePreflight.buildIdentity,
        focus: focus.foregroundTitle,
      });

      const injection = await runInjectionWithGuards(options, runtimeDeps, focusEvents);
      outcome = injection.outcome;
      failureReason = injection.failureReason;
      await appendStep(writer, runId, "injection", outcome, runtimeDeps.now, {
        hid_output_reports: injection.hidOutputReports,
        reason: failureReason,
      });
      const artifacts = await collectArtifacts(artifactsDir, options.artifactsRoot, runId, runtimeDeps);
      state = await makeState({
        deps: runtimeDeps,
        telemetry,
        sink: focus.sink ?? sink,
        devicePreflight,
        focus,
        focusEvents,
        hidOutputReports: injection.hidOutputReports,
        injectionDetails: injection.injectionDetails,
        artifactSummary: artifacts.summary,
        recvSnapshot: artifacts.recvSnapshot,
        teeLog: artifacts.teeLog,
      });
    }
  }

  const finishedAt = runtimeDeps.now();
  const runRecord = buildRunRecord({
    options,
    runId,
    startedAt,
    finishedAt,
    outcome,
    failureReason,
    state:
      state ??
      (await fallbackState(
        runtimeDeps,
        telemetry,
        sink,
        devicePreflight,
        artifactsDir,
        options.artifactsRoot,
        runId,
      )),
    deviceClockOffsetMs,
  });
  await writer.append(runRecord);

  return { runId, outcome, ledgerPath: options.ledgerPath, artifactsDir };
}

export async function createRealDeps(options: OrchestratorOptions, env?: RigEnv): Promise<OrchestratorDeps> {
  const rigEnv = env ?? (await loadRigEnv());
  return {
    now: () => new Date(),
    newRunId: () => newRunId(),
    getDevicePreflight: (expectedBuildIdentity) => getDevicePreflight(rigEnv, expectedBuildIdentity),
    measureDeviceClockOffset: () => measureDeviceClockOffset(rigEnv),
    ensureFocus: () => runFocusGuard(rigEnv),
    probeFocus: () => runForegroundProbe(rigEnv),
    sampleCpu: () => sampleCpuTelemetry(1, rigEnv),
    getSinkState: async () => {
      const probe = await runForegroundProbe(rigEnv);
      return probe.sink ?? { processCount: 0, maxWorkingSetBytes: 0 };
    },
    readRecvSnapshot: async () => (await readRecvSnapshot(rigEnv)).bytes,
    fetchTeeLog: () => fetchTeeLog(rigEnv),
    classifyRun: async ({ recvSnapshot }) => classifyRecvSnapshot(options.corpusText, recvSnapshot),
    runInjection: (args) => {
      if (options.injectionPath === "raw" || options.injectionPath === "hidtype") {
        return runHidtypeInjection(rigEnv, options, args);
      }
      if (options.injectionPath === "hidrpc") {
        return runHidRpcInjection(rigEnv, options, args);
      }
        if (options.injectionPath === "product") {
          return runProductPathInjection(rigEnv, options, args);
        }
      return runSyntheticInjection(args, options.syntheticDurationMs ?? DEFAULT_SYNTHETIC_DURATION_MS);
    },
  };
}

function classifyRecvSnapshot(corpusText: string | undefined, recvSnapshot: Buffer): ClassificationSummary {
  if (corpusText === undefined) {
    return {
      per_class_error_vector: emptyErrorVector(),
      garble_events_pre_repair: 0,
    };
  }
  const result = classifyDifference(corpusText, recvSnapshot);
  return {
    per_class_error_vector: result.errorVector,
    garble_events_pre_repair:
      result.errorVector["layout-swap-signature"] + result.errorVector["stuck-modifier-run"],
  };
}

async function runHidtypeInjection(
  env: RigEnv,
  options: OrchestratorOptions,
  args: InjectionRunArgs,
): Promise<InjectionRunResult> {
  if (options.corpusText === undefined) {
    throw new Error("raw hidtype injection requires corpusText");
  }
  if (args.signal.aborted) {
    throw args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted");
  }
  args.onProgress(0);
  const hidtypeOptions: RunRawHidtypeOptions = {
    layout: options.hidtypeLayout ?? "uk",
  };
  if (options.hidtypeRate !== undefined) {
    hidtypeOptions.rate = options.hidtypeRate;
  }
  if (options.hidtypeClear !== undefined) {
    hidtypeOptions.clear = options.hidtypeClear;
  }
  if (options.watchdogMs !== undefined) {
    hidtypeOptions.timeoutMs = options.watchdogMs;
  }
  const result = await runRawHidtypeInjection(env, options.corpusText, hidtypeOptions);
  args.onProgress(1);
  return { hidOutputReports: result.hidOutputReports };
}

async function runHidRpcInjection(
  env: RigEnv,
  options: OrchestratorOptions,
  args: InjectionRunArgs,
): Promise<InjectionRunResult> {
  if (options.corpusText === undefined) {
    throw new Error("hidrpc injection requires corpusText");
  }
  if (args.signal.aborted) {
    throw args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted");
  }
  args.onProgress(0);
  const result = await runHidRpcText(env, options.corpusText, {
    delayMs: options.hidrpcDelayMs ?? DEFAULT_HIDRPC_DELAY_MS,
    timeoutMs: options.watchdogMs,
    clearBefore: true,
    saveAfter: true,
    signal: args.signal,
    onProgress: args.onProgress,
  });
  if (!result.handshakeAck) {
    throw new Error("HIDRPC handshake was not acknowledged");
  }
  if (!result.completed || result.failed) {
    throw new Error("HIDRPC macro did not complete successfully");
  }
  args.onProgress(1);
  return { hidOutputReports: result.hidOutputReports };
}

async function runProductPathInjection(
  env: RigEnv,
  options: OrchestratorOptions,
  args: InjectionRunArgs,
): Promise<InjectionRunResult> {
  if (options.corpusText === undefined) {
    throw new Error("product path injection requires corpusText");
  }
  if (args.signal.aborted) {
    throw args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted");
  }
  args.onProgress(0);
  const productOptions: ProductPathRunOptions = {
    profile: options.productProfile ?? "reliable",
    clearBefore: true,
    saveAfter: true,
    signal: args.signal,
    onProgress: args.onProgress,
  };
  if (options.watchdogMs !== undefined) {
    productOptions.timeoutMs = options.watchdogMs;
  }
  const result = await runProductPathText(env, options.corpusText, productOptions);
  if (!result.completed) {
    throw new Error("product path paste did not complete successfully");
  }
  args.onProgress(1);
  return {
    hidOutputReports: result.hidOutputReports,
    details: {
      product_path: buildProductPathLedgerDetails({
        doneLine: result.doneLine,
        manualConfirmContinuations: result.manualConfirmContinuations,
        traceLineCount: result.traceLines.length,
      }),
    },
  };
}

export function calculateClockOffsetMs(sample: {
  beforeNs: bigint;
  deviceNs: bigint;
  afterNs: bigint;
}): number {
  const midpoint = (sample.beforeNs + sample.afterNs) / 2n;
  return Number(sample.deviceNs - midpoint) / 1_000_000;
}

async function runInjectionWithGuards(
  options: OrchestratorOptions,
  deps: OrchestratorDeps,
  focusEvents: FocusGuardEvent[],
): Promise<{
  outcome: RunOutcome;
  failureReason: string;
  hidOutputReports: number;
  injectionDetails: Record<string, unknown>;
}> {
  const controller = new AbortController();
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const focusPollMs = options.focusPollMs ?? DEFAULT_FOCUS_POLL_MS;
  let lastProgressAt = Date.now();
  let hidOutputReports = 0;
  let injectionDetails: Record<string, unknown> = {};
  let abortOutcome: RunOutcome | undefined;
  let abortReason = "";
  let focusProbeInFlight = false;

  const abort = (outcome: RunOutcome, reason: string) => {
    if (controller.signal.aborted) {
      return;
    }
    abortOutcome = outcome;
    abortReason = reason;
    controller.abort(new Error(outcome));
  };

  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > watchdogMs) {
      abort("watchdog_abort", "no_progress");
    }
  }, Math.max(10, Math.floor(watchdogMs / 2)));

  const focusPoll = setInterval(() => {
    if (focusProbeInFlight || controller.signal.aborted) {
      return;
    }
    focusProbeInFlight = true;
    deps
      .probeFocus()
      .then((focus) => {
        focusEvents.push(...focus.events);
        if (!focus.ok) {
          abort("focus_lost", focus.reason ?? focus.foregroundTitle);
        }
      })
      .catch((error: unknown) => {
        abort("focus_lost", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        focusProbeInFlight = false;
      });
  }, focusPollMs);

  try {
    const result = await deps.runInjection({
      signal: controller.signal,
      onProgress: () => {
        lastProgressAt = Date.now();
      },
    });
    hidOutputReports = result.hidOutputReports;
    injectionDetails = result.details ?? {};
    return { outcome: "completed", failureReason: "", hidOutputReports, injectionDetails };
  } catch (error) {
    if (abortOutcome !== undefined) {
      return { outcome: abortOutcome, failureReason: abortReason, hidOutputReports, injectionDetails };
    }
    return {
      outcome: "failed",
      failureReason: error instanceof Error ? error.message : String(error),
      hidOutputReports,
      injectionDetails,
    };
  } finally {
    clearInterval(watchdog);
    clearInterval(focusPoll);
  }
}

async function collectArtifacts(
  artifactsDir: string,
  artifactsRoot: string,
  runId: string,
  deps: OrchestratorDeps,
): Promise<{ summary: ArtifactSummary; recvSnapshot: Buffer; teeLog: string }> {
  await mkdir(artifactsDir, { recursive: true });
  const [teeLog, recvSnapshot] = await Promise.all([
    deps.fetchTeeLog().catch((error: unknown) => `tee fetch failed: ${error instanceof Error ? error.message : String(error)}\n`),
    deps.readRecvSnapshot().catch((error: unknown) =>
      Buffer.from(`recv snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`, "utf8"),
    ),
  ]);
  const teePath = join(artifactsDir, "tee.log");
  const recvPath = join(artifactsDir, "recv.txt");
  await Promise.all([writeFile(teePath, teeLog, "utf8"), writeFile(recvPath, recvSnapshot)]);
  return {
    summary: {
      tee_log_path: normalizeRelativePath(relative(artifactsRoot, teePath), runId),
      recv_txt_path: normalizeRelativePath(relative(artifactsRoot, recvPath), runId),
    },
    recvSnapshot,
    teeLog,
  };
}

async function makeState(args: {
  deps: OrchestratorDeps;
  telemetry: TelemetrySummary;
  sink: SinkState;
  devicePreflight: DevicePreflightResult;
  focus: FocusResult;
  focusEvents: FocusGuardEvent[];
  hidOutputReports: number;
  injectionDetails?: Record<string, unknown>;
  artifactSummary: ArtifactSummary;
  recvSnapshot: Buffer;
  teeLog: string;
}): Promise<RunState> {
  return {
    telemetry: args.telemetry,
    sink: args.sink,
    devicePreflight: args.devicePreflight,
    focus: args.focus,
    focusEvents: args.focusEvents,
    hidOutputReports: args.hidOutputReports,
    injectionDetails: args.injectionDetails ?? {},
    artifactSummary: args.artifactSummary,
    recvSnapshot: args.recvSnapshot,
    teeLog: args.teeLog,
    classification: await args.deps.classifyRun({
      recvSnapshot: args.recvSnapshot,
      teeLog: args.teeLog,
    }),
  };
}

async function fallbackState(
  deps: OrchestratorDeps,
  telemetry: TelemetrySummary,
  sink: SinkState,
  devicePreflight: DevicePreflightResult,
  artifactsDir: string,
  artifactsRoot: string,
  runId: string,
): Promise<RunState> {
  const artifacts = await collectArtifacts(artifactsDir, artifactsRoot, runId, deps);
  return makeState({
    deps,
    telemetry,
    sink,
    devicePreflight,
    focus: emptyFocus("not_checked"),
    focusEvents: [],
    hidOutputReports: 0,
    injectionDetails: {},
    artifactSummary: artifacts.summary,
    recvSnapshot: artifacts.recvSnapshot,
    teeLog: artifacts.teeLog,
  });
}

function buildRunRecord(args: {
  options: OrchestratorOptions;
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  outcome: RunOutcome;
  failureReason: string;
  state: RunState;
  deviceClockOffsetMs: number;
}): RunLedgerRecord {
  const excluded =
    !args.state.telemetry.calm ||
    !isFreshSink(args.state.sink) ||
    args.outcome !== "completed";
  const record: RunLedgerRecord = {
    schema_version: 1,
    record_type: "run",
    run_id: args.runId,
    timestamp: args.startedAt.toISOString(),
    duration_ms: Math.max(0, args.finishedAt.getTime() - args.startedAt.getTime()),
    corpus: args.options.corpus,
    injection_path: args.options.injectionPath,
    build_sha: args.state.devicePreflight.buildIdentity,
    device_layout: args.state.devicePreflight.deviceLayout,
    host_decode_layout: args.options.hostDecodeLayout ?? args.state.devicePreflight.deviceLayout,
    focus_guard_result: args.state.focus.ok ? "pass" : "fail",
    telemetry_summary: args.state.telemetry,
    sink_rss_bytes: args.state.sink.maxWorkingSetBytes,
    harness_version: HARNESS_VERSION,
    device_clock_offset_ms: args.deviceClockOffsetMs,
    cell_id: args.options.cellId,
    purpose: args.options.purpose,
    outcome: args.outcome,
    per_class_error_vector: args.state.classification.per_class_error_vector,
    garble_events_pre_repair: args.state.classification.garble_events_pre_repair,
    excluded_from_thresholds: excluded,
    classifier_version: CLASSIFIER_VERSION,
    corpus_size: args.options.corpus.size,
    preflight: {
      ok: args.outcome !== "abort:preflight" && args.outcome !== "abort:focus",
      reason: args.failureReason || "ok",
      device: args.state.devicePreflight,
      caps_lock_off: !args.state.focus.capsLock,
      focus_guard_confirmed: args.state.focus.ok,
    },
    artifacts: args.state.artifactSummary,
    focus_guard_events: args.state.focusEvents,
    hid_output_reports: args.state.hidOutputReports,
    sink: args.state.sink,
  };
  const productPathDetails = args.state.injectionDetails.product_path;
  if (isRecord(productPathDetails)) {
    record.product_path = productPathDetails;
  }
  if (Object.keys(args.state.injectionDetails).length > 0) {
    record.injection_details = args.state.injectionDetails;
  }
  return record;
}

async function appendStep(
  writer: LedgerWriter,
  runId: string,
  name: string,
  outcome: string,
  now: () => Date,
  details: Record<string, unknown>,
): Promise<void> {
  const timestamp = now();
  const record: StepLedgerRecord = {
    schema_version: 1,
    record_type: "step",
    run_id: runId,
    step_id: `${String(timestamp.getTime()).padStart(13, "0")}-${name}`,
    timestamp: timestamp.toISOString(),
    duration_ms: 0,
    name,
    outcome,
    details,
  };
  await writer.append(record);
}

async function safeTelemetry(deps: OrchestratorDeps, forceChurn: boolean): Promise<TelemetrySummary> {
  if (forceChurn) {
    return {
      cpu_samples: 1,
      max_cpu_percent: 99,
      calm: false,
      cpu_over_threshold_samples: 1,
      forced_churn_control: true,
    };
  }
  return deps.sampleCpu().catch((error: unknown) => ({
    cpu_samples: 0,
    max_cpu_percent: 100,
    calm: false,
    cpu_over_threshold_samples: 1,
    sample_error: error instanceof Error ? error.message : String(error),
  }));
}

async function safeSinkState(deps: OrchestratorDeps): Promise<SinkState> {
  return deps.getSinkState().catch(() => ({ processCount: 0, maxWorkingSetBytes: Number.POSITIVE_INFINITY }));
}

function emptyFocus(reason: string): FocusResult {
  return { ok: false, foregroundTitle: "", capsLock: false, reason, events: [] };
}

function normalizeRelativePath(relativePath: string, runId: string): string {
  const normalized = relativePath.split("\\").join("/");
  return normalized.startsWith(runId) ? `artifacts/${normalized}` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

async function getDevicePreflight(
  env: RigEnv,
  expectedBuildIdentity?: string,
): Promise<DevicePreflightResult> {
  const command = [
    "printf 'hostname='; hostname",
    "printf '\\napp_sha256='; sha256sum /userdata/jetkvm/bin/jetkvm_app 2>/dev/null | awk '{print $1}'",
    "printf '\\nauto_update_enabled='; grep -q '\"auto_update_enabled\": false' /userdata/kvm_config.json && echo false || echo true",
    "printf 'keyboard_layout='; sed -n 's/.*\"keyboard_layout\": \"\\([^\"]*\\)\".*/\\1/p' /userdata/kvm_config.json | head -1",
  ].join("; ");
  const result = await runSshCommand(kvmTarget(env.KVM_PRIMARY), command, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      buildIdentity: "",
      expectedBuildIdentity: expectedBuildIdentity ?? "reported",
      autoUpdateEnabled: true,
      deviceLayout: "",
      reason: result.stderr || result.stdout || "ssh_failed",
    };
  }
  const fields = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const equals = line.indexOf("=");
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
  const hash = fields.app_sha256 ?? "";
  const buildIdentity = `${fields.hostname ?? env.KVM_PRIMARY}:${hash.slice(0, 12)}`;
  const autoUpdateEnabled = fields.auto_update_enabled !== "false";
  const deviceLayout = fields.keyboard_layout ?? "";
  const expected = expectedBuildIdentity ?? buildIdentity;
  const identityMatches = expectedBuildIdentity === undefined || buildIdentity.includes(expectedBuildIdentity);
  const ok = buildIdentity.length > 1 && !autoUpdateEnabled && identityMatches;
  const preflight: DevicePreflightResult = {
    ok,
    buildIdentity,
    expectedBuildIdentity: expected,
    autoUpdateEnabled,
    deviceLayout,
    raw: fields,
  };
  if (!ok) {
    preflight.reason = autoUpdateEnabled ? "auto_update_enabled=true" : "build_identity_mismatch";
  }
  return preflight;
}

async function measureDeviceClockOffset(env: RigEnv): Promise<number> {
  const beforeNs = BigInt(Date.now()) * 1_000_000n;
  const result = await runSshCommand(kvmTarget(env.KVM_PRIMARY), "date +%s%N", { timeoutMs: 10_000 });
  const afterNs = BigInt(Date.now()) * 1_000_000n;
  if (result.exitCode !== 0) {
    throw new Error(`failed to sample device clock: ${result.stderr || result.stdout}`);
  }
  const deviceNs = BigInt(result.stdout.trim());
  return calculateClockOffsetMs({ beforeNs, deviceNs, afterNs });
}

async function fetchTeeLog(env: RigEnv): Promise<string> {
  const command =
    'for f in /tmp/jetkvm-hid-tee.log.1 /tmp/jetkvm-hid-tee.log; do [ -f "$f" ] && cat "$f"; done';
  const result = await runSshCommand(kvmTarget(env.KVM_PRIMARY), command, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout;
}

async function runSyntheticInjection(
  args: InjectionRunArgs,
  durationMs: number,
): Promise<InjectionRunResult> {
  args.onProgress(0);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, durationMs);
    args.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
  args.onProgress(1);
  return { hidOutputReports: 0 };
}

