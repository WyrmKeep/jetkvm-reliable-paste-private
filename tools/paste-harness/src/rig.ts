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
export const FRESH_SINK_MAX_RSS_BYTES = 250_000_000;

export interface FocusGuardEvent {
  type: string;
  at: string;
  detail: string;
}

export interface RigFocusResult {
  ok: boolean;
  foregroundTitle: string;
  capsLock: boolean;
  lockKeys: {
    capsLock: boolean;
    numLock: boolean;
    scrollLock: boolean;
  };
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
    await runScheduledTaskAndReadResult(windowsTarget(rigEnv), RESET_TASK_NAME, "reset-notepad-result.json", 45_000),
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
$resultPath = "$PSScriptRoot\\${resultFileName}"
try {
  . "$PSScriptRoot\\common.ps1"
${layoutComment
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => `  ${line}`)
  .join("\n")}
  ${functionName} -ResultPath $resultPath
} catch {
  [PSCustomObject]@{
    ok = $false
    reason = $_.Exception.Message
    line = $_.InvocationInfo.ScriptLineNumber
    position = $_.InvocationInfo.PositionMessage
  } | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
  throw
}
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
  [DllImport("user32.dll")] public static extern short GetKeyState(int virtualKey);
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

function Get-PasteRigLockKeys {
  [PSCustomObject]@{
    capsLock = $(try { [Console]::CapsLock } catch { $false })
    numLock = $(try { [Console]::NumberLock } catch { $false })
    scrollLock = $(([PasteRigUser32]::GetKeyState(0x91) -band 1) -ne 0)
  }
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

function Start-PasteRigNotepad {
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $RecvPath
    Start-Sleep -Milliseconds 750
    if ($null -ne (Find-PasteRigRecvNotepadWindow)) { return }
  } catch {}

  $notepadExe = 'notepad.exe'
  try {
    $package = Get-AppxPackage -Name Microsoft.WindowsNotepad -ErrorAction SilentlyContinue
    if ($null -ne $package) {
      $packagedExe = Join-Path $package.InstallLocation 'Notepad\\Notepad.exe'
      if (Test-Path -LiteralPath $packagedExe) {
        $notepadExe = $packagedExe
      }
    }
  } catch {}
  Start-Process -FilePath $notepadExe -ArgumentList $RecvPath
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
      ok = $false; reason = 'notepad_not_found'; foregroundTitle = $before.title; capsLock = (Get-PasteRigLockKeys).capsLock; lockKeys = (Get-PasteRigLockKeys); events = $events; sink = (Get-PasteRigSinkState)
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
    ok = $after.isRecvNotepad; reason = $(if ($after.isRecvNotepad) { '' } else { 'cannot_confirm_focus' }); foregroundTitle = $after.title; capsLock = (Get-PasteRigLockKeys).capsLock; lockKeys = (Get-PasteRigLockKeys); events = $events; sink = (Get-PasteRigSinkState)
  })
}

function Invoke-PasteRigForegroundProbe {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  $fg = Get-PasteRigForegroundInfo
  ConvertTo-PasteRigJson -Path $ResultPath -Object ([PSCustomObject]@{
    ok = $fg.isRecvNotepad; reason = $(if ($fg.isRecvNotepad) { '' } else { 'wrong_foreground' }); foregroundTitle = $fg.title; capsLock = (Get-PasteRigLockKeys).capsLock; lockKeys = (Get-PasteRigLockKeys); events = @([PSCustomObject]@{ type='probe'; at=(Get-PasteRigNow); detail=$fg.title }); sink = (Get-PasteRigSinkState)
  })
}

function Get-PasteRigToggleState {
  param($Element)
  if ($null -eq $Element) { return $null }
  try { return $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch { return $null }
}

function Find-PasteRigAutomationControl {
  param(
    [Parameter(Mandatory=$true)] $Root,
    [string] $Name = '',
    [string] $AutomationId = '',
    [bool] $RequireToggle = $false
  )
  $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    $nameOk = ($Name.Length -eq 0 -or $element.Current.Name -eq $Name)
    $idOk = ($AutomationId.Length -eq 0 -or $element.Current.AutomationId -eq $AutomationId)
    if (-not ($nameOk -and $idOk)) { continue }
    if ($RequireToggle) {
      try {
        if (-not [bool]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) { continue }
      } catch { continue }
    }
    return $element
  }
  return $null
}

function Invoke-PasteRigAutomationControl {
  param($Element)
  if ($null -eq $Element) { throw 'automation control not found' }
  try {
    $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return
  } catch {}
  try {
    $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    return
  } catch {}
  throw "automation control '$($Element.Current.Name)' supports neither Invoke nor Toggle"
}

function Set-PasteRigToggleOff {
  param($Element, [Parameter(Mandatory=$true)] [string] $Label)
  if ($null -eq $Element) {
    return [PSCustomObject]@{ label = $Label; found = $false; before = $null; after = $null; changed = $false }
  }
  $before = Get-PasteRigToggleState $Element
  $changed = $false
  if ($before -eq 'On' -or $before -eq 'Indeterminate') {
    $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 500
    $changed = $true
  }
  $after = Get-PasteRigToggleState $Element
  if ($after -ne 'Off' -and $before -ne 'Off') {
    $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 500
    $after = Get-PasteRigToggleState $Element
    $changed = $true
  }
  return [PSCustomObject]@{ label = $Label; found = $true; before = $before; after = $after; changed = $changed }
}

