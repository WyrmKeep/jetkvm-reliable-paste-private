import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  PERMISSION_NAMES,
  type CapabilitySnapshot,
  type JetKvmToolName,
  type PowerAction,
  type SessionStatusResult,
} from "../domain.js";
import {
  DeviceRpcError,
  type AtxWireReceipt,
  type DeviceRpcBinding,
} from "../device/DeviceRpcAdapter.js";
import { RequestLedger } from "../idempotency/RequestLedger.js";
import type { JetKvmHandlerContext, JetKvmToolHandler } from "../mcp/server.js";
import type { NativeControlPlane } from "../planes/NativeControlPlane.js";
import {
  DeviceSessionClientError,
  type DeviceSessionConnectSuccess,
  type DeviceSessionReconnectSuccess,
  type DeviceSessionSnapshot,
} from "../session/deviceSessionClient.js";
import { SessionServiceError } from "../session/SessionService.js";
import {
  TOOL_BEHAVIOR_MATRIX,
  validateFocusedAssertionExecutions,
  type FocusedAssertionExecutionResult,
} from "../stories/manifest.js";
import { FakeBrowserPlane } from "../test-support/fakes/FakeBrowserPlane.js";
import { FakeDeviceRpcAdapter } from "../test-support/fakes/FakeDeviceRpcAdapter.js";
import { FakeNativeControlPlane } from "../test-support/fakes/FakeNativeControlPlane.js";
import { normalizeControlledTraceValue } from "../test-support/controlledTrace.js";
import { createToolHandlerComposition } from "../ToolHandlers.js";
import { createPowerHandlers, type PowerSessionPort } from "./power.js";
import {
  createSessionHandlers,
  type SessionHandlerService,
} from "./session.js";

const SUITE_IDENTITY = "Phase 4 power/session focused assertion matrix";
const PHASE_4_TOOLS = [
  "jetkvm_power_control",
  "jetkvm_session_connect",
  "jetkvm_session_reconnect",
  "jetkvm_session_status",
] as const satisfies readonly JetKvmToolName[];
type Phase4Tool = (typeof PHASE_4_TOOLS)[number];
type FocusedCell = Readonly<{
  tool: Phase4Tool;
  requirement: string;
  id: string;
}>;

