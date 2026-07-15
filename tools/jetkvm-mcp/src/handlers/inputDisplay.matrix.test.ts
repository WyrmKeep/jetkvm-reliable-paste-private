import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import { BrowserPlaneError } from "../browser/bridgeProtocol.js";

import {
  CAPABILITY_NAMES,
  PERMISSION_NAMES,
  type CapabilityName,
  type CapabilitySnapshot,
  type InputKeyboardInput,
  type InputMouseInput,
  type InputPasteInput,
  type InputReleaseInput,
  type JetKvmToolName,
  type PermissionName,
} from "../domain.js";
import {
  DeviceRpcError,
  type DeviceRpcBinding,
  type SessionRef,
} from "../device/DeviceRpcAdapter.js";
import {
  RequestLedger,
  type LedgerReservation,
  type LedgerTerminal,
} from "../idempotency/RequestLedger.js";
import type { JetKvmHandlerContext, JetKvmToolHandler } from "../mcp/server.js";
import type {
  BrowserCaptureImage,
  MutationReceipt,
} from "../planes/BrowserPlane.js";
import { DeviceSessionClient } from "../session/deviceSessionClient.js";
import {
  TOOL_BEHAVIOR_MATRIX,
  validateFocusedAssertionExecutions,
  type FocusedAssertionExecutionResult,
} from "../stories/manifest.js";
import { FakeBrowserPlane } from "../test-support/fakes/FakeBrowserPlane.js";
import { FakeDeviceRpcAdapter } from "../test-support/fakes/FakeDeviceRpcAdapter.js";
import { FakeNativeControlPlane } from "../test-support/fakes/FakeNativeControlPlane.js";
import type {
  PlaneFault,
  PlaneOperation,
  PlaneScenarioStep,
} from "../test-support/fakes/PlaneScenario.js";
import { normalizeControlledTraceValue } from "../test-support/controlledTrace.js";
import { createDisplayHandlers } from "./display.js";
import { createInputHandlers } from "./input.js";

const SUITE_IDENTITY = "Phase 3 handler focused assertion matrix";
const PHASE_3_TOOLS: readonly JetKvmToolName[] = [
  "jetkvm_display_capture",
  "jetkvm_display_status",
  "jetkvm_input_keyboard",
  "jetkvm_input_mouse",
  "jetkvm_input_paste",
  "jetkvm_input_release",
];

type Phase3FocusedCell = Readonly<{
  tool: JetKvmToolName;
  requirement: string;
  id: string;
}>;

const PHASE_3_FOCUSED_CELLS: readonly Phase3FocusedCell[] =
  TOOL_BEHAVIOR_MATRIX.flatMap((row) =>
    PHASE_3_TOOLS.flatMap((tool) => {
      const cell = row.cells[tool];
      return cell.applicability === "applicable" &&
        cell.focused_assertion_owner_phase === "phase_3"
        ? [
            {
              tool,
              requirement: row.requirement,
              id: cell.focused_assertion_id,
            },
          ]
        : [];
    }),
  );

export const PHASE_3_HANDLER_FOCUSED_RESULTS: FocusedAssertionExecutionResult[] =
  [];
const CONTROLLED_TRACE_PATH = resolve(
  "reports/controlled-traces/input-display.json",
);
const controlledTraces: Record<
  string,
  {
    readonly test_identity: string;
    readonly calls: readonly {
      readonly tool: JetKvmToolName;
      readonly request: unknown;
      readonly response: unknown;
    }[];
  }
> = {};
let activeTraceIdentity: string | undefined;
let activeTraceTestIdentity: string | undefined;
let activeTraceCalls: {
  tool: JetKvmToolName;
  request: unknown;
  response: unknown;
}[] = [];

