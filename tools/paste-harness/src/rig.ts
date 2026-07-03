import { Buffer } from "node:buffer";

import {
  loadRigEnv,
  runPowerShell,
  toPowerShellString,
  uploadWindowsTextFile,
  windowsTarget,
  type RigEnv,
} from "./ssh.js";

export const WINDOWS_RIG_DIR = "C:\\Users\\Robert\\paste-rig";
export const WINDOWS_RECV_PATH = "C:\\Users\\Robert\\Documents\\recv.txt";
export const FOCUS_TASK_NAME = "PasteRigFocusGuard";
export const PROBE_TASK_NAME = "PasteRigForegroundProbe";
export const RESET_TASK_NAME = "PasteRigResetNotepad";
export const LAYOUT_TASK_NAME = "PasteRigLayoutPin";
export const INTERACTIVE_PRINCIPAL = "NUCBOX_K15\\Robert";
export const CPU_CALM_THRESHOLD_PERCENT = 40;
export const FRESH_SINK_MAX_RSS_BYTES = 100_000_000;

export interface FocusGuardEvent {
  type: string;
  at: string;
  detail: string;
}

export interface RigFocusResult {
  ok: boolean;
  foregroundTitle: string;
  capsLock: boolean;
  reason?: string;
  events: FocusGuardEvent[];
  sink?: SinkState;
  [key: string]: unknown;
}

export interface SinkState {
  processCount: number;
  maxWorkingSetBytes: number;
}

export interface CpuTelemetrySummary {
  cpu_samples: number;
  max_cpu_percent: number;
  calm: boolean;
  cpu_over_threshold_samples: number;
  [key: string]: unknown;
}

export interface RecvSnapshotJson {
  ok: boolean;
  base64?: string;
  lastWriteTimeUtc?: string;
  length?: number;
  reason?: string;
}

export interface RecvSnapshot {
  bytes: Buffer;
  lastWriteTimeUtc: string;
  length: number;
}

export interface RigScriptInstallResult {
  uploaded: string[];
  registeredTasks: string[];
}

type RigScriptMap = Record<string, string>;

const TASKS = [
  { name: FOCUS_TASK_NAME, script: "focus-guard.ps1" },
  { name: PROBE_TASK_NAME, script: "foreground-probe.ps1" },
  { name: RESET_TASK_NAME, script: "reset-notepad.ps1" },
  { name: LAYOUT_TASK_NAME, script: "layout-pin.ps1" },
] as const;

export function makeNucBoxRigScripts(recvPath = WINDOWS_RECV_PATH): RigScriptMap {
  return {
    "common.ps1": commonScript(recvPath),
    "focus-guard.ps1": dotSourceScript("Invoke-PasteRigFocusGuard", "focus-guard-result.json"),
    "foreground-probe.ps1": dotSourceScript("Invoke-PasteRigForegroundProbe", "foreground-probe-result.json"),
    "reset-notepad.ps1": dotSourceScript("Invoke-PasteRigResetNotepad", "reset-notepad-result.json"),
    "layout-pin.ps1": dotSourceScript("Invoke-PasteRigPinUkLayout", "layout-pin-result.json"),
    "cpu-sample.ps1": cpuSampleScript(),
    "read-recv.ps1": readRecvScript(recvPath),
    "save-landed.ps1": saveLandedScript(recvPath),
  };
}

export function buildScheduledTaskRegistrationScript(): string {
  const taskLines = TASKS.map(
    (task) => `
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${toPowerShellString(
      `-NoProfile -ExecutionPolicy Bypass -File "${WINDOWS_RIG_DIR}\\${task.script}"`,
    )}
Register-ScheduledTask -TaskName ${toPowerShellString(
      task.name,
    )} -Action $action -Principal $principal -Settings $settings -Force | Out-Null
`,
  ).join("\n");

  return `
$ErrorActionPreference = 'Stop'
$principal = New-ScheduledTaskPrincipal -UserId ${toPowerShellString(
    INTERACTIVE_PRINCIPAL,
  )} -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
${taskLines}
[PSCustomObject]@{ ok = $true; registered = @(${TASKS.map((task) => toPowerShellString(task.name)).join(", ")}) } | ConvertTo-Json -Compress
`;
}