const PHASE_4_CELLS: readonly FocusedCell[] = TOOL_BEHAVIOR_MATRIX.flatMap(
  (row) =>
    PHASE_4_TOOLS.flatMap((tool) => {
      const cell = row.cells[tool];
      return cell.applicability === "applicable" &&
        cell.focused_assertion_owner_phase === "phase_4"
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

const RESULTS: FocusedAssertionExecutionResult[] = [];
const CONTROLLED_TRACE_PATH = resolve(
  "reports/controlled-traces/power-session.json",
);
const controlledTraces: Record<
  string,
  {
    readonly test_identity: string;
    readonly calls: readonly {
      readonly tool: string;
      readonly request: unknown;
      readonly response: unknown;
    }[];
  }
> = {};
let activeTraceIdentity: string | undefined;
let activeTraceTestIdentity: string | undefined;
let activeTraceCalls: {
  tool: string;
  request: unknown;
  response: unknown;
}[] = [];

function recordControlledExchange(
  tool: string,
  request: unknown,
  response: unknown,
): void {
  if (activeTraceIdentity === undefined) return;
  activeTraceCalls.push(
    normalizeControlledTraceValue({ tool, request, response }),
  );
}

function recordControlledCall(
  tool: JetKvmToolName,
  request: unknown,
  result: Awaited<ReturnType<JetKvmToolHandler>>,
): void {
  recordControlledExchange(tool, request, result.structuredContent);
}

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

const REF = { sessionId: "session-1", sessionGeneration: 1 } as const;
const BINDING: DeviceRpcBinding = {
  sessionId: REF.sessionId,
  sessionGeneration: REF.sessionGeneration,
  connectionEpoch: 2,
  browserChannelGeneration: 3,
};
const CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, true])),
) as CapabilitySnapshot;
const CONTEXT: JetKvmHandlerContext = {
  signal: new AbortController().signal,
  principalId: "principal-a",
  correlationId: "phase-4-operation",
};
const UNKNOWN_FACT = {
  value: null,
  observed_at: null,
  age_ms: null,
  freshness: "unknown",
  source: "none",
} as const;
const STATUS: SessionStatusResult = {
  state: "ready",
  connection_epoch: 2,
  display_generation: 4,
  dispatch_generation: 5,
  browser_channel_generation: 3,
  device_reachable: true,
  setup_state: "complete",
  auth_mode: "password",
  rpc_reachability: "reachable",
  native_process: "available",
  web_rtc: "connected",
  hid: "ready",
  decoded_video: "ready",
  native_capture_facts: {
    signal: { ...UNKNOWN_FACT, value: "unknown" },
    resolution: UNKNOWN_FACT,
    fps: UNKNOWN_FACT,
  },
  active_mutation: false,
  fresh_capture_required: true,
  permissions: [...PERMISSION_NAMES],
  capabilities: CAPABILITIES,
  blocked_reason: null,
  versions: {
    server: "0.1.0",
    protocol: "1",
    ui_contract: "1",
    firmware: null,
  },
};
const CONNECTED: DeviceSessionConnectSuccess = {
  ref: REF,
  result: {
    request_id: "connect-1",
    outcome: "applied",
    verification: "device_state_verified",
    safe_to_retry: false,
    required_next_step: "none",
    state: "ready",
    connection_epoch: 2,
    display_generation: 4,
    takeover_performed: false,
    fresh_capture_required: true,
    permissions: [...PERMISSION_NAMES],
    capabilities: CAPABILITIES,
  },
};
const RECONNECTED: DeviceSessionReconnectSuccess = {
  ref: { sessionId: REF.sessionId, sessionGeneration: 2 },
  result: {
    request_id: "reconnect-1",
    outcome: "applied",
    verification: "device_state_verified",
    safe_to_retry: false,
    required_next_step: "none",
    previous_session_generation: 1,
    new_session_generation: 2,
    connection_epoch: 3,
    state: "ready",
    takeover_performed: false,
    fresh_capture_required: true,
  },
};

function sessionInput(tool: Phase4Tool): Record<string, unknown> {
  if (tool === "jetkvm_session_connect") {
    return { request_id: "connect-1", takeover: false, timeout_ms: 1_000 };
  }
  if (tool === "jetkvm_session_reconnect") {
    return {
      session_id: REF.sessionId,
      session_generation: REF.sessionGeneration,
      request_id: "reconnect-1",
      takeover: false,
      timeout_ms: 1_000,
    };
  }
  return {
    session_id: REF.sessionId,
    session_generation: REF.sessionGeneration,
    timeout_ms: 1_000,
  };
}

function sessionHarness(overrides: Partial<SessionHandlerService> = {}) {
  let calls = 0;
  const service: SessionHandlerService = {
    connect: async () => {
      calls += 1;
      return CONNECTED;
    },
    reconnect: async () => {
      calls += 1;
      return RECONNECTED;
    },
    status: async () => {
      calls += 1;
      return STATUS;
    },
    ...overrides,
  };
  const handlers = createSessionHandlers({ service });
  return { handlers, calls: () => calls };
}

function sessionHandler(
  handlers: ReturnType<typeof createSessionHandlers>,
  tool: Phase4Tool,
): JetKvmToolHandler {
  if (tool === "jetkvm_power_control") throw new Error("Power is not session.");
  const handler = handlers[tool];
  return async (input, context) => {
    const result = await handler(input, context);
    recordControlledCall(tool, input, result);
    return result;
  };
}

function errorEnvelope(result: Awaited<ReturnType<JetKvmToolHandler>>) {
  const body = result.structuredContent as Record<string, unknown>;
  expect(body).toMatchObject({ ok: false });
  return body;
}

