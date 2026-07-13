import { describe, expect, it } from "vitest";

import {
  DeviceRpcError,
  type AtxWireReceipt,
  type CachedDisplayState,
  type Deadline,
  type DeviceRpcAdapter,
  type DeviceRpcBinding,
  type QualifiedEdidRead,
} from "../device/DeviceRpcAdapter.js";
import { JetKvmNativeControlPlane } from "./JetKvmNativeControlPlane.js";

const BINDING: DeviceRpcBinding = Object.freeze({
  sessionId: "session-a",
  sessionGeneration: 7,
  connectionEpoch: 11,
  browserChannelGeneration: 13,
});
const DEADLINE: Deadline = {
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};
const DISPLAY: CachedDisplayState = {
  signal: {
    value: "unknown",
    observedAt: null,
    ageMs: null,
    freshness: "unknown",
    source: "none",
  },
  resolution: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown",
    source: "none",
  },
  fps: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown",
    source: "none",
  },
  qualification: "current_binding",
};
const UNAVAILABLE_EDID: QualifiedEdidRead = {
  status: "unavailable",
  readCompleted: true,
  reason: "successful_read_reported_no_edid",
  observedAt: "2026-07-13T00:00:00.000Z",
  data: null,
};
const AVAILABLE_EDID: QualifiedEdidRead = {
  status: "available",
  readCompleted: true,
  reason: null,
  observedAt: "2026-07-13T00:00:00.000Z",
  data: {
    sha256: "a".repeat(64),
    manufacturerId: "TSB",
    productCode: 34_817,
    serialNumber: null,
    displayName: "T749-fHD720",
    preferredResolution: { width: 1920, height: 1080, refreshHz: 60 },
  },
};

class RecordingAdapter implements DeviceRpcAdapter {
  public displayReads = 0;
  public edidReads = 0;
  public atxWrites = 0;

  public constructor(
    public readonly binding: DeviceRpcBinding,
    private readonly edid: QualifiedEdidRead = UNAVAILABLE_EDID,
  ) {}

  public async readDisplayState(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<CachedDisplayState> {
    expect(ref).toBe(this.binding);
    expect(deadline).toBe(DEADLINE);
    this.displayReads += 1;
    return DISPLAY;
  }

  public async readEdid(
    ref: DeviceRpcBinding,
    deadline: Deadline,
  ): Promise<QualifiedEdidRead> {
    expect(ref).toBe(this.binding);
    expect(deadline).toBe(DEADLINE);
    this.edidReads += 1;
    return this.edid;
  }

  public async performAtx(): Promise<AtxWireReceipt> {
    this.atxWrites += 1;
    throw new Error("unexpected ATX mutation");
  }
}

describe("JetKvmNativeControlPlane display status", () => {
  it("shares the injected adapter and returns unsupported with zero EDID read", async () => {
    const adapter = new RecordingAdapter(BINDING);
    const plane = new JetKvmNativeControlPlane(adapter);

    expect(plane.deviceRpc).toBe(adapter);
    await expect(
      plane.displayStatus(
        { sessionId: "session-a", sessionGeneration: 7 },
        { edidReadSupported: false },
        DEADLINE,
      ),
    ).resolves.toEqual({
      ...DISPLAY,
      edid: {
        status: "unsupported",
        readCompleted: false,
        reason: "edid_read_capability_absent",
        observedAt: null,
        data: null,
      },
    });
    expect(adapter.displayReads).toBe(1);
    expect(adapter.edidReads).toBe(0);
    expect(adapter.atxWrites).toBe(0);
  });
  it("snapshots generation-scoped EDID capability before the asynchronous display read", async () => {
    let releaseDisplay!: () => void;
    const displayGate = new Promise<void>((resolve) => {
      releaseDisplay = resolve;
    });
    class DeferredDisplayAdapter extends RecordingAdapter {
      public override async readDisplayState(): Promise<CachedDisplayState> {
        this.displayReads += 1;
        await displayGate;
        return DISPLAY;
      }
    }
    const adapter = new DeferredDisplayAdapter(BINDING);
    const plane = new JetKvmNativeControlPlane(adapter);
    const request = { edidReadSupported: false };
    const pending = plane.displayStatus(
      { sessionId: "session-a", sessionGeneration: 7 },
      request,
      DEADLINE,
    );
    expect(adapter.displayReads).toBe(1);

    request.edidReadSupported = true;
    releaseDisplay();

    await expect(pending).resolves.toMatchObject({
      edid: {
        status: "unsupported",
        readCompleted: false,
        reason: "edid_read_capability_absent",
      },
    });
    expect(adapter.edidReads).toBe(0);
  });

  it.each([
    ["completed empty", UNAVAILABLE_EDID],
    ["bytes present", AVAILABLE_EDID],
  ] as const)(
    "preserves a supported %s EDID result from one read",
    async (_case, edid) => {
      const adapter = new RecordingAdapter(BINDING, edid);
      const plane = new JetKvmNativeControlPlane(adapter);

      await expect(
        plane.displayStatus(
          { sessionId: "session-a", sessionGeneration: 7 },
          { edidReadSupported: true },
          DEADLINE,
        ),
      ).resolves.toEqual({ ...DISPLAY, edid });
      expect(adapter.displayReads).toBe(1);
      expect(adapter.edidReads).toBe(1);
      expect(adapter.atxWrites).toBe(0);
    },
  );

  it("rejects a stale generation before any adapter read or mutation", async () => {
    const adapter = new RecordingAdapter(BINDING);
    const plane = new JetKvmNativeControlPlane(adapter);

    const error = await plane
      .displayStatus(
        { sessionId: "session-a", sessionGeneration: 6 },
        { edidReadSupported: true },
        DEADLINE,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceRpcError);
    expect(error).toMatchObject({
      code: "STALE_BINDING",
      boundary: "admission",
      outcome: "not_sent",
      writeBegan: false,
    });
    expect(adapter.displayReads).toBe(0);
    expect(adapter.edidReads).toBe(0);
    expect(adapter.atxWrites).toBe(0);
  });

  it("has no EDID mutation surface and rejects a non-strict capability context", async () => {
    const adapter = new RecordingAdapter(BINDING);
    const plane = new JetKvmNativeControlPlane(adapter);

    expect(
      Object.getOwnPropertyNames(JetKvmNativeControlPlane.prototype),
    ).not.toContain("setEDID");
    await expect(
      plane.displayStatus(
        { sessionId: "session-a", sessionGeneration: 7 },
        { edidReadSupported: true, setEDID: "forbidden" } as never,
        DEADLINE,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      boundary: "admission",
      outcome: "not_sent",
    });
    expect(adapter.displayReads).toBe(0);
    expect(adapter.edidReads).toBe(0);
    expect(adapter.atxWrites).toBe(0);
  });
});