function Set-PasteRigNotepadSpellingOff {
  $statusPath = Join-Path $PSScriptRoot 'notepad-spelling-status.json'
  $settingsDat = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsNotepad_8wekyb3d8bbwe\\Settings\\settings.dat'
  $backupPath = Join-Path $PSScriptRoot 'notepad-settings-before-spelling-off.dat'
  if ((Test-Path -LiteralPath $settingsDat) -and -not (Test-Path -LiteralPath $backupPath)) {
    Copy-Item -LiteralPath $settingsDat -Destination $backupPath -Force
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $probeProcess = $null
  try {
    Start-PasteRigNotepad
    $probeWindow = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      Start-Sleep -Milliseconds 250
      $probeWindow = Find-PasteRigRecvNotepadWindow
      if ($null -ne $probeWindow) { break }
    }
    if ($null -eq $probeWindow) {
      throw 'notepad settings probe window not found'
    }
    $probeProcess = Get-Process -Id $probeWindow.processId -ErrorAction Stop
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($probeWindow.handle)
    $settings = Find-PasteRigAutomationControl -Root $root -Name 'Settings' -AutomationId 'SettingsButton'
    Invoke-PasteRigAutomationControl $settings
    Start-Sleep -Seconds 2
    $settingsRoot = [System.Windows.Automation.AutomationElement]::FromHandle($probeWindow.handle)
    $spell = Find-PasteRigAutomationControl -Root $settingsRoot -Name 'Spell check' -AutomationId 'SpellCheckSwitch' -RequireToggle $true
    $autocorrect = Find-PasteRigAutomationControl -Root $settingsRoot -Name 'Autocorrect' -RequireToggle $true
    $before = @(
      [PSCustomObject]@{ label = 'Spell check'; state = (Get-PasteRigToggleState $spell); found = ($null -ne $spell) },
      [PSCustomObject]@{ label = 'Autocorrect'; state = (Get-PasteRigToggleState $autocorrect); found = ($null -ne $autocorrect) }
    )
    $actions = @()
    $actions += Set-PasteRigToggleOff $autocorrect 'Autocorrect'
    $settingsRoot = [System.Windows.Automation.AutomationElement]::FromHandle($probeWindow.handle)
    $spell = Find-PasteRigAutomationControl -Root $settingsRoot -Name 'Spell check' -AutomationId 'SpellCheckSwitch' -RequireToggle $true
    $actions += Set-PasteRigToggleOff $spell 'Spell check'
    Start-Sleep -Milliseconds 500
    $settingsRoot = [System.Windows.Automation.AutomationElement]::FromHandle($probeWindow.handle)
    $spellAfter = Find-PasteRigAutomationControl -Root $settingsRoot -Name 'Spell check' -AutomationId 'SpellCheckSwitch' -RequireToggle $true
    $autocorrectAfter = Find-PasteRigAutomationControl -Root $settingsRoot -Name 'Autocorrect' -RequireToggle $true
    $spellAfterState = Get-PasteRigToggleState $spellAfter
    $autocorrectAfterState = Get-PasteRigToggleState $autocorrectAfter
    $after = @(
      [PSCustomObject]@{ label = 'Spell check'; state = $spellAfterState; found = ($null -ne $spellAfter) },
      [PSCustomObject]@{ label = 'Autocorrect'; state = $autocorrectAfterState; found = ($null -ne $autocorrectAfter) }
    )
  } finally {
    if ($null -ne $probeProcess) {
      Get-Process -Id $probeProcess.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }
  }

  $bothTogglesNotFound = (($null -eq $spellAfter) -and ($null -eq $autocorrectAfter))
  $spellOk = ($null -eq $spellAfter) -or ($spellAfterState -eq 'Off')
  $autocorrectOk = ($null -eq $autocorrectAfter) -or ($autocorrectAfterState -eq 'Off')
  $failureReason = ''
  if ($bothTogglesNotFound) {
    $failureReason = 'notepad_spelling_toggles_not_found'
  } elseif (-not ($spellOk -and $autocorrectOk)) {
    $failureReason = 'notepad_spelling_toggles_not_off'
  }
  $status = [PSCustomObject]@{
    ok = (($spellOk -and $autocorrectOk) -and -not $bothTogglesNotFound)
    checkedAt = (Get-PasteRigNow)
    skipped = $false
    failureReason = $failureReason
    settingsDat = $settingsDat
    backupPath = $(if (Test-Path -LiteralPath $backupPath) { $backupPath } else { '' })
    before = $before
    actions = $actions
    after = $after
  }
  ConvertTo-PasteRigJson -Path $statusPath -Object $status
  if (-not $status.ok) {
    throw "failed to disable Notepad spelling transforms"
  }
  return $status
}

function Invoke-PasteRigResetNotepad {
  param([Parameter(Mandatory=$true)] [string] $ResultPath)
  Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $parent = Split-Path -Parent $RecvPath
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [IO.File]::WriteAllText($RecvPath, '', [Text.UTF8Encoding]::new($false))
  Set-PasteRigNotepadSpellingOff | Out-Null
  Start-PasteRigNotepad
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
