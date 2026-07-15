import { describe, expect, it } from "vitest";

import { PERMISSION_NAMES, type PowerAction } from "../domain.js";
import {
  DeviceRpcError,
  type AtxWireReceipt,
} from "../device/DeviceRpcAdapter.js";
import { RequestLedger } from "../idempotency/RequestLedger.js";
import type { NativeControlPlane } from "../planes/NativeControlPlane.js";
import type { DeviceSessionSnapshot } from "../session/deviceSessionClient.js";
import { createPowerHandlers, type PowerSessionPort } from "./power.js";

const REF = { sessionId: "session-1", sessionGeneration: 1 } as const;
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

function receipt(requestId: string, action: PowerAction): AtxWireReceipt {
  const semantics =
    action === "press_power"
      ? { wireAction: "power-short", fixedPressMs: 200 }
      : action === "hold_power"
        ? { wireAction: "power-long", fixedPressMs: 5000 }
        : { wireAction: "reset", fixedPressMs: 200 };
  return {
    requestId,
    action,
    ...semantics,
    serialSequenceCompleted: true,
    acknowledgedAt: "2026-07-14T01:02:04Z",
    atxLedObservation: {
      power: null,
      hdd: null,
      observedAt: null,
      freshness: "unknown",
    },
    verification: "device_ack_only",
    postRead: { status: "unavailable" },
  } as AtxWireReceipt;
}

function setup(
  options: {
    power?: (requestId: string, action: PowerAction) => Promise<AtxWireReceipt>;
    permissions?: DeviceSessionSnapshot["permissions"];
    powerCapability?: boolean;
  } = {},
) {
  const calls: Array<{ requestId: string; action: PowerAction }> = [];
  const session: DeviceSessionSnapshot = {
    ref: REF,
    state: "ready",
    connectionEpoch: 2,
    displayGeneration: 3,
    browserChannelGeneration: 4,
    freshCaptureRequired: true,
    permissions: options.permissions ?? PERMISSION_NAMES,
    capabilities: {
      ...CAPABILITIES,
      power_control: options.powerCapability ?? true,
    },
  };
  const sessions: PowerSessionPort = {
    resolveSession: () => session,
  };
  const native = {
    deviceRpc: {},
    powerControl: async (
      _ref: typeof REF,
      request: { requestId: string; action: PowerAction },
    ) => {
      calls.push(request);
      return options.power
        ? options.power(request.requestId, request.action)
        : receipt(request.requestId, request.action);
    },
  } as unknown as NativeControlPlane;
  let now = 100;
  const handlers = createPowerHandlers({
    native,
    sessions,
    requestLedger: new RequestLedger({ ttlMs: 60_000, maxEntries: 100 }),
    clock: { now: () => now++ },
  });
  const context = {
    signal: new AbortController().signal,
    principalId: "principal-a",
    correlationId: "operation-1",
  };
  return { handlers, calls, context };
}

function input(action: PowerAction, requestId = `request-${action}`) {
  return {
    session_id: REF.sessionId,
    session_generation: REF.sessionGeneration,
    request_id: requestId,
    action,
    timeout_ms: 5_000,
  };
}

