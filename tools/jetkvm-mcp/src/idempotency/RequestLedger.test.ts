import { describe, expect, it } from "vitest";

import {
  RequestLedger,
  canonicalInputDigest,
  type ConnectRequestLedgerKey,
  type LedgerTerminal,
  type RequestLedgerKey,
  type SessionRequestLedgerKey,
} from "./RequestLedger.js";

const sessionKey = (
  overrides: Partial<SessionRequestLedgerKey> = {},
): SessionRequestLedgerKey => ({
  sessionId: "session-a",
  sessionGeneration: 3,
  tool: "jetkvm_input_mouse",
  requestId: "request-a",
  ...overrides,
});

const connectKey = (
  overrides: Partial<ConnectRequestLedgerKey> = {},
): ConnectRequestLedgerKey => ({
  principal: "principal-a",
  configuredDevice: "device-a",
  tool: "jetkvm_session_connect",
  requestId: "request-a",
  ...overrides,
});

const applied = <T>(
  value: T,
  verification: "device_ack_only" | "device_state_verified" = "device_ack_only",
): LedgerTerminal<T> => ({
  outcome: "applied",
  verification,
  value,
});

const unknown = <T>(value: T): LedgerTerminal<T> => ({
  outcome: "unknown",
  verification: "none",
  value,
});

const notSent = <T>(value: T): LedgerTerminal<T> => ({
  outcome: "not_sent",
  verification: "none",
  value,
});

class FakeClock {
  nowMs = 1_000;

  now = (): number => this.nowMs;

  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
  }
}

function acquire(
  ledger: RequestLedger,
  key: RequestLedgerKey = sessionKey(),
  input: unknown = { x: 10, y: 20 },
) {
  const decision = ledger.acquire(key, input);
  expect(decision.kind).toBe("acquired");
  if (decision.kind !== "acquired") {
    throw new Error(`expected acquired, received ${decision.kind}`);
  }
  return decision.reservation;
}

describe("canonicalInputDigest", () => {
  it("produces the same digest for recursively reordered normalized object keys", () => {
    expect(
      canonicalInputDigest({
        timeout_ms: 5_000,
        action: { y: 2, x: 1 },
        modifiers: ["CTRL", "SHIFT"],
      }),
    ).toBe(
      canonicalInputDigest({
        modifiers: ["CTRL", "SHIFT"],
        action: { x: 1, y: 2 },
        timeout_ms: 5_000,
      }),
    );
  });

  it("distinguishes array order and rejects values outside normalized JSON", () => {
    expect(canonicalInputDigest({ keys: ["CTRL", "A"] })).not.toBe(
      canonicalInputDigest({ keys: ["A", "CTRL"] }),
    );
    expect(() => canonicalInputDigest({ value: undefined })).toThrow(
      /normalized JSON/i,
    );
    expect(() =>
      canonicalInputDigest({ value: Number.POSITIVE_INFINITY }),
    ).toThrow(/normalized JSON/i);
  });
});