function deviceError(
  code: ConstructorParameters<typeof DeviceSessionClientError>[0],
  outcome: ConstructorParameters<
    typeof DeviceSessionClientError
  >[2] = "not_sent",
  safeToRetry = outcome === "not_sent",
  requiredNextStep: ConstructorParameters<
    typeof DeviceSessionClientError
  >[4] = outcome === "unknown" ? "inspect_device_state_before_retry" : "none",
) {
  return new DeviceSessionClientError(
    code,
    code,
    outcome,
    safeToRetry,
    requiredNextStep,
  );
}

async function runSessionError(
  tool: Exclude<Phase4Tool, "jetkvm_power_control">,
  error: Error,
) {
  const failing = async () => {
    throw error;
  };
  const harness = sessionHarness({
    [tool.slice("jetkvm_session_".length)]: failing,
  });
  return errorEnvelope(
    await sessionHandler(harness.handlers, tool)(sessionInput(tool), CONTEXT),
  );
}

async function runSessionCell(tool: Phase4Tool, requirement: string) {
  if (tool === "jetkvm_power_control")
    throw new Error("Expected session tool.");
  if (requirement === "branch:strict-schema-rejection") {
    const harness = sessionHarness();
    const result = await sessionHandler(harness.handlers, tool)(
      { ...sessionInput(tool), forbidden: true },
      CONTEXT,
    );
    expect(errorEnvelope(result)).toMatchObject({
      error: { code: "CONFIG_INVALID" },
    });
    expect(harness.calls()).toBe(0);
    return;
  }
  if (
    requirement === "branch:permission-denied" ||
    requirement === "branch:unauthorized-takeover"
  ) {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError(
            "PERMISSION_DENIED",
            false,
            "grant_permission",
          )
        : deviceError(
            "PERMISSION_DENIED",
            "not_sent",
            false,
            "grant_permission",
          );
    const body = await runSessionError(tool, error);
    expect(body).toMatchObject({
      error: {
        code: "PERMISSION_DENIED",
        required_next_step: "grant_permission",
        details: {
          permission: `session.${tool.slice("jetkvm_session_".length)}`,
        },
      },
    });
    return;
  }
  if (requirement === "branch:capability-missing") {
    const body = await runSessionError(
      tool,
      new SessionServiceError("CAPABILITY_MISSING", false, "enable_capability"),
    );
    expect(body).toMatchObject({
      error: {
        code: "CAPABILITY_MISSING",
        details: { capability: "session_status" },
      },
    });
    return;
  }
  if (requirement === "branch:deadline-before-admission") {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError("DEADLINE_EXCEEDED", true, "none")
        : deviceError("DEADLINE_EXCEEDED", "not_sent", true);
    expect(await runSessionError(tool, error)).toMatchObject({
      error: { code: "DEADLINE_EXCEEDED", safe_to_retry: true },
    });
    return;
  }
  if (requirement === "branch:cancellation-before-write") {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError("CANCELLED", true, "none")
        : deviceError("CANCELLED", "not_sent", true);
    expect(await runSessionError(tool, error)).toMatchObject({
      error: {
        code: "CANCELLED",
        outcome: tool === "jetkvm_session_status" ? null : "not_sent",
      },
    });
    return;
  }
  if (requirement === "branch:disconnect-before-write") {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError(
            "CONNECTION_LOST",
            true,
            "reconnect_then_capture",
          )
        : deviceError(
            "CONNECTION_LOST",
            "not_sent",
            true,
            tool === "jetkvm_session_connect"
              ? "none"
              : "reconnect_then_capture",
          );
    expect(await runSessionError(tool, error)).toMatchObject({
      error: { code: "CONNECTION_LOST" },
    });
    return;
  }
  if (requirement === "branch:disconnect-after-write") {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError(
            "CONNECTION_LOST",
            true,
            "reconnect_then_capture",
          )
        : deviceError("CONNECTION_LOST", "unknown", false);
    expect(await runSessionError(tool, error)).toMatchObject({
      error: { code: "CONNECTION_LOST" },
    });
    return;
  }
  if (requirement === "branch:malformed-downstream-response") {
    const error =
      tool === "jetkvm_session_status"
        ? new SessionServiceError(
            "DOWNSTREAM_MALFORMED_RESPONSE",
            false,
            "reconnect_then_capture",
          )
        : deviceError("DOWNSTREAM_MALFORMED_RESPONSE", "unknown", false);
    expect(await runSessionError(tool, error)).toMatchObject({
      error: { code: "DOWNSTREAM_MALFORMED_RESPONSE" },
    });
    return;
  }
  if (requirement === "branch:stale-session-generation") {
    expect(
      await runSessionError(
        tool,
        deviceError(
          "STALE_SESSION_GENERATION",
          "not_sent",
          false,
          "reconnect_then_capture",
        ),
      ),
    ).toMatchObject({ error: { code: "STALE_SESSION_GENERATION" } });
    return;
  }
  if (requirement === "branch:busy-without-takeover") {
    expect(
      await runSessionError(
        tool,
        deviceError(
          "CONTROL_BUSY",
          "not_sent",
          true,
          "wait_or_request_takeover",
        ),
      ),
    ).toMatchObject({ error: { code: "CONTROL_BUSY" } });
    return;
  }
  if (requirement === "branch:duplicate-changed-digest") {
    expect(
      await runSessionError(
        tool,
        deviceError(
          "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
          "not_sent",
          false,
        ),
      ),
    ).toMatchObject({
      error: { code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT" },
    });
    return;
  }
  if (requirement === "branch:cleanup-failure") {
    expect(
      await runSessionError(
        tool,
        deviceError("MUTATION_OUTCOME_UNKNOWN", "unknown", false),
      ),
    ).toMatchObject({ error: { code: "MUTATION_OUTCOME_UNKNOWN" } });
    return;
  }
  if (requirement === "branch:per-fact-status-provenance") {
    const harness = sessionHarness();
    const result = await sessionHandler(harness.handlers, tool)(
      sessionInput(tool),
      CONTEXT,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        native_capture_facts: {
          signal: { source: "none", freshness: "unknown" },
          resolution: { source: "none", freshness: "unknown" },
          fps: { source: "none", freshness: "unknown" },
        },
      },
    });
    return;
  }

  const partial = requirement === "branch:partial-verification";
  const duplicate = requirement === "branch:duplicate-same-request-digest";
  const takeover = requirement === "branch:authorized-takeover";
  const connectValue: DeviceSessionConnectSuccess = {
    ...CONNECTED,
    result: {
      ...CONNECTED.result,
      outcome: duplicate ? "already_applied" : "applied",
      verification: partial ? "device_ack_only" : "device_state_verified",
      takeover_performed: takeover,
    },
  };
  const reconnectValue: DeviceSessionReconnectSuccess = {
    ...RECONNECTED,
    result: {
      ...RECONNECTED.result,
      outcome: duplicate ? "already_applied" : "applied",
      verification: partial ? "device_ack_only" : "device_state_verified",
      takeover_performed: takeover,
    },
  };
  const harness = sessionHarness({
    connect: async () => connectValue,
    reconnect: async () => reconnectValue,
  });
  const result = await sessionHandler(harness.handlers, tool)(
    sessionInput(tool),
    CONTEXT,
  );
  expect(result.structuredContent).toMatchObject({
    ok: true,
    result: {
      outcome: duplicate ? "already_applied" : "applied",
      ...(partial ? { verification: "device_ack_only" } : {}),
      ...(takeover ? { takeover_performed: true } : {}),
      ...(requirement === "branch:reconnect-evidence"
        ? { new_session_generation: 2, fresh_capture_required: true }
        : {}),
    },
  });
}