async function verifyControlledTraceReport(): Promise<void> {
  const report = {
    schema_version: 1,
    evidence_source: "execution-produced-focused-handler-calls",
    traces: Object.fromEntries(
      Object.entries(controlledTraces).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.JETKVM_WRITE_CONTROLLED_TRACES === "1") {
    await mkdir(dirname(CONTROLLED_TRACE_PATH), { recursive: true });
    await writeFile(CONTROLLED_TRACE_PATH, serialized, "utf8");
  } else {
    expect(await readFile(CONTROLLED_TRACE_PATH, "utf8")).toBe(serialized);
  }
}

export function focusedAssertionTest(
  cell: Phase3FocusedCell,
  execute: () => void | Promise<void>,
): void {
  const testName = `${cell.tool} ${cell.requirement}`;
  const testIdentity = `${SUITE_IDENTITY} > ${testName}`;
  it(
    testName,
    {
      meta: {
        focused_assertion_ids: [cell.id],
        focused_test_identity: testIdentity,
      },
    },
    async () => {
      activeTraceIdentity = `focused:${cell.id}`;
      activeTraceTestIdentity = testIdentity;
      activeTraceCalls = [];
      try {
        await execute();
        PHASE_3_HANDLER_FOCUSED_RESULTS.push({
          focused_assertion_id: cell.id,
          test_identity: testIdentity,
          result: "pass",
        });
      } catch (error) {
        PHASE_3_HANDLER_FOCUSED_RESULTS.push({
          focused_assertion_id: cell.id,
          test_identity: testIdentity,
          result: "fail",
        });
        throw error;
      } finally {
        controlledTraces[activeTraceIdentity] = {
          test_identity: activeTraceTestIdentity,
          calls: activeTraceCalls,
        };
        activeTraceIdentity = undefined;
        activeTraceTestIdentity = undefined;
        activeTraceCalls = [];
      }
    },
  );
}

class HandlerClock {
  public value = 100;
  public sequence: number[] = [];

  public now(): number {
    return this.sequence.shift() ?? this.value;
  }
}

type RecordedTerminal = Readonly<{
  terminal: LedgerTerminal<unknown>;
  persistedBeforeResponse: boolean;
}>;

class RecordingRequestLedger extends RequestLedger {
  public readonly recorded: RecordedTerminal[] = [];

  public override completeBeforeResponse<T, R>(
    reservation: LedgerReservation,
    terminal: LedgerTerminal<T>,
    respond: (terminal: LedgerTerminal<T>) => R,
  ): R {
    return super.completeBeforeResponse(reservation, terminal, (persisted) => {
      this.recorded.push({
        terminal: structuredClone(persisted) as LedgerTerminal<unknown>,
        persistedBeforeResponse: true,
      });
      return respond(persisted);
    });
  }
}

const ALL_CAPABILITIES = Object.fromEntries(
  CAPABILITY_NAMES.map((capability) => [capability, true]),
) as CapabilitySnapshot;
const ALL_PERMISSIONS = [...PERMISSION_NAMES] as readonly PermissionName[];
const BASE_BINDING: DeviceRpcBinding = {
  sessionId: "app-session-1",
  sessionGeneration: 1,
  connectionEpoch: 1,
  browserChannelGeneration: 1,
};
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");
const CAPTURE_IMAGE: BrowserCaptureImage = {
  mimeType: "image/jpeg",
  bytes: IMAGE_BYTES,
};
const FIXED_TIMESTAMP = "2026-07-13T00:00:00.000Z";
const DISPLAY_STATUS = {
  signal: {
    value: "present" as const,
    observedAt: FIXED_TIMESTAMP,
    ageMs: 7,
    freshness: "fresh" as const,
    source: "cached_event" as const,
  },
  resolution: {
    value: { width: 1920, height: 1080, refreshHz: 60 },
    observedAt: FIXED_TIMESTAMP,
    ageMs: 8,
    freshness: "fresh" as const,
    source: "cached_event" as const,
  },
  fps: {
    value: 59.94,
    observedAt: FIXED_TIMESTAMP,
    ageMs: 9,
    freshness: "fresh" as const,
    source: "cached_event" as const,
  },
  qualification: "current_binding" as const,
};
const UNOBSERVED_DISPLAY_STATUS = {
  signal: {
    value: "unknown" as const,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  resolution: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  fps: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  qualification: "current_binding" as const,
};
const EDID_UNSUPPORTED = {
  status: "unsupported" as const,
  readCompleted: false as const,
  reason: "edid_read_capability_absent" as const,
  observedAt: null,
  data: null,
};
const EDID_UNAVAILABLE = {
  status: "unavailable" as const,
  readCompleted: true as const,
  reason: "successful_read_reported_no_edid" as const,
  observedAt: FIXED_TIMESTAMP,
  data: null,
};
const EDID_AVAILABLE = {
  status: "available" as const,
  readCompleted: true as const,
  reason: null,
  observedAt: FIXED_TIMESTAMP,
  data: {
    sha256: "a".repeat(64),
    manufacturerId: "ABC",
    productCode: 42,
    serialNumber: "serial-redacted",
    displayName: "Display",
    preferredResolution: { width: 1920, height: 1080, refreshHz: 60 },
  },
};

type HandlerEnvironment = Readonly<{
  adapter: FakeDeviceRpcAdapter;
  browser: FakeBrowserPlane;
  native: FakeNativeControlPlane;
  sessions: DeviceSessionClient;
  ledger: RecordingRequestLedger;
  clock: HandlerClock;
  handlers: Readonly<Partial<Record<JetKvmToolName, JetKvmToolHandler>>>;
  ref: SessionRef;
  principal: string;
}> & {
  nextOperation: number;
};

function connectionResult(
  ref: SessionRef,
  binding: DeviceRpcBinding = BASE_BINDING,
  displayGeneration = 1,
): object {
  return {
    state: "ready",
    ref,
    binding,
    connectionEpoch: binding.connectionEpoch,
    browserChannelGeneration: binding.browserChannelGeneration,
    displayGeneration,
  };
}

function observationResult(
  ref: SessionRef,
  observationId: string,
  binding: DeviceRpcBinding = BASE_BINDING,
  displayGeneration = 1,
): object {
  return {
    observationId,
    sessionId: ref.sessionId,
    sessionGeneration: ref.sessionGeneration,
    connectionEpoch: binding.connectionEpoch,
    displayGeneration,
    frameId: `frame-${observationId}`,
    capturedAt: FIXED_TIMESTAMP,
    monotonicAgeMs: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    imageWidth: 1280,
    imageHeight: 720,
    rotation: 0,
    geometry: {
      contentX: 0,
      contentY: 0,
      contentWidth: 1280,
      contentHeight: 720,
    },
    format: "jpeg",
    sha256: IMAGE_SHA256,
    byteLength: IMAGE_BYTES.byteLength,
  };
}

function mutationReceipt(requestId: string, count: number): MutationReceipt {
  return {
    requestId,
    outcome: "applied",
    verification: "device_ack_only",
    dispatchedCount: count,
    completedCount: count,
    acknowledgedAt: FIXED_TIMESTAMP,
  };
}

function pasteReceipt(requestId: string, text: string): object {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const normalized = withoutBom
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
  return {
    ...mutationReceipt(requestId, Buffer.byteLength(normalized, "utf8")),
    originalByteCount: Buffer.byteLength(text, "utf8"),
    normalizedByteCount: Buffer.byteLength(normalized, "utf8"),
    normalizedSha256: createHash("sha256")
      .update(normalized, "utf8")
      .digest("hex"),
    acceptedAt: FIXED_TIMESTAMP,
    completedAt: "2026-07-13T00:00:01.000Z",
    terminalState: "succeeded",
    measuredCharsPerSecond: 91,
  };
}

function releaseReceipt(requestId: string): object {
  return {
    ...mutationReceipt(requestId, 1),
    verification: "device_state_verified",
    mutationGateClosed: true,
    deferredProducersJoined: true,
    pasteTerminal: "inactive",
    ordinaryLeasesZero: true,
    keyboardZero: true,
    pointerZero: true,
    generationDrained: true,
    heldKeys: [],
  };
}

function capabilitiesWith(
  overrides: Partial<Record<CapabilityName, boolean>> = {},
): CapabilitySnapshot {
  return { ...ALL_CAPABILITIES, ...overrides };
}

async function createEnvironment(
  options: {
    permissions?: readonly PermissionName[];
    capabilities?: CapabilitySnapshot;
    clock?: HandlerClock;
  } = {},
): Promise<HandlerEnvironment> {
  const adapter = new FakeDeviceRpcAdapter(BASE_BINDING);
  const clock = options.clock ?? new HandlerClock();
  const browser = new FakeBrowserPlane(adapter, clock, CAPTURE_IMAGE);
  const native = new FakeNativeControlPlane(adapter);
  const ledger = new RecordingRequestLedger({
    ttlMs: 60_000,
    maxEntries: 200,
    now: () => 1,
  });
  const sessions = new DeviceSessionClient({
    browser,
    configuredDevice: "configured-device-a",
    requestLedger: ledger,
    createSessionId: () => BASE_BINDING.sessionId,
    permissionsForPrincipal: () => options.permissions ?? ALL_PERMISSIONS,
    capabilitiesForConnection: async () =>
      options.capabilities ?? ALL_CAPABILITIES,
  });
  const ref: SessionRef = {
    sessionId: BASE_BINDING.sessionId,
    sessionGeneration: BASE_BINDING.sessionGeneration,
  };
  browser.loadScenario({
    version: 1,
    steps: [{ operation: "connect", result: connectionResult(ref) }],
  });
  await sessions.connect("principal-a", {
    request_id: "connect-request",
    takeover: false,
    timeout_ms: 5_000,
  });
  const handlers = {
    ...createDisplayHandlers({ browser, native, sessions, clock }),
    ...createInputHandlers({ browser, sessions, requestLedger: ledger, clock }),
  };
  return {
    adapter,
    browser,
    native,
    sessions,
    ledger,
    clock,
    handlers,
    ref,
    principal: "principal-a",
    nextOperation: 1,
  };
}

function contextFor(
  environment: HandlerEnvironment,
  signal = new AbortController().signal,
): JetKvmHandlerContext {
  return {
    signal,
    principalId: environment.principal,
    correlationId: `operation-${environment.nextOperation++}`,
  };
}

function handlerFor(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
): JetKvmToolHandler {
  const handler = environment.handlers[tool];
  if (handler === undefined) throw new Error(`Missing handler ${tool}`);
  return handler;
}

async function invoke(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
  input: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await handlerFor(environment, tool)(
    input,
    contextFor(environment, signal),
  );
  expect(result.structuredContent).toBeTypeOf("object");
  expect(result.structuredContent).not.toBeNull();
  if (activeTraceIdentity !== undefined) {
    activeTraceCalls.push(
      normalizeControlledTraceValue({
        tool,
        request: input,
        response: result.structuredContent,
      }),
    );
  }
  return result.structuredContent as Record<string, unknown>;
}

function validInput(
  tool: JetKvmToolName,
  ref: SessionRef,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const session = {
    session_id: ref.sessionId,
    session_generation: ref.sessionGeneration,
  };
  switch (tool) {
    case "jetkvm_display_capture":
      return { ...session, timeout_ms: 5_000, ...overrides };
    case "jetkvm_display_status":
      return { ...session, timeout_ms: 5_000, ...overrides };
    case "jetkvm_input_mouse":
      return {
        ...session,
        observation_id: "observation-initial",
        request_id: "mouse-request",
        actions: [
          { type: "move", x: 100, y: 100 },
          { type: "click", x: 100, y: 100, button: "left" },
        ],
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_keyboard":
      return {
        ...session,
        observation_id: "observation-initial",
        request_id: "keyboard-request",
        actions: [
          { type: "key_press", key: "KeyA" },
          { type: "chord", keys: ["ControlLeft", "KeyC"] },
        ],
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_paste":
      return {
        ...session,
        observation_id: "observation-initial",
        request_id: "paste-request",
        text: "AB",
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_release":
      return {
        ...session,
        request_id: "release-request",
        timeout_ms: 5_000,
        ...overrides,
      };
    default:
      throw new Error(`Unsupported Phase 3 handler ${tool}`);
  }
}

function targetOperation(tool: JetKvmToolName): PlaneOperation {
  switch (tool) {
    case "jetkvm_display_capture":
      return "capture";
    case "jetkvm_display_status":
      return "displayStatus";
    case "jetkvm_input_mouse":
      return "mouse";
    case "jetkvm_input_keyboard":
      return "keyboard";
    case "jetkvm_input_paste":
      return "paste";
    case "jetkvm_input_release":
      return "release";
    default:
      throw new Error(`Unsupported Phase 3 handler ${tool}`);
  }
}

function targetEvents(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
): readonly unknown[] {
  return tool === "jetkvm_display_status"
    ? environment.native.events()
    : environment.browser.events();
}

function targetLedgerEntries(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
): readonly unknown[] {
  return environment.ledger
    .snapshot()
    .entries.filter((entry) => entry.key.tool === tool);
}

function permissionFor(tool: JetKvmToolName): PermissionName {
  const permissions: Record<string, PermissionName> = {
    jetkvm_display_capture: "display.capture",
    jetkvm_display_status: "display.status",
    jetkvm_input_keyboard: "input.keyboard",
    jetkvm_input_mouse: "input.mouse",
    jetkvm_input_paste: "input.paste",
    jetkvm_input_release: "input.release",
  };
  const permission = permissions[tool];
  if (permission === undefined) throw new Error(`No permission for ${tool}`);
  return permission;
}

function missingCapabilityFor(tool: JetKvmToolName): CapabilityName {
  const capabilities: Record<string, CapabilityName> = {
    jetkvm_display_capture: "display_capture",
    jetkvm_display_status: "display_status",
    jetkvm_input_keyboard: "keyboard",
    jetkvm_input_mouse: "mouse",
    jetkvm_input_paste: "reliable_paste",
    jetkvm_input_release: "input_release",
  };
  const capability = capabilities[tool];
  if (capability === undefined) throw new Error(`No capability for ${tool}`);
  return capability;
}

async function publishObservation(
  environment: HandlerEnvironment,
  observationId = "observation-initial",
): Promise<void> {
  environment.browser.loadScenario({
    version: 1,
    steps: [
      {
        operation: "capture",
        result: observationResult(environment.ref, observationId),
      },
    ],
  });
  const envelope = await invoke(
    environment,
    "jetkvm_display_capture",
    validInput("jetkvm_display_capture", environment.ref),
  );
  expect(envelope).toMatchObject({ ok: true });
  expect(
    environment.sessions.resolveSession(environment.principal, environment.ref)
      .freshCaptureRequired,
  ).toBe(false);
}

function scenarioStepForSuccess(
  tool: JetKvmToolName,
  input: Record<string, unknown>,
): PlaneScenarioStep {
  const requestId = input.request_id as string;
  switch (tool) {
    case "jetkvm_input_mouse":
      return {
        operation: "mouse",
        result: mutationReceipt(requestId, (input.actions as unknown[]).length),
      };
    case "jetkvm_input_keyboard":
      return {
        operation: "keyboard",
        result: {
          ...mutationReceipt(requestId, (input.actions as unknown[]).length),
          heldKeys: [],
        },
      };
    case "jetkvm_input_paste":
      return {
        operation: "paste",
        result: pasteReceipt(requestId, input.text as string),
      };
    case "jetkvm_input_release":
      return { operation: "release", result: releaseReceipt(requestId) };
    default:
      throw new Error(`No mutation success step for ${tool}`);
  }
}

async function invokeSuccessfulMutation(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
  input = validInput(tool, environment.ref),
): Promise<Record<string, unknown>> {
  const steps: PlaneScenarioStep[] = [scenarioStepForSuccess(tool, input)];
  if (tool !== "jetkvm_input_release") {
    steps.push({
      operation: "capture",
      result: observationResult(environment.ref, "observation-post"),
    });
  }
  environment.browser.loadScenario({ version: 1, steps });
  return invoke(environment, tool, input);
}

function faultCounts(
  tool: JetKvmToolName,
  fault: PlaneFault,
  input: Record<string, unknown>,
): Pick<
  PlaneScenarioStep,
  "dispatchedCount" | "completedCount" | "requestedCount" | "failedIndex"
> {
  const writeBegan =
    fault === "disconnect_after_write_before_ack" ||
    fault === "malformed_response" ||
    fault === "partial_multi_event" ||
    fault === "partial_verification" ||
    fault === "disconnect_after_ack_before_post_read" ||
    fault === "cleanup_failure" ||
    fault === "event_gap";
  if (!writeBegan) return {};
  const requested =
    tool === "jetkvm_input_paste"
      ? Buffer.byteLength(input.text as string, "utf8")
      : tool === "jetkvm_input_keyboard" || tool === "jetkvm_input_mouse"
        ? (input.actions as unknown[]).length
        : 1;
  if (fault === "partial_multi_event") {
    return {
      dispatchedCount: 1,
      completedCount: 0,
      requestedCount: requested,
      failedIndex: 0,
    };
  }
  if (
    fault === "partial_verification" ||
    fault === "disconnect_after_ack_before_post_read"
  ) {
    return { dispatchedCount: requested, completedCount: requested };
  }
  return { dispatchedCount: 1, completedCount: 0 };
}

async function invokeFault(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
  fault: PlaneFault,
  input = validInput(tool, environment.ref),
): Promise<Record<string, unknown>> {
  const step: PlaneScenarioStep = {
    operation: targetOperation(tool),
    fault,
    ...faultCounts(tool, fault, input),
  };
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [step] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [step] });
  }
  return invoke(environment, tool, input);
}

async function environmentReadyForTool(
  tool: JetKvmToolName,
  options: Parameters<typeof createEnvironment>[0] = {},
): Promise<HandlerEnvironment> {
  const environment = await createEnvironment(options);
  if (
    tool === "jetkvm_input_keyboard" ||
    tool === "jetkvm_input_mouse" ||
    tool === "jetkvm_input_paste"
  ) {
    await publishObservation(environment);
  }
  return environment;
}

function expectError(
  envelope: Record<string, unknown>,
  code: string,
): Record<string, unknown> {
  expect(envelope).toMatchObject({ ok: false, error: { code } });
  return envelope.error as Record<string, unknown>;
}

async function runStrictSchema(tool: JetKvmToolName): Promise<void> {
  const environment = await createEnvironment();
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  const error = expectError(
    await invoke(environment, tool, {}),
    "CONFIG_INVALID",
  );
  expect(error).toMatchObject({ phase: "validate" });
  expect(targetEvents(environment, tool)).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runPermissionDenied(tool: JetKvmToolName): Promise<void> {
  const required = permissionFor(tool);
  const environment = await createEnvironment({
    permissions: ALL_PERMISSIONS.filter(
      (permission) => permission !== required,
    ),
  });
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  const error = expectError(
    await invoke(environment, tool, validInput(tool, environment.ref)),
    "PERMISSION_DENIED",
  );
  expect(error).toMatchObject({
    phase: "authorize",
    details: { permission: required, capability: null },
  });
  expect(targetEvents(environment, tool)).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runCapabilityMissing(tool: JetKvmToolName): Promise<void> {
  const capability = missingCapabilityFor(tool);
  const environment = await createEnvironment({
    capabilities: capabilitiesWith({ [capability]: false }),
  });
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  const error = expectError(
    await invoke(environment, tool, validInput(tool, environment.ref)),
    "CAPABILITY_MISSING",
  );
  expect(error).toMatchObject({
    phase: "validate",
    details: { permission: null, capability },
  });
  expect(targetEvents(environment, tool)).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runDeadlineBeforeAdmission(tool: JetKvmToolName): Promise<void> {
  const clock = new HandlerClock();
  const environment = await environmentReadyForTool(tool, { clock });
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  clock.sequence = [0, 5_001, 5_001, 5_001];
  const error = expectError(
    await invoke(environment, tool, validInput(tool, environment.ref)),
    "DEADLINE_EXCEEDED",
  );
  expect(error).toMatchObject({ safe_to_retry: true });
  expect(targetEvents(environment, tool)).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runCancellationBeforeWrite(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const error = expectError(
    await invoke(
      environment,
      tool,
      validInput(tool, environment.ref),
      controller.signal,
    ),
    "CANCELLED",
  );
  expect(error).toMatchObject({ safe_to_retry: true });
  expect(targetEvents(environment, tool)).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runDisconnectBeforeWrite(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const error = expectError(
    await invokeFault(environment, tool, "disconnect_before_write"),
    "CONNECTION_LOST",
  );
  expect(error).toMatchObject({ safe_to_retry: true });
  expect(targetEvents(environment, tool)).toHaveLength(1);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runDisconnectAfterWrite(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const input = validInput(tool, environment.ref);
  const error = expectError(
    await invokeFault(
      environment,
      tool,
      "disconnect_after_write_before_ack",
      input,
    ),
    "CONNECTION_LOST",
  );
  if (tool.startsWith("jetkvm_input_")) {
    expect(error).toMatchObject({ outcome: "unknown", safe_to_retry: false });
    expect(targetLedgerEntries(environment, tool)).toMatchObject([
      { state: "terminal", terminalOutcome: "unknown" },
    ]);
    const eventsBeforeRetry = targetEvents(environment, tool).length;
    const retry = expectError(
      await invoke(environment, tool, input),
      "MUTATION_OUTCOME_UNKNOWN",
    );
    expect(retry).toMatchObject({ outcome: "unknown" });
    expect(targetEvents(environment, tool)).toHaveLength(eventsBeforeRetry);
  } else {
    expect(error).toMatchObject({ outcome: null });
  }
}

async function runMalformedDownstream(tool: JetKvmToolName): Promise<void> {
  const before = await environmentReadyForTool(tool);
  const beforeError = expectError(
    await invokeFault(before, tool, "malformed_response_before_write"),
    "DOWNSTREAM_MALFORMED_RESPONSE",
  );
  expect(beforeError).toMatchObject({
    outcome: tool.startsWith("jetkvm_input_") ? "not_sent" : null,
  });
  expect(targetLedgerEntries(before, tool)).toHaveLength(0);

  const after = await environmentReadyForTool(tool);
  const input = validInput(tool, after.ref);
  const afterError = expectError(
    await invokeFault(after, tool, "malformed_response", input),
    "DOWNSTREAM_MALFORMED_RESPONSE",
  );
  if (tool.startsWith("jetkvm_input_")) {
    expect(afterError).toMatchObject({ outcome: "unknown" });
    expect(targetLedgerEntries(after, tool)).toMatchObject([
      { state: "terminal", terminalOutcome: "unknown" },
    ]);
  } else {
    expect(afterError).toMatchObject({ outcome: null });
  }
}

async function runStaleGeneration(tool: JetKvmToolName): Promise<void> {
  const environment = await createEnvironment();
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({ version: 1, steps: [] });
  } else {
    environment.browser.loadScenario({ version: 1, steps: [] });
  }
  const error = expectError(
    await invoke(
      environment,
      tool,
      validInput(tool, {
        ...environment.ref,
        sessionGeneration: environment.ref.sessionGeneration + 1,
      }),
    ),
    "STALE_SESSION_GENERATION",
  );
  expect(error).toMatchObject({
    details: {
      expected_generation: environment.ref.sessionGeneration + 1,
      actual_generation: null,
    },
  });
  expect(targetEvents(environment, tool)).toHaveLength(0);
}

async function runDefinitiveAcknowledgement(
  tool: JetKvmToolName,
): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const envelope = await invokeSuccessfulMutation(environment, tool);
  expect(envelope).toMatchObject({
    ok: true,
    result: {
      outcome: "applied",
      verification:
        tool === "jetkvm_input_release"
          ? "device_state_verified"
          : "device_ack_only",
    },
  });
  expect(targetLedgerEntries(environment, tool)).toMatchObject([
    { state: "terminal", terminalOutcome: "applied" },
  ]);
  expect(environment.ledger.recorded.at(-1)).toMatchObject({
    terminal: { outcome: "applied" },
    persistedBeforeResponse: true,
  });
  const recordedJson = JSON.stringify(environment.ledger.recorded.at(-1));
  expect(recordedJson).not.toContain(
    Buffer.from(IMAGE_BYTES).toString("base64"),
  );
  expect(recordedJson).not.toContain("bytes");
  if (tool !== "jetkvm_input_release") {
    expect(recordedJson).toContain('"post_capture":null');
  }
}

async function runDuplicateSame(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const input = validInput(tool, environment.ref);
  await invokeSuccessfulMutation(environment, tool, input);
  const eventCount = targetEvents(environment, tool).length;
  const replay = await invoke(environment, tool, input);
  expect(replay).toMatchObject({
    ok: true,
    result: {
      outcome: "already_applied",
      ...(tool === "jetkvm_input_release" ? {} : { post_capture: null }),
    },
  });
  expect(targetEvents(environment, tool)).toHaveLength(eventCount);
}

async function runDuplicateChanged(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const original = validInput(tool, environment.ref);
  await invokeSuccessfulMutation(environment, tool, original);
  const eventCount = targetEvents(environment, tool).length;
  const changed = {
    ...original,
    timeout_ms: (original.timeout_ms as number) + 1,
  };
  const error = expectError(
    await invoke(environment, tool, changed),
    "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
  );
  expect(error).toMatchObject({ outcome: "not_sent" });
  expect(targetEvents(environment, tool)).toHaveLength(eventCount);
}

async function runPartialVerification(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const input = validInput(tool, environment.ref);
  const error = expectError(
    await invokeFault(
      environment,
      tool,
      "disconnect_after_ack_before_post_read",
      input,
    ),
    "PARTIAL_VERIFICATION",
  );
  expect(error).toMatchObject({
    phase: "verify",
    outcome: "applied",
    verification: "device_ack_only",
  });
  expect(targetLedgerEntries(environment, tool)).toMatchObject([
    { state: "terminal", terminalOutcome: "applied" },
  ]);
  expect(environment.ledger.recorded.at(-1)).toMatchObject({
    terminal: { outcome: "applied" },
    persistedBeforeResponse: true,
  });
  const eventCount = targetEvents(environment, tool).length;
  const replay = expectError(
    await invoke(environment, tool, input),
    "PARTIAL_VERIFICATION",
  );
  expect(replay).toMatchObject({ outcome: "already_applied" });
  expect(targetEvents(environment, tool)).toHaveLength(eventCount);
}

async function runPartialDispatch(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const input = validInput(tool, environment.ref);
  const error = expectError(
    await invokeFault(environment, tool, "partial_multi_event", input),
    "MUTATION_OUTCOME_UNKNOWN",
  );
  expect(error).toMatchObject({
    outcome: "unknown",
    details: {
      failed_action_index: 0,
      dispatched_action_count: 1,
      completed_action_count: 0,
    },
  });
  const eventCount = targetEvents(environment, tool).length;
  expectError(
    await invoke(environment, tool, input),
    "MUTATION_OUTCOME_UNKNOWN",
  );
  expect(targetEvents(environment, tool)).toHaveLength(eventCount);
}

async function runPostReconnectWithoutCapture(
  tool: JetKvmToolName,
): Promise<void> {
  const environment = await createEnvironment();
  expect(
    environment.sessions.resolveSession(environment.principal, environment.ref)
      .freshCaptureRequired,
  ).toBe(true);
  environment.browser.loadScenario({ version: 1, steps: [] });
  const error = expectError(
    await invoke(
      environment,
      tool,
      validInput(tool, environment.ref, {
        observation_id: "observation-after-reconnect",
      }),
    ),
    "STALE_OBSERVATION",
  );
  expect(error).toMatchObject({
    outcome: "not_sent",
    required_next_step: "capture_then_retry",
  });
  expect(environment.browser.events()).toHaveLength(0);
  expect(targetLedgerEntries(environment, tool)).toHaveLength(0);
}

async function runCleanupFailure(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const error = expectError(
    await invokeFault(environment, tool, "cleanup_failure"),
    tool === "jetkvm_display_capture"
      ? "DOWNSTREAM_MALFORMED_RESPONSE"
      : "MUTATION_OUTCOME_UNKNOWN",
  );
  expect(error).toMatchObject({ phase: "cleanup" });
  expect(error).not.toMatchObject({ verification: "device_state_verified" });
  if (tool.startsWith("jetkvm_input_")) {
    expect(targetLedgerEntries(environment, tool)).toMatchObject([
      { state: "terminal", terminalOutcome: "unknown" },
    ]);
  }
}

async function runPerFactStatus(): Promise<void> {
  const environment = await createEnvironment();
  environment.native.loadScenario({
    version: 1,
    steps: [
      {
        operation: "displayStatus",
        result: { ...UNOBSERVED_DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
      },
      {
        operation: "displayStatus",
        result: { ...DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
      },
    ],
  });
  const first = await invoke(
    environment,
    "jetkvm_display_status",
    validInput("jetkvm_display_status", environment.ref),
  );
  expect(first).toMatchObject({
    ok: true,
    result: {
      signal: { value: "unknown", source: "none", freshness: "unknown" },
      native_resolution: { value: null, source: "none" },
      fps: { value: null, source: "none" },
    },
  });
  expect(JSON.stringify(first)).not.toContain("cached_snapshot");
  expect(JSON.stringify(first)).not.toMatch(/streaming/i);
  const second = await invoke(
    environment,
    "jetkvm_display_status",
    validInput("jetkvm_display_status", environment.ref),
  );
  expect(second).toMatchObject({
    ok: true,
    result: {
      signal: {
        value: "present",
        source: "cached_event",
        observed_at: FIXED_TIMESTAMP,
        age_ms: 7,
      },
      native_resolution: { source: "cached_event", age_ms: 8 },
      fps: { source: "cached_event", age_ms: 9 },
    },
  });
}

async function runEdidCapabilityAbsent(): Promise<void> {
  const environment = await createEnvironment({
    capabilities: capabilitiesWith({ edid_read: false }),
  });
  environment.native.loadScenario({
    version: 1,
    steps: [
      {
        operation: "displayStatus",
        result: { ...DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
      },
    ],
  });
  const envelope = await invoke(
    environment,
    "jetkvm_display_status",
    validInput("jetkvm_display_status", environment.ref),
  );
  expect(envelope).toMatchObject({
    ok: true,
    result: {
      edid: {
        status: "unsupported",
        read_completed: false,
        reason: "edid_read_capability_absent",
        observed_at: null,
        data: null,
      },
    },
  });
  expect(environment.native.events()).toHaveLength(1);
  expect(environment.native.events()[0]?.metadata).toMatchObject({
    request: { edidReadSupported: false },
  });
}

async function runEdidSuccessfulEmpty(): Promise<void> {
  const environment = await createEnvironment();
  environment.native.loadScenario({
    version: 1,
    steps: [
      {
        operation: "displayStatus",
        result: { ...DISPLAY_STATUS, edid: EDID_UNAVAILABLE },
      },
    ],
  });
  const envelope = await invoke(
    environment,
    "jetkvm_display_status",
    validInput("jetkvm_display_status", environment.ref),
  );
  expect(envelope).toMatchObject({
    ok: true,
    result: {
      edid: {
        status: "unavailable",
        read_completed: true,
        reason: "successful_read_reported_no_edid",
        observed_at: FIXED_TIMESTAMP,
        data: null,
      },
    },
  });
}

async function runEdidFailure(): Promise<void> {
  const environment = await createEnvironment();
  environment.native.displayStatus = async () => {
    throw new DeviceRpcError("EDID_READ_FAILED", "ack", "unknown", true, false);
  };
  const error = expectError(
    await invoke(
      environment,
      "jetkvm_display_status",
      validInput("jetkvm_display_status", environment.ref),
    ),
    "EDID_READ_FAILED",
  );
  expect(error).toMatchObject({ phase: "verify", outcome: null });
  expect(JSON.stringify(error)).not.toMatch(/unavailable|available/);
}

async function runSharedAdapter(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  expect(environment.browser.deviceRpc).toBe(environment.native.deviceRpc);
  if (tool === "jetkvm_display_status") {
    environment.native.loadScenario({
      version: 1,
      steps: [
        {
          operation: "displayStatus",
          result: { ...DISPLAY_STATUS, edid: EDID_AVAILABLE },
        },
      ],
    });
    expect(
      await invoke(environment, tool, validInput(tool, environment.ref)),
    ).toMatchObject({ ok: true });
  } else if (tool === "jetkvm_display_capture") {
    environment.browser.loadScenario({
      version: 1,
      steps: [
        {
          operation: "capture",
          result: observationResult(environment.ref, "observation-shared"),
        },
      ],
    });
    expect(
      await invoke(environment, tool, validInput(tool, environment.ref)),
    ).toMatchObject({ ok: true });
  } else {
    expect(await invokeSuccessfulMutation(environment, tool)).toMatchObject({
      ok: true,
    });
  }
}

async function runAdapterReplacement(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  environment.adapter.replaceBinding({
    ...BASE_BINDING,
    sessionGeneration: BASE_BINDING.sessionGeneration + 1,
    connectionEpoch: BASE_BINDING.connectionEpoch + 1,
    browserChannelGeneration: BASE_BINDING.browserChannelGeneration + 1,
  });
  const replacementFailure = () =>
    new DeviceRpcError(
      "BINDING_REPLACED",
      "admission",
      "not_sent",
      false,
      false,
    );
  switch (tool) {
    case "jetkvm_display_status":
      environment.native.displayStatus = async () => {
        throw replacementFailure();
      };
      environment.native.loadScenario({ version: 1, steps: [] });
      break;
    case "jetkvm_display_capture":
      environment.browser.capture = async () => {
        throw replacementFailure();
      };
      environment.browser.loadScenario({ version: 1, steps: [] });
      break;
    case "jetkvm_input_keyboard":
      environment.browser.keyboard = async () => {
        throw replacementFailure();
      };
      environment.browser.loadScenario({ version: 1, steps: [] });
      break;
    case "jetkvm_input_mouse":
      environment.browser.mouse = async () => {
        throw replacementFailure();
      };
      environment.browser.loadScenario({ version: 1, steps: [] });
      break;
    case "jetkvm_input_paste":
      environment.browser.paste = async () => {
        throw replacementFailure();
      };
      environment.browser.loadScenario({ version: 1, steps: [] });
      break;
    case "jetkvm_input_release":
      environment.browser.release = async () => {
        throw replacementFailure();
      };
      environment.browser.loadScenario({ version: 1, steps: [] });
      break;
    default:
      throw new Error(`Unsupported replacement handler ${tool}`);
  }
  const error = expectError(
    await invoke(environment, tool, validInput(tool, environment.ref)),
    "CONNECTION_LOST",
  );
  expect(error).toMatchObject({
    outcome: tool.startsWith("jetkvm_input_") ? "not_sent" : null,
  });
  expect(targetEvents(environment, tool)).toHaveLength(0);
}

async function runAdapterMidFlightLoss(tool: JetKvmToolName): Promise<void> {
  const environment = await environmentReadyForTool(tool);
  const error = expectError(
    await invokeFault(environment, tool, "disconnect_after_write_before_ack"),
    "CONNECTION_LOST",
  );
  expect(error).toMatchObject({
    outcome: tool.startsWith("jetkvm_input_") ? "unknown" : null,
  });
  if (tool.startsWith("jetkvm_input_")) {
    expect(targetLedgerEntries(environment, tool)).toMatchObject([
      { state: "terminal", terminalOutcome: "unknown" },
    ]);
  }
}

async function runScrollValidation(): Promise<void> {
  const environment = await createEnvironment();
  environment.browser.loadScenario({ version: 1, steps: [] });
  for (const action of [
    { type: "scroll", x: 1, y: 1, delta_y: 0 },
    { type: "scroll", x: 1, y: 1, delta_y: 0.5 },
    { type: "scroll", x: 1, y: 1, delta_y: 128 },
    { type: "scroll", x: 1, y: 1, delta_y: -128 },
    { type: "scroll", x: 1, y: 1, delta_y: 1, delta_x: 1 },
  ]) {
    expectError(
      await invoke(
        environment,
        "jetkvm_input_mouse",
        validInput("jetkvm_input_mouse", environment.ref, {
          actions: [action],
        }),
      ),
      "CONFIG_INVALID",
    );
  }
  expect(environment.browser.events()).toHaveLength(0);
  expect(targetLedgerEntries(environment, "jetkvm_input_mouse")).toHaveLength(
    0,
  );

  await publishObservation(environment);
  for (const [index, deltaY] of [-127, 127].entries()) {
    const observationId =
      index === 0 ? "observation-initial" : "observation-scroll-next";
    const input = validInput("jetkvm_input_mouse", environment.ref, {
      observation_id: observationId,
      request_id: `scroll-request-${index}`,
      actions: [{ type: "scroll", x: 1, y: 1, delta_y: deltaY }],
    });
    environment.browser.loadScenario({
      version: 1,
      steps: [
        scenarioStepForSuccess("jetkvm_input_mouse", input),
        {
          operation: "capture",
          result: observationResult(
            environment.ref,
            index === 0 ? "observation-scroll-next" : "observation-scroll-last",
          ),
        },
      ],
    });
    expect(
      await invoke(environment, "jetkvm_input_mouse", input),
    ).toMatchObject({ ok: true });
  }
}

const RUNNERS: Readonly<
  Record<string, (tool: JetKvmToolName) => void | Promise<void>>
> = {
  "branch:strict-schema-rejection": runStrictSchema,
  "branch:permission-denied": runPermissionDenied,
  "branch:capability-missing": runCapabilityMissing,
  "branch:deadline-before-admission": runDeadlineBeforeAdmission,
  "branch:cancellation-before-write": runCancellationBeforeWrite,
  "branch:disconnect-before-write": runDisconnectBeforeWrite,
  "branch:disconnect-after-write": runDisconnectAfterWrite,
  "branch:malformed-downstream-response": runMalformedDownstream,
  "branch:stale-session-generation": runStaleGeneration,
  "branch:definitive-acknowledgement": runDefinitiveAcknowledgement,
  "branch:duplicate-same-request-digest": runDuplicateSame,
  "branch:duplicate-changed-digest": runDuplicateChanged,
  "branch:partial-verification": runPartialVerification,
  "branch:partial-multi-event-dispatch": runPartialDispatch,
  "branch:post-reconnect-input-without-capture": runPostReconnectWithoutCapture,
  "branch:cleanup-failure": runCleanupFailure,
  "branch:per-fact-status-provenance": () => runPerFactStatus(),
  "branch:edid-capability-absent": () => runEdidCapabilityAbsent(),
  "branch:edid-successful-empty": () => runEdidSuccessfulEmpty(),
  "branch:edid-lower-layer-failure": () => runEdidFailure(),
  "branch:shared-device-rpc-adapter-binding": runSharedAdapter,
  "branch:device-rpc-adapter-replacement": runAdapterReplacement,
  "branch:device-rpc-adapter-mid-flight-loss": runAdapterMidFlightLoss,
  "branch:scroll-validation": () => runScrollValidation(),
};

describe(SUITE_IDENTITY, () => {
  for (const cell of PHASE_3_FOCUSED_CELLS) {
    const runner = RUNNERS[cell.requirement];
    if (runner === undefined) {
      throw new Error(
        `No real handler assertion runner for ${cell.requirement}`,
      );
    }
    focusedAssertionTest(cell, () => runner(cell.tool));
  }

  afterAll(async () => {
    validateFocusedAssertionExecutions(
      "phase_3",
      PHASE_3_HANDLER_FOCUSED_RESULTS,
    );
    await verifyControlledTraceReport();
  });
});

describe("Phase 3 handler orchestration invariants", () => {
  it("persists acknowledged mutation before returning a post-capture failure and never replays", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_mouse");
    const input = validInput("jetkvm_input_mouse", environment.ref);
    environment.browser.loadScenario({
      version: 1,
      steps: [
        scenarioStepForSuccess("jetkvm_input_mouse", input),
        { operation: "capture", fault: "disconnect_before_write" },
      ],
    });

    const error = expectError(
      await invoke(environment, "jetkvm_input_mouse", input),
      "PARTIAL_VERIFICATION",
    );
    expect(error).toMatchObject({
      outcome: "applied",
      verification: "device_ack_only",
      details: {
        failed_action_index: null,
        dispatched_action_count: 2,
        completed_action_count: 2,
        downstream_stage: "verification",
      },
    });
    expect(environment.ledger.recorded.at(-1)).toMatchObject({
      terminal: {
        outcome: "applied",
        verification: "device_ack_only",
        value: { kind: "error" },
      },
      persistedBeforeResponse: true,
    });
    const eventCount = environment.browser.events().length;
    const replay = expectError(
      await invoke(environment, "jetkvm_input_mouse", input),
      "PARTIAL_VERIFICATION",
    );
    expect(replay).toMatchObject({ outcome: "already_applied" });
    expect(environment.browser.events()).toHaveLength(eventCount);
  });

  it("persists no paste text, image bytes, or base64 in a definitive terminal", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_paste");
    const privateText = "\uFEFFPRIVATE-PHASE3\r\né";
    const input = validInput("jetkvm_input_paste", environment.ref, {
      text: privateText,
    });
    await invokeSuccessfulMutation(environment, "jetkvm_input_paste", input);

    const recorded = JSON.stringify(environment.ledger.recorded.at(-1));
    expect(recorded).not.toContain(privateText);
    expect(recorded).not.toContain("PRIVATE-PHASE3");
    expect(recorded).not.toContain(Buffer.from(IMAGE_BYTES).toString("base64"));
    expect(recorded).not.toContain('"bytes"');
    expect(recorded).toContain('"post_capture":null');
    expect(JSON.stringify(environment.ledger.snapshot())).not.toContain(
      "PRIVATE-PHASE3",
    );
  });

  it("releases a consumed observation reservation only for a definitive pre-write rejection", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_mouse");
    const first = validInput("jetkvm_input_mouse", environment.ref);
    await invokeSuccessfulMutation(environment, "jetkvm_input_mouse", first);
    environment.browser.mouse = async (_ref, request) => {
      throw new BrowserPlaneError({
        code: "OBSERVATION_CONSUMED",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: request.actions.length,
        safeToRetry: true,
        requiredNextStep: "capture_then_retry",
        suffixSuppressed: false,
      });
    };
    environment.browser.loadScenario({ version: 1, steps: [] });
    const second = validInput("jetkvm_input_mouse", environment.ref, {
      request_id: "mouse-request-consumed",
    });

    const error = expectError(
      await invoke(environment, "jetkvm_input_mouse", second),
      "OBSERVATION_CONSUMED",
    );
    expect(error).toMatchObject({
      outcome: "not_sent",
      required_next_step: "capture_then_retry",
      details: { observation_id: "observation-initial" },
    });
    expect(targetLedgerEntries(environment, "jetkvm_input_mouse")).toHaveLength(
      1,
    );
    expect(environment.browser.events()).toHaveLength(0);
  });

  it("acknowledges a monotonic newer capture generation and advances the session", async () => {
    const environment = await createEnvironment();
    environment.browser.capture = async () => ({
      observation: observationResult(
        environment.ref,
        "observation-wrong-display",
        BASE_BINDING,
        2,
      ) as never,
      image: CAPTURE_IMAGE,
    });
    const result = await handlerFor(environment, "jetkvm_display_capture")(
      validInput("jetkvm_display_capture", environment.ref),
      contextFor(environment),
    );
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    expect(
      environment.sessions.resolveSession(
        environment.principal,
        environment.ref,
      ),
    ).toMatchObject({
      displayGeneration: 2,
      freshCaptureRequired: false,
    });
  });

  it("clamps a proven pre-write release failure to the public write boundary", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_release");
    environment.browser.release = async () => {
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "acknowledgement",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 1,
        safeToRetry: true,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    };

    const error = expectError(
      await invoke(
        environment,
        "jetkvm_input_release",
        validInput("jetkvm_input_release", environment.ref),
      ),
      "CONNECTION_LOST",
    );
    expect(error).toMatchObject({
      outcome: "not_sent",
      safe_to_retry: true,
      required_next_step: "reconnect_then_capture",
      details: {
        downstream_stage: "write",
        dispatched_action_count: 0,
        completed_action_count: 0,
      },
    });
    expect(
      targetLedgerEntries(environment, "jetkvm_input_release"),
    ).toHaveLength(0);
  });

  it("keeps a successfully released generation closed for later requests", async () => {
    const environment = await createEnvironment();
    await invokeSuccessfulMutation(environment, "jetkvm_input_release");
    environment.browser.loadScenario({ version: 1, steps: [] });

    const error = expectError(
      await invoke(
        environment,
        "jetkvm_input_release",
        validInput("jetkvm_input_release", environment.ref, {
          request_id: "release-request-after-close",
        }),
      ),
      "SESSION_DRAINED",
    );
    expect(error).toMatchObject({
      outcome: "not_sent",
      safe_to_retry: false,
      required_next_step: "reconnect_then_capture",
    });
    expect(environment.browser.events()).toHaveLength(0);
  });

  it("returns the authoritative atomic held-key ledger from a keyboard receipt", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_keyboard");
    const input = validInput("jetkvm_input_keyboard", environment.ref, {
      actions: [{ type: "key_down", key: "KeyA" }],
    });
    environment.browser.keyboard = async () =>
      ({
        ...mutationReceipt("keyboard-request", 1),
        heldKeys: Object.freeze(["KeyA"]),
      }) as MutationReceipt & { readonly heldKeys: readonly ["KeyA"] };
    environment.browser.loadScenario({
      version: 1,
      steps: [
        {
          operation: "capture",
          result: observationResult(environment.ref, "observation-held-key"),
        },
      ],
    });

    const envelope = await invoke(environment, "jetkvm_input_keyboard", input);
    expect(envelope).toMatchObject({
      ok: true,
      result: { held_keys: ["KeyA"] },
    });
  });

  it("fails closed as applied partial verification when an acknowledged keyboard receipt omits held keys", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_keyboard");
    environment.browser.keyboard = async () =>
      mutationReceipt("keyboard-request", 2) as MutationReceipt;
    environment.browser.capture = async () => ({
      observation: observationResult(
        environment.ref,
        "observation-missing-held-keys",
      ) as never,
      image: CAPTURE_IMAGE,
    });

    const error = expectError(
      await invoke(
        environment,
        "jetkvm_input_keyboard",
        validInput("jetkvm_input_keyboard", environment.ref),
      ),
      "PARTIAL_VERIFICATION",
    );
    expect(error).toMatchObject({
      outcome: "applied",
      verification: "device_ack_only",
      details: {
        failed_action_index: null,
        dispatched_action_count: 2,
        completed_action_count: 2,
      },
    });
    expect(environment.ledger.recorded.at(-1)).toMatchObject({
      terminal: { outcome: "applied", verification: "device_ack_only" },
      persistedBeforeResponse: true,
    });
  });

  it("preserves display-change pre/post-write outcome and closes replay after uncertainty", async () => {
    const before = await environmentReadyForTool("jetkvm_input_mouse");
    before.browser.mouse = async (_ref, request) => {
      throw new BrowserPlaneError({
        code: "DISPLAY_CHANGED",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: request.actions.length,
        safeToRetry: true,
        requiredNextStep: "capture_then_retry",
        suffixSuppressed: false,
      });
    };
    const beforeError = expectError(
      await invoke(
        before,
        "jetkvm_input_mouse",
        validInput("jetkvm_input_mouse", before.ref),
      ),
      "DISPLAY_CHANGED",
    );
    expect(beforeError).toMatchObject({
      outcome: "not_sent",
      required_next_step: "capture_then_retry",
    });
    expect(targetLedgerEntries(before, "jetkvm_input_mouse")).toHaveLength(0);

    const after = await environmentReadyForTool("jetkvm_input_mouse");
    const input = validInput("jetkvm_input_mouse", after.ref);
    after.browser.mouse = async (_ref, request) => {
      throw new BrowserPlaneError({
        code: "DISPLAY_CHANGED",
        outcome: "unknown",
        stage: "acknowledgement",
        writeBegan: true,
        acknowledged: false,
        dispatchedCount: 1,
        completedCount: 0,
        requestedCount: request.actions.length,
        failedIndex: 0,
        safeToRetry: false,
        requiredNextStep: "release_then_reconnect_then_capture",
        suffixSuppressed: true,
      });
    };
    const afterError = expectError(
      await invoke(after, "jetkvm_input_mouse", input),
      "DISPLAY_CHANGED",
    );
    expect(afterError).toMatchObject({
      outcome: "unknown",
      required_next_step: "release_then_reconnect_then_capture",
      details: {
        failed_action_index: 0,
        dispatched_action_count: 1,
        completed_action_count: 0,
      },
    });
    const writes = after.browser.events().length;
    expectError(
      await invoke(after, "jetkvm_input_mouse", input),
      "MUTATION_OUTCOME_UNKNOWN",
    );
    expect(after.browser.events()).toHaveLength(writes);
  });

  it("rejects a malformed receipt without retaining hostile extra fields", async () => {
    const environment = await environmentReadyForTool("jetkvm_input_mouse");
    environment.browser.mouse = async () =>
      ({
        ...mutationReceipt("mouse-request", 2),
        hostile_secret: "DO-NOT-RETAIN",
      }) as MutationReceipt;
    environment.browser.capture = async () => ({
      observation: observationResult(
        environment.ref,
        "observation-hostile-receipt",
      ) as never,
      image: CAPTURE_IMAGE,
    });

    const error = expectError(
      await invoke(
        environment,
        "jetkvm_input_mouse",
        validInput("jetkvm_input_mouse", environment.ref),
      ),
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );
    expect(error).toMatchObject({
      outcome: "unknown",
      safe_to_retry: false,
    });
    expect(JSON.stringify(environment.ledger.recorded)).not.toContain(
      "DO-NOT-RETAIN",
    );
  });
});
