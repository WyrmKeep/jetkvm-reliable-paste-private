import { describe, expect, it } from "vitest";

import type {
  AtxWireReceipt,
  CachedDisplayState,
  Deadline,
  DeviceRpcAdapter,
  DeviceRpcBinding,
  QualifiedEdidRead,
} from "../device/DeviceRpcAdapter.js";
import { FakeBrowserPlane } from "./fakes/FakeBrowserPlane.js";
import { FakeNativeControlPlane } from "./fakes/FakeNativeControlPlane.js";
import { PlaneFaultError, type PlaneFault } from "./fakes/PlaneScenario.js";

const binding: DeviceRpcBinding = {
  sessionId: "session-a",
  sessionGeneration: 1,
  connectionEpoch: 2,
  browserChannelGeneration: 3,
};
const ref = {
  sessionId: binding.sessionId,
  sessionGeneration: binding.sessionGeneration,
};
const deadline: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const receipt = {
  requestId: "request-a",
  outcome: "applied" as const,
  verification: "device_ack_only" as const,
  dispatchedCount: 1,
  completedCount: 1,
  acknowledgedAt: "2026-07-13T00:00:00.000Z",
};

const display: CachedDisplayState = {
  signal: {
    value: "present",
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  resolution: {
    value: { width: 1920, height: 1080, refreshHz: 60 },
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  fps: {
    value: 60,
    observedAt: "2026-07-13T00:00:00.000Z",
    ageMs: 1,
    freshness: "fresh",
    source: "cached_snapshot",
  },
  qualification: "current_binding",
};
const edid: QualifiedEdidRead = {
  status: "unsupported",
  readCompleted: false,
  reason: "edid_read_capability_absent",
  observedAt: null,
  data: null,
};
const atx: AtxWireReceipt = {
  requestId: "power-a",
  action: "press_power",
  wireAction: "power-short",
  fixedPressMs: 200,
  serialSequenceCompleted: true,
  acknowledgedAt: "2026-07-13T00:00:00.000Z",
  atxLedObservation: {
    power: null,
    hdd: null,
    observedAt: null,
    freshness: "unknown",
  },
  verification: "device_ack_only",
  postRead: { status: "unavailable" },
};

class RecordingAdapter implements DeviceRpcAdapter {
  public readonly calls: string[] = [];
  public readonly binding = binding;

  public async readDisplayState(
    actual: DeviceRpcBinding,
    _deadline: Deadline,
  ): Promise<CachedDisplayState> {
    expect(actual).toEqual(binding);
    this.calls.push("readDisplayState");
    return display;
  }

  public async readEdid(
    actual: DeviceRpcBinding,
    _deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    expect(actual).toEqual(binding);
    this.calls.push("readEdid");
    return edid;
  }

  public async performAtx(
    actual: DeviceRpcBinding,
    request: {
      requestId: string;
      action: "press_power" | "hold_power" | "press_reset";
    },
    _deadline: Deadline,
  ): Promise<AtxWireReceipt> {
    expect(actual).toEqual(binding);
    expect(request).toEqual({ requestId: "power-a", action: "press_power" });
    this.calls.push("performAtx");
    return atx;
  }
}

const THROWING_FAULTS: readonly PlaneFault[] = [
  "deadline_before_admission",
  "cancellation_before_admission",
  "disconnect_before_write",
  "disconnect_after_write_before_ack",
  "disconnect_after_ack_before_post_read",
  "malformed_response",
  "permission_denied",
  "capability_missing",
  "control_busy",
  "takeover",
  "stale_generation",
  "partial_multi_event",
  "partial_verification",
  "cleanup_failure",
  "post_reconnect_without_capture",
  "event_gap",
  "duplicate_request_id",
];

describe("FakeBrowserPlane", () => {
  it("publishes only its injected adapter in the BrowserConnection", async () => {
    const adapter = new RecordingAdapter();
    const plane = new FakeBrowserPlane(adapter);
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding,
            connectionEpoch: binding.connectionEpoch,
            browserChannelGeneration: binding.browserChannelGeneration,
            displayGeneration: 1,
            deviceRpc: new RecordingAdapter(),
          },
        },
      ],
    });

    const connection = await plane.connect(ref, deadline);

    expect(connection.deviceRpc).toBe(adapter);
  });

  it.each(THROWING_FAULTS)(
    "forces the %s boundary and consumes it once",
    async (fault) => {
      const plane = new FakeBrowserPlane(new RecordingAdapter());
      plane.loadScenario({
        version: 1,
        steps: [
          { operation: "mouse", fault, dispatchedCount: 2, completedCount: 1 },
        ],
      });

      const error = await plane
        .mouse(
          ref,
          {
            observationId: "observation-a",
            requestId: "request-a",
            actions: [{ type: "move", x: 1, y: 2 }],
          },
          deadline,
        )
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(PlaneFaultError);
      expect(error).toMatchObject({ fault });
      if (
        fault === "disconnect_after_ack_before_post_read" ||
        fault === "partial_verification"
      ) {
        expect(error).toMatchObject({ outcome: "applied", acknowledged: true });
      }
      if (fault === "partial_multi_event") {
        expect(error).toMatchObject({
          outcome: "unknown",
          dispatchedCount: 2,
          completedCount: 1,
          suffixSuppressed: true,
        });
      }
      expect(() => plane.assertExhausted()).not.toThrow();
      await expect(
        plane.mouse(
          ref,
          {
            observationId: "observation-a",
            requestId: "request-a",
            actions: [{ type: "move", x: 1, y: 2 }],
          },
          deadline,
        ),
      ).rejects.toThrow(/unexpected fake plane call/i);
    },
  );

  it("returns a persisted terminal result despite a later disconnect", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "mouse",
          fault: "disconnect_after_persisted_terminal",
          result: receipt,
        },
      ],
    });

    await expect(
      plane.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        deadline,
      ),
    ).resolves.toEqual(receipt);
    expect(plane.events()).toContainEqual(
      expect.objectContaining({
        fault: "disconnect_after_persisted_terminal",
        terminalPersisted: true,
      }),
    );
  });

  it("does not retain paste text or frame bytes in events", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "paste", result: receipt }],
    });

    await plane.paste(
      ref,
      {
        observationId: "observation-a",
        requestId: "request-a",
        text: "private paste",
      },
      deadline,
    );

    const serialized = JSON.stringify(plane.events());
    expect(serialized).not.toContain("private paste");
    expect(serialized).toContain("textSha256");
  });

  it("enforces actual deadline cancellation before consuming a scenario step", async () => {
    const plane = new FakeBrowserPlane(new RecordingAdapter());
    plane.loadScenario({
      version: 1,
      steps: [{ operation: "mouse", result: receipt }],
    });
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      plane.mouse(
        ref,
        {
          observationId: "observation-a",
          requestId: "request-a",
          actions: [{ type: "move", x: 1, y: 2 }],
        },
        { timeoutMs: 1_000, signal: cancellation.signal },
      ),
    ).rejects.toMatchObject({
      fault: "cancellation_before_admission",
      outcome: "not_sent",
    });
    expect(() => plane.assertExhausted()).toThrow(/1 unconsumed/i);
  });
});

