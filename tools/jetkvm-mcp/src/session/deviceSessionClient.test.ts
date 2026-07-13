import { describe, expect, it } from "vitest";

import type {
  BrowserConnection,
  BrowserPlane,
} from "../planes/BrowserPlane.js";
import type {
  CapabilitySnapshot,
  PermissionName,
  SessionConnectInput,
  SessionReconnectInput,
} from "../domain.js";
import type {
  Deadline,
  DeviceRpcAdapter,
  SessionRef,
} from "../device/DeviceRpcAdapter.js";
import { RequestLedger } from "../idempotency/RequestLedger.js";
import { ReplayRecordedError } from "../test-support/replay/SanitizedReplayTape.js";
import {
  DeviceSessionClient,
  DeviceSessionClientError,
  DeviceSessionPlaneError,
  type DeviceSessionScheduler,
} from "./deviceSessionClient.js";

const ALL_CAPABILITIES: CapabilitySnapshot = {
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
};

const BASE_PERMISSIONS: readonly PermissionName[] = [
  "session.connect",
  "session.status",
  "session.reconnect",
];

class FakeScheduler implements DeviceSessionScheduler {
  nowMs = 10_000;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.#timers.delete(id as number);
  };

  advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.nowMs) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}

type BrowserEvent = {
  kind: "connect" | "reconnect" | "close";
  ref: SessionRef;
  deadline: Deadline;
};

class FakeBrowserPlane implements BrowserPlane {
  deviceRpc = {
    binding: {
      sessionId: "unbound",
      sessionGeneration: 1,
      connectionEpoch: 1,
      browserChannelGeneration: 1,
    },
  } as DeviceRpcAdapter;
  readonly events: BrowserEvent[] = [];
  connectionEpoch = 10;
  displayGeneration = 20;
  channelGeneration = 30;
  holdConnect = false;
  holdReconnect = false;
  advanceReconnectEvidence = true;
  rejectClose: Error | null = null;
  connectFailure: Error | null = null;
  reconnectFailure: Error | null = null;
  afterConnect: (() => void) | null = null;
  lastConnectSignal: AbortSignal | null = null;

  async connect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.events.push({ kind: "connect", ref, deadline });
    this.lastConnectSignal = deadline.signal;
    if (this.holdConnect) {
      return this.#waitForAbort(deadline.signal);
    }
    if (this.connectFailure !== null) {
      throw this.connectFailure;
    }
    this.afterConnect?.();
    return this.#connection(ref);
  }

  async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    this.events.push({ kind: "reconnect", ref, deadline });
    if (this.holdReconnect) {
      return this.#waitForAbort(deadline.signal);
    }
    if (this.reconnectFailure !== null) {
      throw this.reconnectFailure;
    }
    if (this.advanceReconnectEvidence) {
      this.connectionEpoch += 1;
      this.displayGeneration += 1;
      this.channelGeneration += 1;
    }
    return this.#connection(ref);
  }

  async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.events.push({ kind: "close", ref, deadline });
    if (this.rejectClose !== null) {
      throw this.rejectClose;
    }
  }

  async capture(): Promise<never> {
    throw new Error("unexpected capture");
  }

  async mouse(): Promise<never> {
    throw new Error("unexpected mouse");
  }

  async keyboard(): Promise<never> {
    throw new Error("unexpected keyboard");
  }

  async paste(): Promise<never> {
    throw new Error("unexpected paste");
  }

  async release(): Promise<never> {
    throw new Error("unexpected release");
  }

  #connection(ref: SessionRef): BrowserConnection {
    const binding = {
      ...ref,
      connectionEpoch: this.connectionEpoch,
      browserChannelGeneration: this.channelGeneration,
    };
    this.deviceRpc = { binding } as DeviceRpcAdapter;
    return {
      ref,
      binding,
      connectionEpoch: this.connectionEpoch,
      browserChannelGeneration: this.channelGeneration,
      displayGeneration: this.displayGeneration,
      state: "ready",
      deviceRpc: this.deviceRpc,
    };
  }

  async #waitForAbort(signal: AbortSignal): Promise<never> {
    if (signal.aborted) {
      throw signal.reason;
    }
    const { promise, reject } = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
    return promise;
  }
}

function makeClient(
  options: {
    permissions?: readonly PermissionName[];
    permissionsForPrincipal?: (principal: string) => readonly PermissionName[];
    capabilitiesForConnection?: () => Promise<CapabilitySnapshot>;
    browser?: FakeBrowserPlane;
    scheduler?: FakeScheduler;
    requestLedger?: RequestLedger;
    createSessionId?: () => string;
  } = {},
) {
  const browser = options.browser ?? new FakeBrowserPlane();
  const scheduler = options.scheduler ?? new FakeScheduler();
  let nextSessionId = 1;
  const client = new DeviceSessionClient({
    browser,
    configuredDevice: "configured-device-a",
    requestLedger:
      options.requestLedger ??
      new RequestLedger({
        ttlMs: 60_000,
        maxEntries: 50,
        now: scheduler.now,
      }),
    scheduler,
    createSessionId:
      options.createSessionId ?? (() => `app-session-${nextSessionId++}`),
    permissionsForPrincipal:
      options.permissionsForPrincipal ??
      (() => options.permissions ?? BASE_PERMISSIONS),
    capabilitiesForConnection:
      options.capabilitiesForConnection ?? (async () => ALL_CAPABILITIES),
  });
  return { client, browser, scheduler };
}

function connectInput(
  overrides: Partial<SessionConnectInput> = {},
): SessionConnectInput {
  return {
    request_id: "connect-request-1",
    takeover: false,
    timeout_ms: 5_000,
    ...overrides,
  };
}

function reconnectInput(
  ref: SessionRef,
  overrides: Partial<SessionReconnectInput> = {},
): SessionReconnectInput {
  return {
    session_id: ref.sessionId,
    session_generation: ref.sessionGeneration,
    request_id: "reconnect-request-1",
    takeover: false,
    timeout_ms: 5_000,
    ...overrides,
  };
}

async function expectClientError(
  promise: Promise<unknown>,
  code: DeviceSessionClientError["code"],
): Promise<DeviceSessionClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceSessionClientError);
    expect(error).toMatchObject({ code });
    return error as DeviceSessionClientError;
  }
  throw new Error(`expected ${code}`);
}