export async function installNucBoxRigScripts(env?: RigEnv): Promise<RigScriptInstallResult> {
  const rigEnv = env ?? (await loadRigEnv());
  const target = windowsTarget(rigEnv);
  const scripts = makeNucBoxRigScripts(rigEnv.WIN_RECV || WINDOWS_RECV_PATH);
  const uploaded: string[] = [];

  for (const [name, content] of Object.entries(scripts)) {
    await uploadWindowsTextFile(target, `${WINDOWS_RIG_DIR}\\${name}`, content);
    uploaded.push(name);
  }

  const result = await runPowerShell(target, buildScheduledTaskRegistrationScript());
  if (result.exitCode !== 0) {
    throw new Error(`failed to register NucBox rig tasks: ${result.stderr || result.stdout}`);
  }

  return { uploaded: uploaded.sort(), registeredTasks: TASKS.map((task) => task.name) };
}

export async function runFocusGuard(env?: RigEnv): Promise<RigFocusResult> {
  const rigEnv = env ?? (await loadRigEnv());
  return parsePowerShellJson<RigFocusResult>(
    await runScheduledTaskAndReadResult(windowsTarget(rigEnv), FOCUS_TASK_NAME, "focus-guard-result.json"),
  );
}

export async function runForegroundProbe(env?: RigEnv): Promise<RigFocusResult> {
  const rigEnv = env ?? (await loadRigEnv());
  return parsePowerShellJson<RigFocusResult>(
    await runScheduledTaskAndReadResult(windowsTarget(rigEnv), PROBE_TASK_NAME, "foreground-probe-result.json"),
  );
}

export async function resetNotepad(env?: RigEnv): Promise<RigFocusResult> {
  const rigEnv = env ?? (await loadRigEnv());
  await runPowerShell(
    windowsTarget(rigEnv),
    "Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    { timeoutMs: 10_000 },
  );
  return parsePowerShellJson<RigFocusResult>(
    await runScheduledTaskAndReadResult(windowsTarget(rigEnv), RESET_TASK_NAME, "reset-notepad-result.json", 15_000),
  );
}

export async function pinUkLayout(env?: RigEnv): Promise<Record<string, unknown>> {
  const rigEnv = env ?? (await loadRigEnv());
  return parsePowerShellJson<Record<string, unknown>>(
    await runScheduledTaskAndReadResult(windowsTarget(rigEnv), LAYOUT_TASK_NAME, "layout-pin-result.json", 15_000),
  );
}

export async function sampleCpuTelemetry(samples: number, env?: RigEnv): Promise<CpuTelemetrySummary> {
  const rigEnv = env ?? (await loadRigEnv());
  const script = `& ${toPowerShellString(`${WINDOWS_RIG_DIR}\\cpu-sample.ps1`)} -Samples ${samples}`;
  const result = await runPowerShell(windowsTarget(rigEnv), script, { timeoutMs: (samples + 5) * 1_000 });
  if (result.exitCode !== 0) {
    throw new Error(`failed to sample NucBox CPU: ${result.stderr || result.stdout}`);
  }
  const parsed = parsePowerShellJson<number[] | { samples: number[] }>(result.stdout);
  return summarizeCpuSamples(Array.isArray(parsed) ? parsed : parsed.samples);
}

export async function readRecvSnapshot(env?: RigEnv): Promise<RecvSnapshot> {
  const rigEnv = env ?? (await loadRigEnv());
  const result = await runPowerShell(windowsTarget(rigEnv), `& ${toPowerShellString(`${WINDOWS_RIG_DIR}\\read-recv.ps1`)}`);
  if (result.exitCode !== 0) {
    throw new Error(`failed to read recv.txt: ${result.stderr || result.stdout}`);
  }
  return decodeRecvSnapshot(parsePowerShellJson<RecvSnapshotJson>(result.stdout));
}