describe("power handler", () => {
  it.each([
    ["press_power", "power-short", 200],
    ["hold_power", "power-long", 5000],
    ["press_reset", "reset", 200],
  ] as const)(
    "returns and replays the exact %s semantic receipt without a second action",
    async (action, wireAction, fixedPressMs) => {
      const { handlers, calls, context } = setup();
      const first = await handlers.jetkvm_power_control(input(action), context);
      const replay = await handlers.jetkvm_power_control(
        input(action),
        context,
      );

      expect(first.structuredContent).toMatchObject({
        ok: true,
        result: {
          request_id: `request-${action}`,
          outcome: "applied",
          verification: "device_ack_only",
          action,
          wire_action: wireAction,
          fixed_press_ms: fixedPressMs,
          serial_sequence_completed: true,
          atx_led_observation: {
            power: null,
            hdd: null,
            observed_at: null,
            freshness: "unknown",
          },
        },
      });
      expect(replay.structuredContent).toMatchObject({
        ok: true,
        result: { outcome: "already_applied" },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("releases a definitive inactive-extension attempt for a corrected retry", async () => {
    const { handlers, calls, context } = setup({
      power: async () => {
        throw new DeviceRpcError(
          "ATX_EXTENSION_INACTIVE",
          "ack",
          "not_sent",
          true,
          true,
        );
      },
    });
    const first = await handlers.jetkvm_power_control(
      input("press_power", "inactive-1"),
      context,
    );
    const second = await handlers.jetkvm_power_control(
      input("press_power", "inactive-1"),
      context,
    );

    expect(first.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "ATX_EXTENSION_INACTIVE",
        phase: "validate",
        outcome: "not_sent",
        details: { downstream_stage: "none" },
      },
    });
    expect(second.structuredContent).toMatchObject(
      first.structuredContent ?? {},
    );
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["CONFIG_INVALID", "none", "none"],
    ["REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT", "none", "none"],
    ["STALE_SESSION_GENERATION", "reconnect_then_capture", "admission"],
  ] as const)(
    "publishes a schema-valid definitive %s ATX rejection",
    async (code, requiredNextStep, downstreamStage) => {
      const { handlers, calls, context } = setup({
        power: async () => {
          throw new DeviceRpcError(code, "ack", "not_sent", true, true);
        },
      });
      const operationInput = input("press_power", `negative-${code}`);

      const result = await handlers.jetkvm_power_control(
        operationInput,
        context,
      );
      const retry = await handlers.jetkvm_power_control(
        operationInput,
        context,
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code,
          phase: "validate",
          outcome: "not_sent",
          safe_to_retry: false,
          required_next_step: requiredNextStep,
          details: { downstream_stage: downstreamStage },
        },
      });
      expect(retry.structuredContent).toMatchObject({
        ok: false,
        error: result.structuredContent?.error,
      });
      expect(calls).toHaveLength(2);
    },
  );

  it("publishes a definitive malformed ATX response and releases it for retry", async () => {
    const { handlers, calls, context } = setup({
      power: async () => {
        throw new DeviceRpcError(
          "DOWNSTREAM_MALFORMED_RESPONSE",
          "ack",
          "not_sent",
          true,
          true,
        );
      },
    });
    const operationInput = input("press_power", "malformed-negative-ack");

    const first = await handlers.jetkvm_power_control(operationInput, context);
    const retry = await handlers.jetkvm_power_control(operationInput, context);
    expect(first.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        phase: "execute",
        outcome: "not_sent",
        safe_to_retry: false,
        required_next_step: "reconnect_then_capture",
        details: { downstream_stage: "write" },
      },
    });
    expect(retry.structuredContent).toMatchObject({
      ok: false,
      error: first.structuredContent?.error,
    });
    expect(calls).toHaveLength(2);
  });

  it("never downgrades an ambiguous ATX rejection to a retryable not-sent result", async () => {
    const { handlers, calls, context } = setup({
      power: async () => {
        throw new DeviceRpcError(
          "CONFIG_INVALID",
          "ack",
          "unknown",
          true,
          false,
        );
      },
    });
    const operationInput = input("press_power", "ambiguous-config");

    const first = await handlers.jetkvm_power_control(operationInput, context);
    const replay = await handlers.jetkvm_power_control(operationInput, context);
    expect(first.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        phase: "execute",
        outcome: "unknown",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
      },
    });
    expect(replay.structuredContent).toMatchObject({
      ok: false,
      error: first.structuredContent?.error,
    });
    expect(calls).toHaveLength(1);
  });

  it("persists an unknown ATX outcome and never replays the physical action", async () => {
    const { handlers, calls, context } = setup({
      power: async () => {
        throw new DeviceRpcError(
          "MUTATION_OUTCOME_UNKNOWN",
          "ack",
          "unknown",
          true,
          true,
        );
      },
    });
    const first = await handlers.jetkvm_power_control(
      input("press_power", "unknown-1"),
      context,
    );
    const replay = await handlers.jetkvm_power_control(
      input("press_power", "unknown-1"),
      context,
    );

    expect(first.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        outcome: "unknown",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
      },
    });
    expect(replay.structuredContent).toMatchObject({
      ok: false,
      error: first.structuredContent?.error,
    });
    expect(calls).toHaveLength(1);
  });

  it("fails a mismatched receipt closed without returning success", async () => {
    const { handlers, context } = setup({
      power: async (requestId) => receipt(requestId, "hold_power"),
    });
    const result = await handlers.jetkvm_power_control(
      input("press_power", "mismatch-1"),
      context,
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "DOWNSTREAM_MALFORMED_RESPONSE",
        outcome: "unknown",
      },
    });
  });

  it("blocks missing permission and capability before native dispatch", async () => {
    for (const [options, code] of [
      [{ permissions: ["session.status"] }, "PERMISSION_DENIED"],
      [{ powerCapability: false }, "CAPABILITY_MISSING"],
    ] as const) {
      const { handlers, calls, context } = setup(options);
      const result = await handlers.jetkvm_power_control(
        input("press_reset", `blocked-${code}`),
        context,
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code, outcome: "not_sent" },
      });
      expect(calls).toHaveLength(0);
    }
  });
});
