import { z } from "zod";
import { describe, expect, it } from "vitest";

import type {
  SessionConnectInput,
  SessionReconnectInput,
  SessionStatusResult,
} from "../domain.js";
import type { Deadline, SessionRef } from "../device/DeviceRpcAdapter.js";
import {
  DeviceSessionClientError,
  type DeviceSessionConnectSuccess,
  type DeviceSessionReconnectSuccess,
} from "../session/deviceSessionClient.js";
import type { SessionHandlerService } from "./session.js";
import { createSessionHandlers } from "./session.js";

const objectSchema = z.record(z.unknown());
const REF: SessionRef = { sessionId: "session-1", sessionGeneration: 1 };
const CAPABILITIES = {
  session_status: true,
  display_capture: true,
  display_status: true,
  mouse: true,
  absolute_pointer: true,
  keyboard: true,
  reliable_paste: true,
  input_release: true,
  power_control: true,
  edid_read: true,
} as const;
const CONNECTED: DeviceSessionConnectSuccess = {
  ref: REF,
  result: {
    request_id: "connect-1",
    outcome: "applied",
    verification: "device_state_verified",
    safe_to_retry: false,
    required_next_step: "none",
    state: "ready",
    connection_epoch: 3,
    display_generation: 4,
    takeover_performed: false,
    fresh_capture_required: true,
    permissions: ["session.connect", "session.status", "session.reconnect"],
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
    connection_epoch: 4,
    state: "ready",
    takeover_performed: false,
    fresh_capture_required: true,
  },
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
  connection_epoch: 3,
  display_generation: 4,
  dispatch_generation: 5,
  browser_channel_generation: 6,
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
  permissions: ["session.connect", "session.status", "session.reconnect"],
  capabilities: CAPABILITIES,
  blocked_reason: null,
  versions: {
    server: "0.1.0",
    protocol: "2025-06-18",
    ui_contract: "automation-v1",
    firmware: "firmware-test",
  },
};

function setup(overrides: Partial<SessionHandlerService> = {}) {
  const calls: Array<{
    kind: "connect" | "status" | "reconnect";
    principal: string;
    input: unknown;
    signal: AbortSignal;
  }> = [];
  const service: SessionHandlerService = {
    connect: async (
      principal: string,
      input: SessionConnectInput,
      signal?: AbortSignal,
    ) => {
      calls.push({
        kind: "connect",
        principal,
        input,
        signal: signal ?? new AbortController().signal,
      });
      return CONNECTED;
    },
    status: async (principal: string, ref: SessionRef, deadline: Deadline) => {
      calls.push({
        kind: "status",
        principal,
        input: ref,
        signal: deadline.signal,
      });
      return STATUS;
    },
    reconnect: async (
      principal: string,
      input: SessionReconnectInput,
      signal?: AbortSignal,
    ) => {
      calls.push({
        kind: "reconnect",
        principal,
        input,
        signal: signal ?? new AbortController().signal,
      });
      return RECONNECTED;
    },
    ...overrides,
  };
  let now = 100;
  const handlers = createSessionHandlers({
    service,
    clock: { now: () => now++ },
  });
  const signal = new AbortController().signal;
  const context = {
    signal,
    principalId: "principal-a",
    correlationId: "operation-1",
  };
  return { handlers, service, calls, context, signal };
}