export async function checkSaveLanded(startedAtUtc: string, env?: RigEnv): Promise<Record<string, unknown>> {
  const rigEnv = env ?? (await loadRigEnv());
  const script = `& ${toPowerShellString(`${WINDOWS_RIG_DIR}\\save-landed.ps1`)} -StartedAtUtc ${toPowerShellString(
    startedAtUtc,
  )}`;
  const result = await runPowerShell(windowsTarget(rigEnv), script);
  if (result.exitCode !== 0) {
    throw new Error(`failed to check recv.txt LastWriteTime: ${result.stderr || result.stdout}`);
  }
  return parsePowerShellJson<Record<string, unknown>>(result.stdout);
}

export function parsePowerShellJson<T>(output: string): T {
  const cleaned = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#<") && !line.startsWith("<"))
    .join("\n")
    .trim();
  const jsonStartCandidates = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((index) => index >= 0);
  const jsonStart = jsonStartCandidates.length > 0 ? Math.min(...jsonStartCandidates) : -1;
  if (jsonStart === -1) {
    throw new Error(`PowerShell output did not contain JSON: ${output}`);
  }
  return JSON.parse(cleaned.slice(jsonStart)) as T;
}

export function summarizeCpuSamples(samples: readonly number[]): CpuTelemetrySummary {
  const finiteSamples = samples.filter((sample) => Number.isFinite(sample));
  const maxCpu = finiteSamples.length > 0 ? Math.max(...finiteSamples) : 0;
  const overThreshold = finiteSamples.filter((sample) => sample > CPU_CALM_THRESHOLD_PERCENT).length;
  return {
    cpu_samples: finiteSamples.length,
    max_cpu_percent: maxCpu,
    calm: overThreshold === 0,
    cpu_over_threshold_samples: overThreshold,
  };
}

export function decodeRecvSnapshot(snapshot: RecvSnapshotJson): RecvSnapshot {
  if (!snapshot.ok || typeof snapshot.base64 !== "string") {
    throw new Error(`recv snapshot failed: ${snapshot.reason ?? "missing base64"}`);
  }
  const bytes = Buffer.from(snapshot.base64, "base64");
  return {
    bytes,
    lastWriteTimeUtc: snapshot.lastWriteTimeUtc ?? "",
    length: snapshot.length ?? bytes.length,
  };
}

export function isFreshSink(sink: SinkState): boolean {
  return sink.processCount === 1 && sink.maxWorkingSetBytes < FRESH_SINK_MAX_RSS_BYTES;
}

