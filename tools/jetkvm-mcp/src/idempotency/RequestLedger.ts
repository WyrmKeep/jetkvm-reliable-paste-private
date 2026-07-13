import { createHash } from "node:crypto";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";

export type SessionRequestLedgerKey = Readonly<{
  sessionId: string;
  sessionGeneration: number;
  tool: Exclude<JetKvmToolName, "jetkvm_session_connect">;
  requestId: string;
}>;

export type ConnectRequestLedgerKey = Readonly<{
  principal: string;
  configuredDevice: string;
  tool: "jetkvm_session_connect";
  requestId: string;
}>;

export type RequestLedgerKey =
  | SessionRequestLedgerKey
  | ConnectRequestLedgerKey;

export type LedgerTerminal<T> =
  | Readonly<{
      outcome: "applied";
      verification: "device_ack_only" | "device_state_verified";
      value: T;
    }>
  | Readonly<{
      outcome: "not_sent" | "unknown";
      verification: "none";
      value: T;
    }>;

export type LedgerReplayOutcome = "already_applied" | "not_sent" | "unknown";

export type LedgerReservation = Readonly<{
  key: RequestLedgerKey;
  digest: string;
  token: string;
}>;

export type LedgerAcquireDecision<T = unknown> =
  | Readonly<{ kind: "acquired"; reservation: LedgerReservation }>
  | Readonly<{ kind: "in_flight" }>
  | Readonly<{
      kind: "conflict";
      code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT";
    }>
  | Readonly<{
      kind: "replay";
      replayOutcome: LedgerReplayOutcome;
      terminal: LedgerTerminal<T>;
    }>
  | Readonly<{ kind: "capacity_exceeded" }>
  | Readonly<{ kind: "cache_lost" }>;

export interface RequestLedgerOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
  readonly cacheKnownComplete?: boolean;
}