describe("FakeNativeControlPlane", () => {
  it("uses the exact injected DeviceRpcAdapter for display and power without opening a transport", async () => {
    const adapter = new RecordingAdapter();
    const native = new FakeNativeControlPlane(adapter);
    native.loadScenario({
      version: 1,
      steps: [{ operation: "displayStatus" }, { operation: "powerControl" }],
    });

    await expect(native.displayStatus(ref, deadline)).resolves.toEqual({
      ...display,
      edid,
    });
    await expect(
      native.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).resolves.toEqual(atx);

    expect(adapter.calls).toEqual([
      "readDisplayState",
      "readEdid",
      "performAtx",
    ]);
    expect(native.deviceRpc).toBe(adapter);
  });

  it("can force a pre-adapter native fault with zero adapter calls", async () => {
    const adapter = new RecordingAdapter();
    const native = new FakeNativeControlPlane(adapter);
    native.loadScenario({
      version: 1,
      steps: [{ operation: "powerControl", fault: "capability_missing" }],
    });

    await expect(
      native.powerControl(
        ref,
        { requestId: "power-a", action: "press_power" },
        deadline,
      ),
    ).rejects.toMatchObject({
      fault: "capability_missing",
      outcome: "not_sent",
    });
    expect(adapter.calls).toEqual([]);
  });
});