function atxReceipt(requestId: string, action: PowerAction): AtxWireReceipt {
  return {
    requestId,
    action,
    wireAction:
      action === "press_power"
        ? "power-short"
        : action === "hold_power"
          ? "power-long"
          : "reset",
    fixedPressMs: action === "hold_power" ? 5_000 : 200,
    serialSequenceCompleted: true,
    acknowledgedAt: "2026-07-14T00:00:00Z",
    atxLedObservation: {
      power: null,
      hdd: null,
      observedAt: null,
      freshness: "unknown",
    },
    verification: "device_ack_only",
    postRead: { status: "unavailable" },
  };
}

function powerInput(
  action: PowerAction = "press_power",
  requestId = "power-1",
) {
  return {
    session_id: REF.sessionId,
    session_generation: REF.sessionGeneration,
    request_id: requestId,
    action,
    timeout_ms: 1_000,
  };
}

function powerHarness(
  options: {
    readonly permissions?: readonly (typeof PERMISSION_NAMES)[number][];
    readonly capability?: boolean;
    readonly resolveError?: Error;
    readonly clock?: { now(): number };
    readonly invoke?: (
      requestId: string,
      action: PowerAction,
    ) => Promise<AtxWireReceipt>;
  } = {},
) {
  const calls: Array<{ requestId: string; action: PowerAction }> = [];
  const snapshot: DeviceSessionSnapshot = {
    ref: REF,
    state: "ready",
    connectionEpoch: 2,
    displayGeneration: 4,
    browserChannelGeneration: 3,
    freshCaptureRequired: true,
    permissions: options.permissions ?? PERMISSION_NAMES,
    capabilities: {
      ...CAPABILITIES,
      power_control: options.capability ?? true,
    },
  };
  const sessions: PowerSessionPort = {
    resolveSession: () => {
      if (options.resolveError !== undefined) throw options.resolveError;
      return snapshot;
    },
  };
  const native = {
    deviceRpc: {},
    powerControl: async (
      _ref: typeof REF,
      request: { requestId: string; action: PowerAction },
    ) => {
      calls.push(request);
      return options.invoke === undefined
        ? atxReceipt(request.requestId, request.action)
        : options.invoke(request.requestId, request.action);
    },
  } as unknown as NativeControlPlane;
  const handlers = createPowerHandlers({
    native,
    sessions,
    requestLedger: new RequestLedger({ ttlMs: 60_000, maxEntries: 100 }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const handler: JetKvmToolHandler = async (input, context) => {
    const result = await handlers.jetkvm_power_control(input, context);
    recordControlledCall("jetkvm_power_control", input, result);
    return result;
  };
  return { handler, calls };
}

async function runPowerCell(requirement: string) {
  if (requirement === "branch:strict-schema-rejection") {
    const harness = powerHarness();
    const result = await harness.handler(
      { ...powerInput(), duration_ms: 200 },
      CONTEXT,
    );
    expect(errorEnvelope(result)).toMatchObject({
      error: { code: "CONFIG_INVALID" },
    });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:permission-denied") {
    const harness = powerHarness({ permissions: ["session.status"] });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: {
        code: "PERMISSION_DENIED",
        details: { permission: "power.control" },
      },
    });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:capability-missing") {
    const harness = powerHarness({ capability: false });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: {
        code: "CAPABILITY_MISSING",
        details: { capability: "power_control" },
      },
    });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:stale-session-generation") {
    const harness = powerHarness({
      resolveError: deviceError(
        "STALE_SESSION_GENERATION",
        "not_sent",
        false,
        "reconnect_then_capture",
      ),
    });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: { code: "STALE_SESSION_GENERATION" },
    });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:cancellation-before-write") {
    const controller = new AbortController();
    controller.abort();
    const harness = powerHarness();
    expect(
      errorEnvelope(
        await harness.handler(powerInput(), {
          ...CONTEXT,
          signal: controller.signal,
        }),
      ),
    ).toMatchObject({ error: { code: "CANCELLED", outcome: "not_sent" } });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:deadline-before-admission") {
    let calls = 0;
    const harness = powerHarness({
      clock: {
        now: () => {
          calls += 1;
          return calls === 1 ? 0 : 10_000;
        },
      },
    });
    expect(
      errorEnvelope(
        await harness.handler({ ...powerInput(), timeout_ms: 100 }, CONTEXT),
      ),
    ).toMatchObject({
      error: { code: "DEADLINE_EXCEEDED", outcome: "not_sent" },
    });
    expect(harness.calls).toHaveLength(0);
    return;
  }
  if (requirement === "branch:disconnect-before-write") {
    const harness = powerHarness({
      invoke: async () => {
        throw new DeviceRpcError(
          "CONNECTION_LOST",
          "send",
          "not_sent",
          false,
          false,
        );
      },
    });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: { code: "CONNECTION_LOST", outcome: "not_sent" },
    });
    return;
  }
  if (
    requirement === "branch:disconnect-after-write" ||
    requirement === "branch:cleanup-failure"
  ) {
    const harness = powerHarness({
      invoke: async () => {
        throw new DeviceRpcError(
          requirement === "branch:cleanup-failure"
            ? "ATX_SERIAL_UNAVAILABLE"
            : "CONNECTION_LOST",
          "ack",
          "unknown",
          true,
          false,
        );
      },
    });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: { outcome: "unknown", safe_to_retry: false },
    });
    return;
  }
  if (requirement === "branch:malformed-downstream-response") {
    const harness = powerHarness({
      invoke: async (requestId) => atxReceipt(requestId, "hold_power"),
    });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: { code: "DOWNSTREAM_MALFORMED_RESPONSE", outcome: "unknown" },
    });
    return;
  }
  if (requirement === "branch:duplicate-changed-digest") {
    const harness = powerHarness();
    await harness.handler(powerInput("press_power", "same-id"), CONTEXT);
    expect(
      errorEnvelope(
        await harness.handler(powerInput("press_reset", "same-id"), CONTEXT),
      ),
    ).toMatchObject({
      error: { code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT" },
    });
    expect(harness.calls).toHaveLength(1);
    return;
  }
  if (requirement === "branch:atx-gate-and-serialization") {
    const harness = powerHarness({
      invoke: async () => {
        throw new DeviceRpcError(
          "ATX_EXTENSION_INACTIVE",
          "ack",
          "not_sent",
          true,
          true,
        );
      },
    });
    expect(
      errorEnvelope(await harness.handler(powerInput(), CONTEXT)),
    ).toMatchObject({
      error: { code: "ATX_EXTENSION_INACTIVE", outcome: "not_sent" },
    });
    return;
  }

  const harness = powerHarness();
  if (requirement === "branch:atx-acknowledgement-semantics") {
    for (const [action, wire, duration] of [
      ["press_power", "power-short", 200],
      ["hold_power", "power-long", 5_000],
      ["press_reset", "reset", 200],
    ] as const) {
      const result = await harness.handler(
        powerInput(action, `power-${action}`),
        CONTEXT,
      );
      expect(result.structuredContent).toMatchObject({
        ok: true,
        result: { action, wire_action: wire, fixed_press_ms: duration },
      });
    }
    return;
  }
  const first = await harness.handler(powerInput(), CONTEXT);
  expect(first.structuredContent).toMatchObject({
    ok: true,
    result: {
      outcome: "applied",
      verification: "device_ack_only",
      serial_sequence_completed: true,
    },
  });
  if (
    requirement === "branch:duplicate-same-request-digest" ||
    requirement === "branch:partial-verification"
  ) {
    const replay = await harness.handler(powerInput(), CONTEXT);
    expect(replay.structuredContent).toMatchObject({
      ok: true,
      result: { outcome: "already_applied" },
    });
    expect(harness.calls).toHaveLength(1);
  }
}