describe("session handlers", () => {
  it("issues the service-owned session identity in an exact connect envelope", async () => {
    const { handlers, calls, context, signal } = setup();

    const result = await handlers.jetkvm_session_connect(
      { request_id: "connect-1", timeout_ms: 5_000 },
      context,
    );
    const structured = objectSchema.parse(result.structuredContent);

    expect(calls).toEqual([
      {
        kind: "connect",
        principal: "principal-a",
        input: {
          request_id: "connect-1",
          takeover: false,
          timeout_ms: 5_000,
        },
        signal,
      },
    ]);
    expect(structured).toEqual({
      ok: true,
      tool: "jetkvm_session_connect",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      result: CONNECTED.result,
    });
  });

  it("preserves the no-steal busy contract without reporting a write", async () => {
    const busy = new DeviceSessionClientError(
      "CONTROL_BUSY",
      "busy",
      "not_sent",
      true,
      "wait_or_request_takeover",
    );
    const { handlers, context } = setup({
      connect: async () => {
        throw busy;
      },
    });

    const result = await handlers.jetkvm_session_connect(
      { request_id: "connect-1", takeover: false, timeout_ms: 5_000 },
      context,
    );
    const structured = objectSchema.parse(result.structuredContent);

    expect(structured).toMatchObject({
      ok: false,
      tool: "jetkvm_session_connect",
      session_id: null,
      session_generation: null,
      error: {
        code: "CONTROL_BUSY",
        phase: "authorize",
        outcome: "not_sent",
        verification: "none",
        safe_to_retry: true,
        required_next_step: "wait_or_request_takeover",
      },
    });
  });

  it("returns a schema-valid unknown deadline after connection admission", async () => {
    const deadline = new DeviceSessionClientError(
      "DEADLINE_EXCEEDED",
      "deadline",
      "unknown",
      false,
      "inspect_device_state_before_retry",
    );
    const { handlers, context } = setup({
      connect: async () => {
        throw deadline;
      },
    });

    const result = await handlers.jetkvm_session_connect(
      { request_id: "connect-1", takeover: false, timeout_ms: 5_000 },
      context,
    );

    expect(objectSchema.parse(result.structuredContent)).toMatchObject({
      ok: false,
      error: {
        code: "DEADLINE_EXCEEDED",
        phase: "execute",
        outcome: "unknown",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
        details: { downstream_stage: "write" },
      },
    });
  });

  it("normalizes an unreachable initial connection to its public recovery contract", async () => {
    const unavailable = new DeviceSessionClientError(
      "DEVICE_UNREACHABLE",
      "unavailable",
      "not_sent",
      true,
      "reconnect_then_capture",
    );
    const { handlers, context } = setup({
      connect: async () => {
        throw unavailable;
      },
    });

    const result = await handlers.jetkvm_session_connect(
      { request_id: "connect-1", takeover: false, timeout_ms: 5_000 },
      context,
    );

    expect(objectSchema.parse(result.structuredContent)).toMatchObject({
      ok: false,
      error: {
        code: "DEVICE_UNREACHABLE",
        phase: "connect",
        outcome: "not_sent",
        safe_to_retry: true,
        required_next_step: "none",
        details: { downstream_stage: "admission" },
      },
    });
  });

  it("returns the composed status without adding a unified health field", async () => {
    const { handlers, calls, context, signal } = setup();

    const result = await handlers.jetkvm_session_status(
      {
        session_id: "session-1",
        session_generation: 1,
        timeout_ms: 1_000,
      },
      context,
    );
    const structured = objectSchema.parse(result.structuredContent);

    expect(calls).toEqual([
      {
        kind: "status",
        principal: "principal-a",
        input: REF,
        signal,
      },
    ]);
    expect(structured).toMatchObject({
      ok: true,
      tool: "jetkvm_session_status",
      session_id: "session-1",
      session_generation: 1,
      result: STATUS,
    });
    expect(structured).not.toHaveProperty("result.health");
  });

  it("publishes the new generation from reconnect and keeps the previous input generation in the result", async () => {
    const { handlers, context } = setup();

    const result = await handlers.jetkvm_session_reconnect(
      {
        session_id: "session-1",
        session_generation: 1,
        request_id: "reconnect-1",
        timeout_ms: 5_000,
      },
      context,
    );
    const structured = objectSchema.parse(result.structuredContent);

    expect(structured).toMatchObject({
      ok: true,
      tool: "jetkvm_session_reconnect",
      session_id: "session-1",
      session_generation: 2,
      result: {
        previous_session_generation: 1,
        new_session_generation: 2,
        fresh_capture_required: true,
      },
    });
  });

  it("rejects unauthenticated and non-strict inputs before the service", async () => {
    const { handlers, calls, context } = setup();

    const unauthenticated = await handlers.jetkvm_session_status(
      {
        session_id: "session-1",
        session_generation: 1,
        timeout_ms: 1_000,
      },
      { ...context, principalId: null },
    );
    const invalid = await handlers.jetkvm_session_connect(
      { request_id: "connect-1", timeout_ms: 5_000, target: "forbidden" },
      context,
    );

    expect(objectSchema.parse(unauthenticated.structuredContent)).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", phase: "authorize" },
    });
    expect(objectSchema.parse(invalid.structuredContent)).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", phase: "validate" },
    });
    expect(calls).toEqual([]);
  });
});