async function waitForBrowserAdmission(
  browser: FakeBrowserPlane,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 10 && browser.events.length === 0;
    attempt += 1
  ) {
    await Promise.resolve();
  }
  expect(browser.events.length).toBeGreaterThan(0);
}

describe("DeviceSessionClient", () => {
  it("creates an application session independent of any MCP transport identity", async () => {
    const { client, browser } = makeClient();

    const connected = await client.connect("principal-a", connectInput());

    expect(connected).toEqual({
      ref: { sessionId: "app-session-1", sessionGeneration: 1 },
      result: {
        request_id: "connect-request-1",
        outcome: "applied",
        verification: "device_state_verified",
        safe_to_retry: false,
        required_next_step: "none",
        state: "ready",
        connection_epoch: 10,
        display_generation: 20,
        takeover_performed: false,
        fresh_capture_required: true,
        permissions: BASE_PERMISSIONS,
        capabilities: ALL_CAPABILITIES,
      },
    });
    expect(browser.events[0]).toMatchObject({
      kind: "connect",
      ref: connected.ref,
    });
    expect(connected.ref.sessionId).not.toContain("sse");
    expect(connected.ref.sessionId).not.toContain("transport");
  });

  it("retains immutable permission and capability snapshots for the published generation", async () => {
    const permissions: PermissionName[] = [
      ...BASE_PERMISSIONS,
      "display.capture",
      "input.mouse",
    ];
    const capabilities: CapabilitySnapshot = { ...ALL_CAPABILITIES };
    const { client } = makeClient({
      permissionsForPrincipal: () => permissions,
      capabilitiesForConnection: async () => capabilities,
    });
    const connected = await client.connect("principal-a", connectInput());

    permissions.splice(0, permissions.length, "session.connect");
    capabilities.display_capture = false;
    capabilities.mouse = false;

    const snapshot = client.resolveSession("principal-a", connected.ref);
    expect(snapshot.permissions).toEqual([
      ...BASE_PERMISSIONS,
      "display.capture",
      "input.mouse",
    ]);
    expect(snapshot.capabilities).toEqual(ALL_CAPABILITIES);
    expect(Object.isFrozen(snapshot.permissions)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
  });

  it("replaces authorization snapshots atomically with the reconnected generation", async () => {
    let permissions: readonly PermissionName[] = [
      ...BASE_PERMISSIONS,
      "display.capture",
    ];
    let capabilities: CapabilitySnapshot = { ...ALL_CAPABILITIES };
    const { client } = makeClient({
      permissionsForPrincipal: () => permissions,
      capabilitiesForConnection: async () => capabilities,
    });
    const connected = await client.connect("principal-a", connectInput());

    permissions = [...BASE_PERMISSIONS, "input.keyboard"];
    capabilities = {
      ...ALL_CAPABILITIES,
      display_capture: false,
      keyboard: true,
    };
    const reconnected = await client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );

    const snapshot = client.resolveSession("principal-a", reconnected.ref);
    expect(snapshot.permissions).toEqual([
      ...BASE_PERMISSIONS,
      "input.keyboard",
    ]);
    expect(snapshot.capabilities).toEqual(capabilities);
    expect(snapshot.capabilities.display_capture).toBe(false);
    expect(Object.isFrozen(snapshot.permissions)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", connected.ref),
      ),
      "STALE_SESSION_GENERATION",
    );
  });

  it("acknowledges fresh capture only for current generation and display evidence", async () => {
    const { client } = makeClient();
    const connected = await client.connect("principal-a", connectInput());

    expect(
      client.acknowledgeCurrentCapture("principal-a", {
        ref: connected.ref,
        connectionEpoch: connected.result.connection_epoch + 1,
        displayGeneration: connected.result.display_generation,
      }),
    ).toBe(false);
    const advancedDisplayGeneration = connected.result.display_generation + 1;
    expect(
      client.acknowledgeCurrentCapture("principal-a", {
        ref: connected.ref,
        connectionEpoch: connected.result.connection_epoch,
        displayGeneration: advancedDisplayGeneration,
      }),
    ).toBe(true);
    expect(client.resolveSession("principal-a", connected.ref)).toMatchObject({
      displayGeneration: advancedDisplayGeneration,
      freshCaptureRequired: false,
    });
    expect(
      client.acknowledgeCurrentCapture("principal-a", {
        ref: connected.ref,
        connectionEpoch: connected.result.connection_epoch,
        displayGeneration: connected.result.display_generation,
      }),
    ).toBe(false);

    const reconnected = await client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );
    expect(
      client.acknowledgeCurrentCapture("principal-a", {
        ref: connected.ref,
        connectionEpoch: connected.result.connection_epoch,
        displayGeneration: connected.result.display_generation,
      }),
    ).toBe(false);
    expect(
      client.resolveSession("principal-a", reconnected.ref)
        .freshCaptureRequired,
    ).toBe(true);
    expect(
      client.acknowledgeCurrentCapture("principal-a", {
        ref: reconnected.ref,
        connectionEpoch: reconnected.result.connection_epoch,
        displayGeneration: client.resolveSession("principal-a", reconnected.ref)
          .displayGeneration,
      }),
    ).toBe(true);
  });

  it("replays an idempotent connect without creating another application session", async () => {
    const { client, browser } = makeClient();
    const first = await client.connect("principal-a", connectInput());

    const duplicate = await client.connect("principal-a", connectInput());

    expect(duplicate.ref).toEqual(first.ref);
    expect(duplicate.result).toEqual({
      ...first.result,
      outcome: "already_applied",
    });
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("normalizes omitted takeover to false for connect idempotency", async () => {
    const { client, browser } = makeClient();
    const omitted = connectInput();
    delete omitted.takeover;
    const first = await client.connect("principal-a", omitted);

    const duplicate = await client.connect(
      "principal-a",
      connectInput({ takeover: false }),
    );

    expect(duplicate.ref).toEqual(first.ref);
    expect(duplicate.result.outcome).toBe("already_applied");
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("maps changed-digest reuse to the canonical no-dispatch error without disturbing replay", async () => {
    const { client, browser } = makeClient();
    const original = await client.connect("principal-a", connectInput());

    const conflict = await expectClientError(
      client.connect("principal-a", connectInput({ timeout_ms: 6_000 })),
      "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    );

    expect(conflict).toMatchObject({
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
    });
    const replayed = await client.connect("principal-a", connectInput());
    expect(replayed).toEqual({
      ...original,
      result: { ...original.result, outcome: "already_applied" },
    });
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("authorizes before replay and does not return a stored session after permission revocation", async () => {
    let permissions = BASE_PERMISSIONS;
    const { client, browser } = makeClient({
      permissionsForPrincipal: () => permissions,
    });
    await client.connect("principal-a", connectInput());
    permissions = [];

    await expectClientError(
      client.connect("principal-a", connectInput()),
      "PERMISSION_DENIED",
    );

    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("classifies an incomplete request-ledger cache as unknown without plane admission", async () => {
    const scheduler = new FakeScheduler();
    const { client, browser } = makeClient({
      scheduler,
      requestLedger: new RequestLedger({
        ttlMs: 60_000,
        maxEntries: 50,
        now: scheduler.now,
        cacheKnownComplete: false,
      }),
    });

    const error = await expectClientError(
      client.connect("principal-a", connectInput()),
      "MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error.outcome).toBe("unknown");
    expect(browser.events).toHaveLength(0);
  });

  it("maps ledger capacity to a retryable admission error without a plane call or phantom reservation", async () => {
    const requestLedger = new RequestLedger({
      ttlMs: 60_000,
      maxEntries: 1,
    });
    const occupied = requestLedger.acquire(
      {
        principal: "principal-b",
        configuredDevice: "configured-device-a",
        tool: "jetkvm_session_connect",
        requestId: "occupied-request",
      },
      { takeover: false, timeout_ms: 5_000 },
    );
    if (occupied.kind !== "acquired") {
      throw new Error("expected the setup reservation to be acquired");
    }
    const { client, browser } = makeClient({ requestLedger });

    const capacity = await expectClientError(
      client.connect("principal-a", connectInput()),
      "ADMISSION_CAPACITY_EXCEEDED",
    );

    expect(capacity).toMatchObject({
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "none",
    });
    expect(browser.events).toHaveLength(0);
    expect(requestLedger.size).toBe(1);
    expect(requestLedger.release(occupied.reservation, "not_sent")).toBe(true);

    const retried = await client.connect("principal-a", connectInput());
    expect(retried.result.outcome).toBe("applied");
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("returns CONTROL_BUSY without takeover and leaves the incumbent unchanged", async () => {
    const { client, browser } = makeClient();
    const incumbent = await client.connect("principal-a", connectInput());

    const error = await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2" }),
      ),
      "CONTROL_BUSY",
    );

    expect(error).toMatchObject({
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "wait_or_request_takeover",
    });
    expect(
      browser.events.filter((event) => event.kind === "close"),
    ).toHaveLength(0);
    expect(client.resolveSession("principal-a", incumbent.ref).state).toBe(
      "ready",
    );
  });

  it("rejects unauthorized takeover before changing incumbent ownership", async () => {
    const { client, browser } = makeClient();
    const incumbent = await client.connect("principal-a", connectInput());

    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2", takeover: true }),
      ),
      "PERMISSION_DENIED",
    );

    expect(
      browser.events.filter((event) => event.kind === "close"),
    ).toHaveLength(0);
    expect(client.resolveSession("principal-a", incumbent.ref).state).toBe(
      "ready",
    );
  });

  it("plumbs authorized takeover by closing the incumbent before publishing the successor", async () => {
    const { client, browser } = makeClient({
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    const incumbent = await client.connect("principal-a", connectInput());

    const successor = await client.connect(
      "principal-b",
      connectInput({ request_id: "connect-request-2", takeover: true }),
    );

    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual([
      "connect:app-session-1",
      "close:app-session-1",
      "connect:app-session-2",
    ]);
    expect(successor.result.takeover_performed).toBe(true);
    const error = await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", incumbent.ref),
      ),
      "SESSION_TAKEN_OVER",
    );
    expect(error.outcome).toBe("not_sent");
  });

  it("never republishes the incumbent when takeover cleanup fails", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({
      browser,
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    const incumbent = await client.connect("principal-a", connectInput());
    browser.rejectClose = new Error("cleanup failed");

    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2", takeover: true }),
      ),
      "CONNECTION_LOST",
    );

    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", incumbent.ref),
      ),
      "SESSION_TAKEN_OVER",
    );
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("keeps a failed takeover cleanup authoritative and blocks a new connection", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({
      browser,
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    await client.connect("principal-a", connectInput());
    browser.rejectClose = new Error("cleanup failed");

    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2", takeover: true }),
      ),
      "CONNECTION_LOST",
    );
    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-3" }),
      ),
      "CONTROL_BUSY",
    );

    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual(["connect:app-session-1", "close:app-session-1"]);
  });

  it("retains unknown after takeover starts even when cleanup reports not_sent", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({
      browser,
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    await client.connect("principal-a", connectInput());
    browser.rejectClose = new DeviceSessionPlaneError(
      "DEVICE_UNREACHABLE",
      "not_sent",
    );
    const takeoverInput = connectInput({
      request_id: "connect-request-2",
      takeover: true,
    });

    const firstError = await expectClientError(
      client.connect("principal-b", takeoverInput),
      "DEVICE_UNREACHABLE",
    );
    expect(firstError.outcome).toBe("unknown");
    browser.rejectClose = null;

    await expectClientError(
      client.connect("principal-b", takeoverInput),
      "MUTATION_OUTCOME_UNKNOWN",
    );
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
  });

  it("keeps a failed reconnect close authoritative until a takeover proves cleanup", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({
      browser,
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    const connected = await client.connect("principal-a", connectInput());
    browser.rejectClose = new Error("reconnect close failed");

    await expectClientError(
      client.reconnect("principal-a", reconnectInput(connected.ref)),
      "CONNECTION_LOST",
    );
    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2" }),
      ),
      "CONTROL_BUSY",
    );
    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual(["connect:app-session-1", "close:app-session-1"]);

    browser.rejectClose = null;
    const recovered = await client.connect(
      "principal-b",
      connectInput({ request_id: "connect-request-3", takeover: true }),
    );

    expect(recovered.result.takeover_performed).toBe(true);
    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual([
      "connect:app-session-1",
      "close:app-session-1",
      "close:app-session-1",
      "connect:app-session-2",
    ]);
  });

  it("maps changed-digest reconnect reuse without another plane call or replay loss", async () => {
    const { client, browser } = makeClient();
    const connected = await client.connect("principal-a", connectInput());
    const input = reconnectInput(connected.ref);
    const original = await client.reconnect("principal-a", input);
    const callsAfterOriginal = browser.events.length;

    const conflict = await expectClientError(
      client.reconnect(
        "principal-a",
        reconnectInput(connected.ref, { timeout_ms: 6_000 }),
      ),
      "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    );

    expect(conflict).toMatchObject({
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "none",
    });
    const replayed = await client.reconnect("principal-a", input);
    expect(replayed).toEqual({
      ...original,
      result: { ...original.result, outcome: "already_applied" },
    });
    expect(browser.events).toHaveLength(callsAfterOriginal);
  });

  it("maps reconnect ledger capacity without a plane call or phantom reservation", async () => {
    const requestLedger = new RequestLedger({
      ttlMs: 60_000,
      maxEntries: 2,
    });
    const { client, browser } = makeClient({ requestLedger });
    const connected = await client.connect("principal-a", connectInput());
    const occupied = requestLedger.acquire(
      {
        principal: "principal-b",
        configuredDevice: "configured-device-a",
        tool: "jetkvm_session_connect",
        requestId: "occupied-request",
      },
      { takeover: false, timeout_ms: 5_000 },
    );
    if (occupied.kind !== "acquired") {
      throw new Error("expected the setup reservation to be acquired");
    }
    const callsBeforeCapacity = browser.events.length;

    const capacity = await expectClientError(
      client.reconnect("principal-a", reconnectInput(connected.ref)),
      "ADMISSION_CAPACITY_EXCEEDED",
    );

    expect(capacity).toMatchObject({
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "none",
    });
    expect(browser.events).toHaveLength(callsBeforeCapacity);
    expect(requestLedger.size).toBe(2);
    expect(requestLedger.release(occupied.reservation, "not_sent")).toBe(true);

    const retried = await client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );
    expect(retried.result.outcome).toBe("applied");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
      "reconnect",
    ]);
  });

  it("rotates generation on reconnect and rejects the old generation without a plane call", async () => {
    const { client, browser } = makeClient();
    const connected = await client.connect("principal-a", connectInput());

    const reconnected = await client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );

    expect(reconnected).toEqual({
      ref: { sessionId: connected.ref.sessionId, sessionGeneration: 2 },
      result: {
        request_id: "reconnect-request-1",
        outcome: "applied",
        verification: "device_state_verified",
        safe_to_retry: false,
        required_next_step: "none",
        previous_session_generation: 1,
        new_session_generation: 2,
        connection_epoch: 11,
        state: "ready",
        takeover_performed: false,
        fresh_capture_required: true,
      },
    });
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
      "reconnect",
    ]);

    const callsBeforeStaleRequest = browser.events.length;
    const stale = await expectClientError(
      client.reconnect(
        "principal-a",
        reconnectInput(connected.ref, { request_id: "reconnect-request-2" }),
      ),
      "STALE_SESSION_GENERATION",
    );
    expect(stale).toMatchObject({
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    });
    expect(browser.events).toHaveLength(callsBeforeStaleRequest);
  });

  it("checks session ownership before returning a reconnect replay", async () => {
    const { client, browser } = makeClient();
    const connected = await client.connect("principal-a", connectInput());
    await client.reconnect("principal-a", reconnectInput(connected.ref));

    const missing = await expectClientError(
      client.reconnect("principal-b", reconnectInput(connected.ref)),
      "SESSION_NOT_FOUND",
    );
    expect(missing).toMatchObject({
      outcome: "not_sent",
      safeToRetry: false,
      requiredNextStep: "reconnect_then_capture",
    });

    expect(
      browser.events.filter((event) => event.kind === "reconnect"),
    ).toHaveLength(1);
  });

  it("requires reconnect to advance both connection and browser-channel generations", async () => {
    const browser = new FakeBrowserPlane();
    browser.advanceReconnectEvidence = false;
    const { client } = makeClient({ browser });
    const connected = await client.connect("principal-a", connectInput());

    await expectClientError(
      client.reconnect("principal-a", reconnectInput(connected.ref)),
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          ...connected.ref,
          sessionGeneration: 2,
        }),
      ),
      "SESSION_DRAINED",
    );
  });

  it("keeps ordinary reconnect unknown after the old generation is fenced", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({ browser });
    const connected = await client.connect("principal-a", connectInput());
    browser.reconnectFailure = new DeviceSessionPlaneError(
      "DEVICE_UNREACHABLE",
      "not_sent",
    );
    const input = reconnectInput(connected.ref);

    const firstError = await expectClientError(
      client.reconnect("principal-a", input),
      "DEVICE_UNREACHABLE",
    );
    expect(firstError.outcome).toBe("unknown");
    browser.reconnectFailure = null;

    await expectClientError(
      client.reconnect("principal-a", input),
      "MUTATION_OUTCOME_UNKNOWN",
    );
    expect(
      browser.events.filter((event) => event.kind === "reconnect"),
    ).toHaveLength(1);
  });

  it("reprobes connection capabilities before publishing a reconnected generation", async () => {
    let capabilityProbes = 0;
    const { client } = makeClient({
      capabilitiesForConnection: async () => {
        capabilityProbes += 1;
        return ALL_CAPABILITIES;
      },
    });
    const connected = await client.connect("principal-a", connectInput());

    await client.reconnect("principal-a", reconnectInput(connected.ref));

    expect(capabilityProbes).toBe(2);
  });

  it("allows an explicitly authorized reconnect takeover without automatic reclaim", async () => {
    const { client, browser } = makeClient({
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
    });
    const first = await client.connect("principal-a", connectInput());
    await client.connect(
      "principal-b",
      connectInput({ request_id: "connect-request-2", takeover: true }),
    );

    const reclaimed = await client.reconnect(
      "principal-a",
      reconnectInput(first.ref, { takeover: true }),
    );

    expect(reclaimed.ref).toEqual({
      sessionId: first.ref.sessionId,
      sessionGeneration: 2,
    });
    expect(reclaimed.result.takeover_performed).toBe(true);
    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual([
      "connect:app-session-1",
      "close:app-session-1",
      "connect:app-session-2",
      "close:app-session-2",
      "reconnect:app-session-1",
    ]);
  });

  it("rejects a same-valued but distinct Browser-owned adapter on connect", async () => {
    const browser = new FakeBrowserPlane();
    const originalConnect = browser.connect.bind(browser);
    browser.connect = async (ref, deadline) => {
      const connection = await originalConnect(ref, deadline);
      return {
        ...connection,
        deviceRpc: {
          binding: { ...connection.deviceRpc.binding },
        } as DeviceRpcAdapter,
      };
    };
    let capabilityProbes = 0;
    const { client } = makeClient({
      browser,
      capabilitiesForConnection: async () => {
        capabilityProbes += 1;
        return ALL_CAPABILITIES;
      },
    });

    const error = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    expect(error.outcome).toBe("unknown");
    expect(capabilityProbes).toBe(0);
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
  });

  it("rejects a same-valued but distinct adapter after reconnect invalidates the old bundle", async () => {
    const browser = new FakeBrowserPlane();
    let capabilityProbes = 0;
    const { client } = makeClient({
      browser,
      capabilitiesForConnection: async () => {
        capabilityProbes += 1;
        return ALL_CAPABILITIES;
      },
    });
    const connected = await client.connect("principal-a", connectInput());
    const oldAdapter = browser.deviceRpc;
    const originalReconnect = browser.reconnect.bind(browser);
    browser.reconnect = async (ref, deadline) => {
      const connection = await originalReconnect(ref, deadline);
      return {
        ...connection,
        deviceRpc: {
          binding: { ...connection.deviceRpc.binding },
        } as DeviceRpcAdapter,
      };
    };

    const error = await expectClientError(
      client.reconnect("principal-a", reconnectInput(connected.ref)),
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    expect(error.outcome).toBe("unknown");
    expect(capabilityProbes).toBe(1);
    expect(browser.deviceRpc).not.toBe(oldAdapter);
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
      "reconnect",
      "close",
    ]);
    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          ...connected.ref,
          sessionGeneration: 2,
        }),
      ),
      "SESSION_DRAINED",
    );
  });

  it("continues across fresh frozen equal session and binding snapshots", async () => {
    const browser = new FakeBrowserPlane();
    const originalConnect = browser.connect.bind(browser);
    browser.connect = async (ref, deadline) => {
      const connection = await originalConnect(ref, deadline);
      const refValue = { ...connection.ref };
      const bindingValue = { ...connection.binding };
      const deviceRpc = Object.freeze({
        get binding() {
          return Object.freeze({ ...bindingValue });
        },
      }) as DeviceRpcAdapter;
      browser.deviceRpc = deviceRpc;
      return {
        get ref() {
          return Object.freeze({ ...refValue });
        },
        get binding() {
          return Object.freeze({ ...bindingValue });
        },
        deviceRpc,
        state: connection.state,
        connectionEpoch: connection.connectionEpoch,
        browserChannelGeneration: connection.browserChannelGeneration,
        displayGeneration: connection.displayGeneration,
      };
    };
    const { client } = makeClient({ browser });

    const connected = await client.connect("principal-a", connectInput());

    expect(connected.result).toMatchObject({
      outcome: "applied",
      connection_epoch: 10,
      display_generation: 20,
    });
    expect(browser.events.map((event) => event.kind)).toEqual(["connect"]);
  });

  it("rejects connection evidence mutated coherently during capability qualification", async () => {
    const browser = new FakeBrowserPlane();
    const originalConnect = browser.connect.bind(browser);
    let opened: BrowserConnection | undefined;
    browser.connect = async (ref, deadline) => {
      opened = await originalConnect(ref, deadline);
      return opened;
    };
    const probeStarted = Promise.withResolvers<void>();
    const capabilities = Promise.withResolvers<CapabilitySnapshot>();
    const { client } = makeClient({
      browser,
      capabilitiesForConnection: async () => {
        probeStarted.resolve();
        return capabilities.promise;
      },
    });
    const pending = client.connect("principal-a", connectInput());
    await probeStarted.promise;
    if (opened === undefined) {
      throw new Error("expected the browser connection to be captured");
    }
    const replacementBinding = {
      ...opened.binding,
      connectionEpoch: opened.connectionEpoch + 1,
    };
    Object.assign(opened, {
      binding: replacementBinding,
      connectionEpoch: replacementBinding.connectionEpoch,
    });
    Object.assign(opened.deviceRpc, { binding: replacementBinding });
    capabilities.resolve(ALL_CAPABILITIES);

    const error = await expectClientError(
      pending,
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    expect(error.outcome).toBe("unknown");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
  });

  it("rejects Browser-owned adapter replacement during reconnect qualification", async () => {
    const browser = new FakeBrowserPlane();
    const secondProbeStarted = Promise.withResolvers<void>();
    const secondCapabilities = Promise.withResolvers<CapabilitySnapshot>();
    let capabilityProbes = 0;
    const { client } = makeClient({
      browser,
      capabilitiesForConnection: async () => {
        capabilityProbes += 1;
        if (capabilityProbes === 1) {
          return ALL_CAPABILITIES;
        }
        secondProbeStarted.resolve();
        return secondCapabilities.promise;
      },
    });
    const connected = await client.connect("principal-a", connectInput());
    const pending = client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );
    await secondProbeStarted.promise;
    browser.deviceRpc = {
      binding: { ...browser.deviceRpc.binding },
    } as DeviceRpcAdapter;
    secondCapabilities.resolve(ALL_CAPABILITIES);

    const error = await expectClientError(
      pending,
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    expect(error.outcome).toBe("unknown");
    expect(capabilityProbes).toBe(2);
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
      "reconnect",
      "close",
    ]);
    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          ...connected.ref,
          sessionGeneration: 2,
        }),
      ),
      "SESSION_DRAINED",
    );
  });

  it("accepts one synchronized Browser-owned replacement adapter on reconnect", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({ browser });
    const connected = await client.connect("principal-a", connectInput());
    const oldAdapter = browser.deviceRpc;

    const reconnected = await client.reconnect(
      "principal-a",
      reconnectInput(connected.ref),
    );

    expect(browser.deviceRpc).not.toBe(oldAdapter);
    expect(reconnected.result).toMatchObject({
      outcome: "applied",
      new_session_generation: 2,
      connection_epoch: 11,
    });
    expect(client.resolveSession("principal-a", reconnected.ref).state).toBe(
      "ready",
    );
  });

  it.each(["connectionEpoch", "browserChannelGeneration"] as const)(
    "rejects a zero %s before publishing the connection",
    async (field) => {
      const browser = new FakeBrowserPlane();
      const originalConnect = browser.connect.bind(browser);
      browser.connect = async (ref, deadline) => {
        const connection = await originalConnect(ref, deadline);
        return {
          ...connection,
          [field]: 0,
          binding: { ...connection.binding, [field]: 0 },
          deviceRpc: {
            binding: { ...connection.deviceRpc.binding, [field]: 0 },
          } as DeviceRpcAdapter,
        };
      };
      const { client } = makeClient({ browser });

      const error = await expectClientError(
        client.connect("principal-a", connectInput()),
        "DOWNSTREAM_MALFORMED_RESPONSE",
      );

      expect(error).toMatchObject({
        outcome: "unknown",
        safeToRetry: false,
        requiredNextStep: "inspect_device_state_before_retry",
      });
      expect(browser.events.map((event) => event.kind)).toEqual([
        "connect",
        "close",
      ]);
    },
  );

  it("accepts display generation zero independently of positive connection generations", async () => {
    const browser = new FakeBrowserPlane();
    browser.displayGeneration = 0;
    const { client } = makeClient({ browser });

    const connected = await client.connect("principal-a", connectInput());

    expect(connected.result.display_generation).toBe(0);
    expect(client.resolveSession("principal-a", connected.ref)).toMatchObject({
      state: "ready",
      displayGeneration: 0,
      connectionEpoch: 10,
      browserChannelGeneration: 30,
    });
  });

  it("rejects mismatched connection evidence rather than publishing ready", async () => {
    const browser = new FakeBrowserPlane();
    const originalReconnect = browser.reconnect.bind(browser);
    browser.reconnect = async (ref, deadline) => {
      const connection = await originalReconnect(ref, deadline);
      return {
        ...connection,
        ref: { ...ref, sessionGeneration: ref.sessionGeneration + 1 },
      };
    };
    const { client } = makeClient({ browser });
    const connected = await client.connect("principal-a", connectInput());

    await expectClientError(
      client.reconnect("principal-a", reconnectInput(connected.ref)),
      "DOWNSTREAM_MALFORMED_RESPONSE",
    );

    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          ...connected.ref,
          sessionGeneration: 2,
        }),
      ),
      "SESSION_DRAINED",
    );
  });

  it("closes a newly opened browser connection when post-connect qualification fails", async () => {
    const browser = new FakeBrowserPlane();
    const { client } = makeClient({
      browser,
      capabilitiesForConnection: async () => {
        throw new Error("capability probe failed");
      },
    });

    const error = await expectClientError(
      client.connect("principal-a", connectInput()),
      "CONNECTION_LOST",
    );

    expect(error.outcome).toBe("unknown");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
  });

  it("blocks a second connection after qualification cleanup fails until authoritative close", async () => {
    const browser = new FakeBrowserPlane();
    browser.rejectClose = new Error("cleanup close failed");
    let rejectCapabilities = true;
    const { client } = makeClient({
      browser,
      permissions: [...BASE_PERMISSIONS, "session.takeover"],
      capabilitiesForConnection: async () => {
        if (rejectCapabilities) {
          throw new DeviceSessionPlaneError("DEVICE_UNREACHABLE", "not_sent");
        }
        return ALL_CAPABILITIES;
      },
    });
    const cleanupFailure = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DEVICE_UNREACHABLE",
    );
    expect(cleanupFailure.outcome).toBe("unknown");
    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          sessionId: "app-session-1",
          sessionGeneration: 1,
        }),
      ),
      "SESSION_DRAINED",
    );
    await expectClientError(
      client.connect("principal-a", connectInput()),
      "MUTATION_OUTCOME_UNKNOWN",
    );
    rejectCapabilities = false;
    browser.rejectClose = null;

    await expectClientError(
      client.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2" }),
      ),
      "CONTROL_BUSY",
    );
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);

    const recovered = await client.connect(
      "principal-b",
      connectInput({ request_id: "connect-request-3", takeover: true }),
    );
    expect(recovered.result.takeover_performed).toBe(true);
    expect(
      browser.events.map((event) => `${event.kind}:${event.ref.sessionId}`),
    ).toEqual([
      "connect:app-session-1",
      "close:app-session-1",
      "close:app-session-1",
      "connect:app-session-2",
    ]);
  });

  it("does not publish ownership when the ledger reservation expires before completion", async () => {
    const scheduler = new FakeScheduler();
    const browser = new FakeBrowserPlane();
    browser.afterConnect = () => scheduler.advance(10);
    const { client } = makeClient({
      browser,
      scheduler,
      requestLedger: new RequestLedger({
        ttlMs: 10,
        maxEntries: 50,
        now: scheduler.now,
      }),
    });

    const error = await expectClientError(
      client.connect("principal-a", connectInput()),
      "MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error.outcome).toBe("unknown");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
    await expectClientError(
      Promise.resolve().then(() =>
        client.resolveSession("principal-a", {
          sessionId: "app-session-1",
          sessionGeneration: 1,
        }),
      ),
      "SESSION_NOT_FOUND",
    );
  });

  it("propagates caller abort to the injected plane", async () => {
    const browser = new FakeBrowserPlane();
    browser.holdConnect = true;
    const { client } = makeClient({ browser });
    const controller = new AbortController();

    const pending = client.connect(
      "principal-a",
      connectInput(),
      controller.signal,
    );
    await waitForBrowserAdmission(browser);
    controller.abort(new Error("caller cancelled"));

    const error = await expectClientError(pending, "CANCELLED");
    expect(error.outcome).toBe("unknown");
    expect(browser.lastConnectSignal?.aborted).toBe(true);
  });

  it("preserves a replay-shaped qualified failure and releases its not_sent reservation", async () => {
    const browser = new FakeBrowserPlane();
    browser.connectFailure = new ReplayRecordedError({
      code: "DEVICE_UNREACHABLE",
      boundary: "admission",
      outcome: "not_sent",
      writeBegan: false,
      acknowledged: false,
      verification: "none",
      safeToRetry: true,
      requiredNextStep: "reconnect_then_capture",
    });
    const { client } = makeClient({ browser });

    const failure = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DEVICE_UNREACHABLE",
    );

    expect(failure).toMatchObject({
      code: "DEVICE_UNREACHABLE",
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "reconnect_then_capture",
    });
    browser.connectFailure = null;

    const retried = await client.connect("principal-a", connectInput());

    expect(retried.result).toMatchObject({
      request_id: "connect-request-1",
      outcome: "applied",
    });
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(2);
  });

  it("releases a plane-classified not_sent reservation for a safe same-ID retry", async () => {
    const browser = new FakeBrowserPlane();
    browser.connectFailure = new DeviceSessionPlaneError(
      "DEVICE_UNREACHABLE",
      "not_sent",
    );
    const { client } = makeClient({ browser });

    const firstError = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DEVICE_UNREACHABLE",
    );
    expect(firstError.outcome).toBe("not_sent");
    browser.connectFailure = null;

    const retried = await client.connect("principal-a", connectInput());

    expect(retried.result.outcome).toBe("applied");
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(2);
  });

  it("bounds retained state across repeated safe not_sent connects and eventual success", async () => {
    const browser = new FakeBrowserPlane();
    browser.connectFailure = new DeviceSessionPlaneError(
      "DEVICE_UNREACHABLE",
      "not_sent",
    );
    const { client } = makeClient({ browser });
    const failedRefs: SessionRef[] = [];

    for (let attempt = 1; attempt <= 64; attempt += 1) {
      const failure = await expectClientError(
        client.connect("principal-a", connectInput()),
        "DEVICE_UNREACHABLE",
      );
      expect(failure.outcome).toBe("not_sent");
      failedRefs.push({
        sessionId: `app-session-${attempt}`,
        sessionGeneration: 1,
      });
    }

    browser.connectFailure = null;
    const connected = await client.connect("principal-a", connectInput());
    const retained = failedRefs.filter((ref) => {
      try {
        client.resolveSession("principal-a", ref);
        return true;
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceSessionClientError);
        const code = (error as DeviceSessionClientError).code;
        if (code === "SESSION_NOT_FOUND") {
          return false;
        }
        if (code === "SESSION_DRAINED") {
          return true;
        }
        throw error;
      }
    });

    expect(retained).toEqual([]);
    expect(connected.ref).toEqual({
      sessionId: "app-session-65",
      sessionGeneration: 1,
    });
    expect(connected.result.outcome).toBe("applied");
  });

  it("removes an opened not_sent attempt after successful cleanup", async () => {
    let failQualification = true;
    const { client, browser } = makeClient({
      createSessionId: () => "app-session-reused",
      capabilitiesForConnection: async () => {
        if (failQualification) {
          failQualification = false;
          throw new DeviceSessionPlaneError("DEVICE_UNREACHABLE", "not_sent");
        }
        return ALL_CAPABILITIES;
      },
    });

    const failure = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DEVICE_UNREACHABLE",
    );
    expect(failure.outcome).toBe("not_sent");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);

    const connected = await client.connect("principal-a", connectInput());
    expect(client.resolveSession("principal-a", connected.ref).state).toBe(
      "ready",
    );
  });

  it("removes an unknown attempt only after successful cleanup", async () => {
    const browser = new FakeBrowserPlane();
    browser.connectFailure = new DeviceSessionPlaneError(
      "DEVICE_UNREACHABLE",
      "unknown",
    );
    const { client } = makeClient({
      browser,
      createSessionId: () => "app-session-reused",
    });

    const failure = await expectClientError(
      client.connect("principal-a", connectInput()),
      "DEVICE_UNREACHABLE",
    );
    expect(failure.outcome).toBe("unknown");
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
    browser.connectFailure = null;

    const connected = await client.connect(
      "principal-a",
      connectInput({ request_id: "connect-request-2" }),
    );
    expect(client.resolveSession("principal-a", connected.ref).state).toBe(
      "ready",
    );
  });

  it("does not let delayed cleanup from an old attempt erase its successor", async () => {
    const browser = new FakeBrowserPlane();
    const cleanup = Promise.withResolvers<void>();
    const originalClose = browser.close.bind(browser);
    browser.close = async (ref, deadline) => {
      await originalClose(ref, deadline);
      await cleanup.promise;
    };
    let failQualification = true;
    const { client } = makeClient({
      browser,
      createSessionId: () => "app-session-reused",
      capabilitiesForConnection: async () => {
        if (failQualification) {
          failQualification = false;
          throw new Error("qualification failed");
        }
        return ALL_CAPABILITIES;
      },
    });

    const oldAttempt = client.connect("principal-a", connectInput());
    for (
      let attempt = 0;
      attempt < 10 && !browser.events.some((event) => event.kind === "close");
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(browser.events.map((event) => event.kind)).toEqual([
      "connect",
      "close",
    ]);
    const successor = client.connect(
      "principal-a",
      connectInput({ request_id: "connect-request-2" }),
    );

    cleanup.resolve();
    const oldFailure = await expectClientError(oldAttempt, "CONNECTION_LOST");
    expect(oldFailure.outcome).toBe("unknown");
    const connected = await successor;

    expect(client.resolveSession("principal-a", connected.ref)).toMatchObject({
      ref: connected.ref,
      state: "ready",
    });
  });

  it("rejects an already-aborted caller promptly while another session call owns the lock", async () => {
    const scheduler = new FakeScheduler();
    const requestLedger = new RequestLedger({
      ttlMs: 60_000,
      maxEntries: 10,
      now: scheduler.now,
    });
    const browser = new FakeBrowserPlane();
    browser.holdConnect = true;
    const { client } = makeClient({ browser, scheduler, requestLedger });
    const firstController = new AbortController();
    const first = client.connect(
      "principal-a",
      connectInput(),
      firstController.signal,
    );
    await waitForBrowserAdmission(browser);

    const secondController = new AbortController();
    secondController.abort(new Error("cancelled before lock admission"));
    let secondSettled = false;
    const second = client
      .connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2" }),
        secondController.signal,
      )
      .then(
        () => {
          secondSettled = true;
          return null;
        },
        (error: unknown) => {
          secondSettled = true;
          return error;
        },
      );
    for (let attempt = 0; attempt < 5 && !secondSettled; attempt += 1) {
      await Promise.resolve();
    }
    const settledWhileLocked = secondSettled;
    const ledgerSizeWhileLocked = requestLedger.size;

    firstController.abort(new Error("release first lock owner"));
    const firstError = await expectClientError(first, "CANCELLED");
    const secondError = await second;

    expect(settledWhileLocked).toBe(true);
    expect(ledgerSizeWhileLocked).toBe(1);
    expect(firstError.outcome).toBe("unknown");
    expect(secondError).toBeInstanceOf(DeviceSessionClientError);
    expect(secondError).toMatchObject({
      code: "CANCELLED",
      outcome: "not_sent",
      safeToRetry: true,
      requiredNextStep: "none",
    });
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
    expect(requestLedger.size).toBe(1);
    browser.holdConnect = false;
    const recovered = await client.connect(
      "principal-c",
      connectInput({ request_id: "connect-request-3" }),
    );
    expect(recovered.result.outcome).toBe("applied");
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(2);
  });

  it("rejects an already-aborted request without calling the plane", async () => {
    const { client, browser } = makeClient();
    const controller = new AbortController();
    controller.abort();

    const error = await expectClientError(
      client.connect("principal-a", connectInput(), controller.signal),
      "CANCELLED",
    );

    expect(error.outcome).toBe("not_sent");
    expect(browser.events).toHaveLength(0);
  });

  it.each(["request id", "-request", `r${"a".repeat(128)}`])(
    "rejects a noncanonical connect request ID %s before ledger or plane admission",
    async (requestId) => {
      const requestLedger = new RequestLedger({
        ttlMs: 60_000,
        maxEntries: 10,
      });
      const { client, browser } = makeClient({ requestLedger });

      await expect(
        client.connect("principal-a", connectInput({ request_id: requestId })),
      ).rejects.toThrow(/request ID must be canonical/i);
      expect(requestLedger.size).toBe(0);
      expect(browser.events).toHaveLength(0);
    },
  );

  it("rejects noncanonical reconnect session and request IDs before ledger or plane admission", async () => {
    const { client, browser } = makeClient();
    const connected = await client.connect("principal-a", connectInput());
    const callsBeforeInvalid = browser.events.length;

    await expect(
      client.reconnect(
        "principal-a",
        reconnectInput(connected.ref, { request_id: "request id" }),
      ),
    ).rejects.toThrow(/request ID must be canonical/i);
    await expect(
      client.reconnect("principal-a", {
        ...reconnectInput(connected.ref, { request_id: "reconnect-request-2" }),
        session_id: "-session",
      }),
    ).rejects.toThrow(/session ID must be canonical/i);
    expect(browser.events).toHaveLength(callsBeforeInvalid);
  });

  it("accepts the 128-character connect request ID boundary", async () => {
    const requestId = `r${"a".repeat(127)}`;
    const { client } = makeClient();

    const connected = await client.connect(
      "principal-a",
      connectInput({ request_id: requestId }),
    );

    expect(connected.result.request_id).toBe(requestId);
  });

  it("enforces timeout bounds before plane admission", async () => {
    const { client, browser } = makeClient();

    await expectClientError(
      client.connect("principal-a", connectInput({ timeout_ms: 99 })),
      "DEADLINE_EXCEEDED",
    );
    await expectClientError(
      client.connect(
        "principal-a",
        connectInput({ request_id: "connect-request-2", timeout_ms: 60_001 }),
      ),
      "DEADLINE_EXCEEDED",
    );
    expect(browser.events).toHaveLength(0);
  });

  it("uses one bounded monotonic deadline and aborts a plane call at expiry", async () => {
    const browser = new FakeBrowserPlane();
    browser.holdConnect = true;
    const scheduler = new FakeScheduler();
    const { client } = makeClient({ browser, scheduler });

    const pending = client.connect(
      "principal-a",
      connectInput({ timeout_ms: 100 }),
    );
    await waitForBrowserAdmission(browser);
    expect(browser.events[0]?.deadline.timeoutMs).toBeLessThanOrEqual(100);
    scheduler.advance(100);

    const error = await expectClientError(pending, "DEADLINE_EXCEEDED");
    expect(error.outcome).toBe("unknown");
    expect(browser.lastConnectSignal?.aborted).toBe(true);
  });

  it("closing and reopening an SSE carrier cannot mint, steal, or transfer ownership", async () => {
    const { client, browser } = makeClient();
    const openCarrier = (transportSessionId: string) => ({
      transportSessionId,
      connect: (principal: string, input: SessionConnectInput) =>
        client.connect(principal, input),
    });

    const firstCarrier = openCarrier("sse-routing-id-1");
    const incumbent = await firstCarrier.connect("principal-a", connectInput());
    // Closing a protocol carrier deliberately has no DeviceSessionClient operation.
    const secondCarrier = openCarrier("sse-routing-id-2");

    await expectClientError(
      secondCarrier.connect(
        "principal-b",
        connectInput({ request_id: "connect-request-2" }),
      ),
      "CONTROL_BUSY",
    );

    expect(client.resolveSession("principal-a", incumbent.ref).state).toBe(
      "ready",
    );
    expect(
      browser.events.filter((event) => event.kind === "connect"),
    ).toHaveLength(1);
    expect(
      browser.events.filter((event) => event.kind === "close"),
    ).toHaveLength(0);
  });
});