describe("RequestLedger", () => {
  it("scopes session requests by exactly session ID, generation, tool, and request ID", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 20 });
    acquire(ledger);

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 }).kind).toBe(
      "in_flight",
    );
    expect(
      ledger.acquire(sessionKey({ sessionGeneration: 4 }), { x: 10, y: 20 })
        .kind,
    ).toBe("acquired");
    expect(
      ledger.acquire(sessionKey({ tool: "jetkvm_input_keyboard" }), {
        x: 10,
        y: 20,
      }).kind,
    ).toBe("acquired");
    expect(
      ledger.acquire(sessionKey({ requestId: "request-b" }), { x: 10, y: 20 })
        .kind,
    ).toBe("acquired");
    expect(
      ledger.acquire(sessionKey({ sessionId: "session-b" }), { x: 10, y: 20 })
        .kind,
    ).toBe("acquired");
  });

  it("scopes connect requests by exactly principal, configured device, tool, and request ID", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 20 });
    acquire(ledger, connectKey(), { takeover: false, timeout_ms: 10_000 });

    expect(
      ledger.acquire(connectKey(), { takeover: false, timeout_ms: 10_000 })
        .kind,
    ).toBe("in_flight");
    expect(
      ledger.acquire(connectKey({ principal: "principal-b" }), {
        takeover: false,
        timeout_ms: 10_000,
      }).kind,
    ).toBe("acquired");
    expect(
      ledger.acquire(connectKey({ configuredDevice: "device-b" }), {
        takeover: false,
        timeout_ms: 10_000,
      }).kind,
    ).toBe("acquired");
    expect(
      ledger.acquire(connectKey({ requestId: "request-b" }), {
        takeover: false,
        timeout_ms: 10_000,
      }).kind,
    ).toBe("acquired");
  });

  it("rejects keys with fields outside the exact connect or session scope", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });

    expect(() =>
      ledger.acquire(
        { ...sessionKey(), principal: "unexpected" } as RequestLedgerKey,
        { x: 10, y: 20 },
      ),
    ).toThrow(/exact request-ledger key/i);
    expect(() =>
      ledger.acquire(
        {
          ...connectKey(),
          tool: "jetkvm_input_mouse",
        } as unknown as RequestLedgerKey,
        { takeover: false, timeout_ms: 10_000 },
      ),
    ).toThrow(/exact request-ledger key/i);
  });

  it("keeps the digest inside the entry rather than making changed input a new key", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    acquire(ledger);

    expect(ledger.acquire(sessionKey(), { x: 11, y: 20 })).toEqual({
      kind: "conflict",
      code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    });
    expect(ledger.size).toBe(1);
  });

  it("reports an in-flight duplicate without dispatching twice", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "in_flight",
    });
    expect(ledger.complete(reservation, applied({ receipt: "ack" }))).toBe(
      true,
    );
  });

  it("replays an applied result as already_applied and preserves the original value", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);
    const result = applied(
      { session_id: "issued-session", session_generation: 1, state: "ready" },
      "device_state_verified",
    );
    expect(ledger.complete(reservation, result)).toBe(true);

    expect(ledger.acquire(sessionKey(), { y: 20, x: 10 })).toEqual({
      kind: "replay",
      replayOutcome: "already_applied",
      terminal: result,
    });
  });

  it("persists a definitive ack with a failed post-read as applied/device_ack_only", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);
    const result = applied({ acknowledgement_id: "ack-1", post_read: null });
    ledger.complete(reservation, result);

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "replay",
      replayOutcome: "already_applied",
      terminal: result,
    });
  });

  it("persists unknown and never converts it into an automatic replay", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);
    const result = unknown({ downstream_stage: "write" });
    ledger.complete(reservation, result);

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "replay",
      replayOutcome: "unknown",
      terminal: result,
    });
  });

  it("can retain a definitive not_sent result", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);
    const result = notSent({ code: "PERMISSION_DENIED" });
    ledger.complete(reservation, result);

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "replay",
      replayOutcome: "not_sent",
      terminal: result,
    });
  });

  it("releases only the current not_sent reservation", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);

    expect(ledger.release(reservation, "applied" as "not_sent")).toBe(false);
    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 }).kind).toBe(
      "in_flight",
    );
    expect(ledger.release({ ...reservation, token: "wrong" }, "not_sent")).toBe(
      false,
    );
    expect(ledger.release(reservation, "not_sent")).toBe(true);
    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 }).kind).toBe(
      "acquired",
    );
  });

  it("persists terminal state before the response callback runs", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const reservation = acquire(ledger);
    const result = applied({ receipt: "ack" });

    const response = ledger.completeBeforeResponse(
      reservation,
      result,
      (terminal) => {
        expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
          kind: "replay",
          replayOutcome: "already_applied",
          terminal: result,
        });
        return { status: 200, terminal };
      },
    );

    expect(response).toEqual({ status: 200, terminal: result });
  });

  it("enforces a hard size bound without evicting terminal or in-flight evidence", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    const first = acquire(ledger, sessionKey({ requestId: "request-1" }));
    ledger.complete(first, applied({ receipt: "first" }));
    acquire(ledger, sessionKey({ requestId: "request-2" }));

    expect(
      ledger.acquire(sessionKey({ requestId: "request-3" }), { x: 10, y: 20 }),
    ).toEqual({ kind: "capacity_exceeded" });
    expect(ledger.size).toBe(2);
    expect(
      ledger.acquire(sessionKey({ requestId: "request-1" }), { x: 10, y: 20 })
        .kind,
    ).toBe("replay");
  });

  it("expires entries at the deterministic TTL boundary and reports cache loss", () => {
    const clock = new FakeClock();
    const ledger = new RequestLedger({
      ttlMs: 1_000,
      maxEntries: 2,
      now: clock.now,
    });
    const reservation = acquire(ledger);
    ledger.complete(reservation, applied({ receipt: "ack" }));

    clock.advance(999);
    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 }).kind).toBe("replay");
    clock.advance(1);
    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "cache_lost",
    });
    expect(ledger.size).toBe(0);
  });

  it("fails closed when initialized after cache loss rather than inferring not_sent", () => {
    const ledger = new RequestLedger({
      ttlMs: 60_000,
      maxEntries: 2,
      cacheKnownComplete: false,
    });

    expect(ledger.acquire(sessionKey(), { x: 10, y: 20 })).toEqual({
      kind: "cache_lost",
    });
  });

  it("does not persist normalized inputs, credentials, or payload text", () => {
    const ledger = new RequestLedger({ ttlMs: 60_000, maxEntries: 2 });
    acquire(ledger, connectKey(), {
      takeover: false,
      timeout_ms: 10_000,
      nested: { credential: "super-secret", payload: "private paste text" },
    });

    const persisted = JSON.stringify(ledger.snapshot());
    expect(persisted).not.toContain("super-secret");
    expect(persisted).not.toContain("private paste text");
    expect(persisted).not.toContain("credential");
    expect(persisted).not.toContain("payload");
    expect(persisted).toMatch(/[a-f0-9]{64}/);
  });
});