async function runScheduledTaskAndReadResult(
  target: string,
  taskName: string,
  resultFileName: string,
  timeoutMs = 10_000,
): Promise<string> {
  const resultPath = `${WINDOWS_RIG_DIR}\\${resultFileName}`;
  const script = `
$ErrorActionPreference = 'Stop'
$resultPath = ${toPowerShellString(resultPath)}
Remove-Item -LiteralPath $resultPath -ErrorAction SilentlyContinue
schtasks.exe /Run /TN ${toPowerShellString(taskName)} | Out-Null
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $resultPath) {
    Get-Content -LiteralPath $resultPath -Raw
    exit 0
  }
  Start-Sleep -Milliseconds 200
}
throw "timed out waiting for ${taskName} result"
`;
  const result = await runPowerShell(target, script, { timeoutMs: timeoutMs + 5_000 });
  if (result.exitCode !== 0) {
    throw new Error(`scheduled task ${taskName} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function dotSourceScript(functionName: string, resultFileName: string): string {
  const layoutComment = functionName === "Invoke-PasteRigPinUkLayout" ? "# Pins Preload to 00000809 only\n" : "";
  return `
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\\common.ps1"
${layoutComment}
${functionName} -ResultPath "$PSScriptRoot\\${resultFileName}"
`;
}

function commonScript(recvPath: string): string {
  return `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RecvPath = ${toPowerShellString(recvPath)}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PasteRigUser32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function ConvertTo-PasteRigJson {
  param([Parameter(Mandatory=$true)] $Object, [Parameter(Mandatory=$true)] [string] $Path)
  $Object | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-PasteRigNow {
  (Get-Date).ToUniversalTime().ToString('o')
}

function Get-PasteRigWindowTitle {
  param([Parameter(Mandatory=$true)] [IntPtr] $Handle)
  $builder = New-Object System.Text.StringBuilder 512
  [void][PasteRigUser32]::GetWindowText($Handle, $builder, $builder.Capacity)
  $builder.ToString()
}

function Get-PasteRigForegroundInfo {
  $handle = [PasteRigUser32]::GetForegroundWindow()
  $title = Get-PasteRigWindowTitle -Handle $handle
  [uint32]$windowProcessId = 0
  [void][PasteRigUser32]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
  [PSCustomObject]@{
    title = $title
    processId = [int]$windowProcessId
    isRecvNotepad = ($title -like '*recv.txt - Notepad*')
  }
}

function Find-PasteRigRecvNotepadWindow {
  $matches = New-Object System.Collections.Generic.List[object]
  $callback = [PasteRigUser32+EnumWindowsProc]{
    param([IntPtr] $handle, [IntPtr] $lParam)
    if ([PasteRigUser32]::IsWindowVisible($handle)) {
      $title = Get-PasteRigWindowTitle -Handle $handle
      if ($title -like '*recv.txt - Notepad*') {
        [uint32]$windowProcessId = 0
        [void][PasteRigUser32]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
        $matches.Add([PSCustomObject]@{ handle = $handle; title = $title; processId = [int]$windowProcessId }) | Out-Null
      }
    }
    return $true
  }
  [void][PasteRigUser32]::EnumWindows($callback, [IntPtr]::Zero)
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}

function Get-PasteRigCapsLock {
  try { return [Console]::CapsLock } catch { return $false }
}

function Get-PasteRigSinkState {
  $windows = @()
  $target = Find-PasteRigRecvNotepadWindow
  if ($null -ne $target) {
    $windows += $target
  }
  $processes = @()
  foreach ($window in $windows) {
    $proc = Get-Process -Id $window.processId -ErrorAction SilentlyContinue
    if ($null -ne $proc) { $processes += $proc }
  }
  $maxWs = 0
  foreach ($proc in $processes) {
    if ($proc.WorkingSet64 -gt $maxWs) { $maxWs = $proc.WorkingSet64 }
  }
  [PSCustomObject]@{ processCount = $windows.Count; maxWorkingSetBytes = [int64]$maxWs }
}

function Invoke-PasteRigFocusGuard {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  $events = New-Object System.Collections.Generic.List[object]
  $before = Get-PasteRigForegroundInfo
  if (-not $before.isRecvNotepad) {
    $events.Add([PSCustomObject]@{ type='wrong_foreground'; at=(Get-PasteRigNow); detail=$before.title }) | Out-Null
  }
  $target = Find-PasteRigRecvNotepadWindow
  if ($null -eq $target) {
    $events.Add([PSCustomObject]@{ type='notepad_missing'; at=(Get-PasteRigNow); detail='' }) | Out-Null
    ConvertTo-PasteRigJson -Path $ResultPath -Object ([PSCustomObject]@{
      ok = $false; reason = 'notepad_not_found'; foregroundTitle = $before.title; capsLock = (Get-PasteRigCapsLock); events = $events; sink = (Get-PasteRigSinkState)
    })
    return
  }
  [void][PasteRigUser32]::ShowWindow($target.handle, 9)
  [void][PasteRigUser32]::SetForegroundWindow($target.handle)
  Start-Sleep -Milliseconds 350
  $after = Get-PasteRigForegroundInfo
  if ($after.isRecvNotepad) {
    $events.Add([PSCustomObject]@{ type='refocused'; at=(Get-PasteRigNow); detail=$after.title }) | Out-Null
    $events.Add([PSCustomObject]@{ type='confirmed'; at=(Get-PasteRigNow); detail=$after.title }) | Out-Null
  } else {
    $events.Add([PSCustomObject]@{ type='focus_failed'; at=(Get-PasteRigNow); detail=$after.title }) | Out-Null
  }
  ConvertTo-PasteRigJson -Path $ResultPath -Object ([PSCustomObject]@{
    ok = $after.isRecvNotepad; reason = $(if ($after.isRecvNotepad) { '' } else { 'cannot_confirm_focus' }); foregroundTitle = $after.title; capsLock = (Get-PasteRigCapsLock); events = $events; sink = (Get-PasteRigSinkState)
  })
}

function Invoke-PasteRigForegroundProbe {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  $fg = Get-PasteRigForegroundInfo
  ConvertTo-PasteRigJson -Path $ResultPath -Object ([PSCustomObject]@{
    ok = $fg.isRecvNotepad; reason = $(if ($fg.isRecvNotepad) { '' } else { 'wrong_foreground' }); foregroundTitle = $fg.title; capsLock = (Get-PasteRigCapsLock); events = @([PSCustomObject]@{ type='probe'; at=(Get-PasteRigNow); detail=$fg.title }); sink = (Get-PasteRigSinkState)
  })
}

function Invoke-PasteRigResetNotepad {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $parent = Split-Path -Parent $RecvPath
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [IO.File]::WriteAllText($RecvPath, '', [Text.UTF8Encoding]::new($false))
  Start-Process -FilePath 'notepad.exe' -ArgumentList $RecvPath
  Start-Sleep -Seconds 1
  Invoke-PasteRigFocusGuard -ResultPath $ResultPath
}

function Invoke-PasteRigPinUkLayout {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  $preload = 'HKCU:\\Keyboard Layout\\Preload'
  $backupPath = Join-Path $PSScriptRoot 'layout-preload-before.json'
  if (-not (Test-Path -LiteralPath $preload)) { New-Item -Path $preload -Force | Out-Null }
  $before = Get-ItemProperty -LiteralPath $preload
  if (-not (Test-Path -LiteralPath $backupPath)) {
    $snapshot = @{}
    foreach ($property in $before.PSObject.Properties) {
      if ($property.Name -match '^\\d+$') { $snapshot[$property.Name] = [string]$property.Value }
    }
    $snapshot | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $backupPath -Encoding UTF8
  }
  foreach ($property in $before.PSObject.Properties) {
    if ($property.Name -match '^\\d+$') {
      Remove-ItemProperty -LiteralPath $preload -Name $property.Name -ErrorAction SilentlyContinue
    }
  }
  New-ItemProperty -LiteralPath $preload -Name '1' -Value '00000809' -PropertyType String -Force | Out-Null
  ConvertTo-PasteRigJson -Path $ResultPath -Object ([PSCustomObject]@{ ok = $true; preload = @{ '1' = '00000809' }; backupPath = $backupPath })
}
`;
}

function cpuSampleScript(): string {
  return `
param([int] $Samples = 1)
$ErrorActionPreference = 'Stop'
$values = @()
$result = Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples $Samples
foreach ($sample in $result.CounterSamples) {
  $values += [math]::Round([double]$sample.CookedValue, 2)
}
[PSCustomObject]@{ samples = @($values) } | ConvertTo-Json -Compress
`;
}

function readRecvScript(recvPath: string): string {
  return `
$ErrorActionPreference = 'Stop'
$path = ${toPowerShellString(recvPath)}
if (-not (Test-Path -LiteralPath $path)) {
  [PSCustomObject]@{ ok = $false; reason = 'missing_recv_txt' } | ConvertTo-Json -Compress
  exit 0
}
$bytes = [IO.File]::ReadAllBytes($path)
$item = Get-Item -LiteralPath $path
[PSCustomObject]@{
  ok = $true
  base64 = [Convert]::ToBase64String($bytes)
  length = $bytes.Length
  lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
} | ConvertTo-Json -Compress
`;
}

function saveLandedScript(recvPath: string): string {
  return `
param([Parameter(Mandatory=$true)] [string] $StartedAtUtc)
$ErrorActionPreference = 'Stop'
$path = ${toPowerShellString(recvPath)}
$started = [DateTime]::Parse($StartedAtUtc).ToUniversalTime()
if (-not (Test-Path -LiteralPath $path)) {
  [PSCustomObject]@{ ok = $false; reason = 'missing_recv_txt'; saveLanded = $false } | ConvertTo-Json -Compress
  exit 0
}
$item = Get-Item -LiteralPath $path
[PSCustomObject]@{
  ok = $true
  lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
  saveLanded = ($item.LastWriteTimeUtc.ToUniversalTime() -gt $started)
} | ConvertTo-Json -Compress
`;
}