async function runAdapterCell(tool: Phase4Tool, requirement: string) {
  const adapter = new FakeDeviceRpcAdapter(BINDING);
  const browser = new FakeBrowserPlane(adapter);
  const native = new FakeNativeControlPlane(adapter);
  const composition = createToolHandlerComposition({
    browser,
    native,
    configuredDevice: "device-fingerprint",
    browserStatus: {
      observeSession: async () => ({
        deviceReachable: true,
        setupState: "complete",
        authMode: "password",
        lifecycleState: "ready",
        webRtc: "connected",
        hid: "ready",
        decodedVideo: "ready",
        dispatchGeneration: 1,
        activeMutation: false,
        blockedReason: null,
        uiContractVersion: "1",
        firmwareVersion: null,
      }),
    },
    capabilitiesForConnection: async () => CAPABILITIES,
  });
  expect(Object.keys(composition.handlers).sort()).toEqual(
    [...JETKVM_TOOL_NAMES].sort(),
  );
  expect(browser.deviceRpc).toBe(native.deviceRpc);
  if (requirement !== "branch:shared-device-rpc-adapter-binding") {
    const previous = { ...adapter.binding };
    adapter.replaceBinding({
      ...previous,
      connectionEpoch: previous.connectionEpoch + 1,
      browserChannelGeneration: previous.browserChannelGeneration + 1,
    });
    let failure: unknown;
    try {
      await adapter.readDisplayState(previous, {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeviceRpcError);
  }
  if (tool === "jetkvm_power_control") {
    await runPowerCell(
      requirement === "branch:device-rpc-adapter-mid-flight-loss"
        ? "branch:disconnect-after-write"
        : requirement === "branch:device-rpc-adapter-replacement"
          ? "branch:disconnect-before-write"
          : "branch:atx-acknowledgement-semantics",
    );
    return;
  }
  await runSessionCell(
    tool,
    requirement === "branch:device-rpc-adapter-mid-flight-loss"
      ? "branch:disconnect-after-write"
      : requirement === "branch:device-rpc-adapter-replacement"
        ? "branch:disconnect-before-write"
        : requirement === "branch:shared-device-rpc-adapter-binding" &&
            tool === "jetkvm_session_status"
          ? "branch:per-fact-status-provenance"
          : requirement,
  );
}

const ADAPTER_REQUIREMENTS = new Set([
  "branch:shared-device-rpc-adapter-binding",
  "branch:device-rpc-adapter-replacement",
  "branch:device-rpc-adapter-mid-flight-loss",
]);

function focusedTest(cell: FocusedCell, execute: () => Promise<void>) {
  const testName = `${cell.tool} ${cell.requirement}`;
  const identity = `${SUITE_IDENTITY} > ${testName}`;
  it(
    testName,
    {
      meta: {
        focused_assertion_ids: [cell.id],
        focused_test_identity: identity,
      },
    },
    async () => {
      activeTraceIdentity = `focused:${cell.id}`;
      activeTraceTestIdentity = identity;
      activeTraceCalls = [];
      try {
        await execute();
        RESULTS.push({
          focused_assertion_id: cell.id,
          test_identity: identity,
          result: "pass",
        });
      } catch (error) {
        RESULTS.push({
          focused_assertion_id: cell.id,
          test_identity: identity,
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

describe(SUITE_IDENTITY, () => {
  for (const cell of PHASE_4_CELLS) {
    focusedTest(cell, async () => {
      if (ADAPTER_REQUIREMENTS.has(cell.requirement)) {
        await runAdapterCell(cell.tool, cell.requirement);
      } else if (cell.tool === "jetkvm_power_control") {
        await runPowerCell(cell.requirement);
      } else {
        await runSessionCell(cell.tool, cell.requirement);
      }
    });
  }

  afterAll(async () => {
    expect(PHASE_4_CELLS).toHaveLength(70);
    validateFocusedAssertionExecutions("phase_4", RESULTS);
    await verifyControlledTraceReport();
  });
});