type InFlightEntry = {
  readonly state: "in_flight";
  readonly key: RequestLedgerKey;
  readonly digest: string;
  readonly token: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

type TerminalEntry = {
  readonly state: "terminal";
  readonly key: RequestLedgerKey;
  readonly digest: string;
  readonly terminal: LedgerTerminal<unknown>;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

type Entry = InFlightEntry | TerminalEntry;

export type RequestLedgerSnapshot = Readonly<{
  cacheKnownComplete: boolean;
  size: number;
  entries: readonly Readonly<{
    key: RequestLedgerKey;
    digest: string;
    state: Entry["state"];
    createdAtMs: number;
    expiresAtMs: number;
    terminalOutcome: LedgerTerminal<unknown>["outcome"] | null;
  }>[];
}>;

function normalizedJson(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Input must contain only normalized JSON values");
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (seen.has(value)) {
        throw new TypeError("Input must contain only normalized JSON values");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
              throw new TypeError(
                "Input must contain only normalized JSON values",
              );
            }
            items.push(normalizedJson(value[index], seen));
          }
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Input must contain only normalized JSON values");
        }
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        return `{${keys
          .map(
            (key) =>
              `${JSON.stringify(key)}:${normalizedJson(object[key], seen)}`,
          )
          .join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError("Input must contain only normalized JSON values");
  }
}

export function canonicalInputDigest(normalizedInput: unknown): string {
  return createHash("sha256")
    .update(normalizedJson(normalizedInput, new Set()), "utf8")
    .digest("hex");
}

function isConnectKey(key: RequestLedgerKey): key is ConnectRequestLedgerKey {
  return "principal" in key;
}

function serializedKey(key: RequestLedgerKey): string {
  const fields = Object.keys(key).sort();
  if (isConnectKey(key)) {
    if (
      fields.join(",") !== "configuredDevice,principal,requestId,tool" ||
      key.tool !== "jetkvm_session_connect" ||
      key.principal.length === 0 ||
      key.configuredDevice.length === 0 ||
      key.requestId.length === 0
    ) {
      throw new TypeError("Expected an exact request-ledger key");
    }
    return JSON.stringify([
      "connect",
      key.principal,
      key.configuredDevice,
      key.tool,
      key.requestId,
    ]);
  }
  if (
    fields.join(",") !== "requestId,sessionGeneration,sessionId,tool" ||
    (key.tool as JetKvmToolName) === "jetkvm_session_connect" ||
    !JETKVM_TOOL_NAMES.includes(key.tool as JetKvmToolName) ||
    key.sessionId.length === 0 ||
    !Number.isSafeInteger(key.sessionGeneration) ||
    key.sessionGeneration < 0 ||
    key.requestId.length === 0
  ) {
    throw new TypeError("Expected an exact request-ledger key");
  }
  return JSON.stringify([
    "session",
    key.sessionId,
    key.sessionGeneration,
    key.tool,
    key.requestId,
  ]);
}

function cloneKey(key: RequestLedgerKey): RequestLedgerKey {
  return isConnectKey(key)
    ? {
        principal: key.principal,
        configuredDevice: key.configuredDevice,
        tool: key.tool,
        requestId: key.requestId,
      }
    : {
        sessionId: key.sessionId,
        sessionGeneration: key.sessionGeneration,
        tool: key.tool,
        requestId: key.requestId,
      };
}

function cloneTerminal<T>(terminal: LedgerTerminal<T>): LedgerTerminal<T> {
  return structuredClone(terminal);
}

function replayOutcome(terminal: LedgerTerminal<unknown>): LedgerReplayOutcome {
  return terminal.outcome === "applied" ? "already_applied" : terminal.outcome;
}

function isValidTerminal(terminal: LedgerTerminal<unknown>): boolean {
  return terminal.outcome === "applied"
    ? terminal.verification === "device_ack_only" ||
        terminal.verification === "device_state_verified"
    : terminal.verification === "none";
}

export class RequestLedger {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  #cacheKnownComplete: boolean;
  #lastNowMs = Number.NEGATIVE_INFINITY;
  #nextToken = 1;

  constructor(options: RequestLedgerOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? (() => performance.now());
    this.#cacheKnownComplete = options.cacheKnownComplete ?? true;
  }

  get size(): number {
    this.#removeExpired(this.#readNow());
    return this.#entries.size;
  }

  acquire<T = unknown>(
    key: RequestLedgerKey,
    normalizedInput: unknown,
  ): LedgerAcquireDecision<T> {
    const nowMs = this.#readNow();
    this.#removeExpired(nowMs);
    const mapKey = serializedKey(key);
    const digest = canonicalInputDigest(normalizedInput);
    const existing = this.#entries.get(mapKey);

    if (existing !== undefined) {
      if (existing.digest !== digest) {
        return {
          kind: "conflict",
          code: "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
        };
      }
      if (existing.state === "in_flight") {
        return { kind: "in_flight" };
      }
      return {
        kind: "replay",
        replayOutcome: replayOutcome(existing.terminal),
        terminal: cloneTerminal(existing.terminal) as LedgerTerminal<T>,
      };
    }

    if (!this.#cacheKnownComplete) {
      return { kind: "cache_lost" };
    }
    if (this.#entries.size >= this.#maxEntries) {
      return { kind: "capacity_exceeded" };
    }

    const reservation: LedgerReservation = {
      key: cloneKey(key),
      digest,
      token: `reservation-${this.#nextToken++}`,
    };
    this.#entries.set(mapKey, {
      state: "in_flight",
      key: reservation.key,
      digest,
      token: reservation.token,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
    });
    return { kind: "acquired", reservation };
  }

  complete<T>(
    reservation: LedgerReservation,
    terminal: LedgerTerminal<T>,
  ): boolean {
    if (!isValidTerminal(terminal as LedgerTerminal<unknown>)) {
      return false;
    }
    const nowMs = this.#readNow();
    this.#removeExpired(nowMs);
    const mapKey = serializedKey(reservation.key);
    const existing = this.#entries.get(mapKey);
    if (
      existing?.state !== "in_flight" ||
      existing.token !== reservation.token ||
      existing.digest !== reservation.digest
    ) {
      return false;
    }
    this.#entries.set(mapKey, {
      state: "terminal",
      key: existing.key,
      digest: existing.digest,
      terminal: cloneTerminal(terminal),
      createdAtMs: existing.createdAtMs,
      expiresAtMs: nowMs + this.#ttlMs,
    });
    return true;
  }

  completeBeforeResponse<T, R>(
    reservation: LedgerReservation,
    terminal: LedgerTerminal<T>,
    respond: (terminal: LedgerTerminal<T>) => R,
  ): R {
    if (!this.complete(reservation, terminal)) {
      throw new Error("Request-ledger reservation is no longer current");
    }
    return respond(cloneTerminal(terminal));
  }

  release(reservation: LedgerReservation, outcome: "not_sent"): boolean {
    if (outcome !== "not_sent") {
      return false;
    }
    const nowMs = this.#readNow();
    this.#removeExpired(nowMs);
    const mapKey = serializedKey(reservation.key);
    const existing = this.#entries.get(mapKey);
    if (
      existing?.state !== "in_flight" ||
      existing.token !== reservation.token ||
      existing.digest !== reservation.digest
    ) {
      return false;
    }
    this.#entries.delete(mapKey);
    return true;
  }

  snapshot(): RequestLedgerSnapshot {
    const nowMs = this.#readNow();
    this.#removeExpired(nowMs);
    return {
      cacheKnownComplete: this.#cacheKnownComplete,
      size: this.#entries.size,
      entries: [...this.#entries.values()].map((entry) => ({
        key: cloneKey(entry.key),
        digest: entry.digest,
        state: entry.state,
        createdAtMs: entry.createdAtMs,
        expiresAtMs: entry.expiresAtMs,
        terminalOutcome:
          entry.state === "terminal" ? entry.terminal.outcome : null,
      })),
    };
  }

  #readNow(): number {
    const nowMs = this.#now();
    if (!Number.isFinite(nowMs) || nowMs < this.#lastNowMs) {
      throw new Error("RequestLedger requires a finite monotonic clock");
    }
    this.#lastNowMs = nowMs;
    return nowMs;
  }

  #removeExpired(nowMs: number): void {
    let removed = false;
    for (const [mapKey, entry] of this.#entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.#entries.delete(mapKey);
        removed = true;
      }
    }
    if (removed) {
      this.#cacheKnownComplete = false;
    }
  }
}
