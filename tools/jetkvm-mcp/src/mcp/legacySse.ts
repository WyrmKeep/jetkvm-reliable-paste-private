import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import type { Server as HttpsServer } from "node:https";
import { isIP, type AddressInfo, type Socket } from "node:net";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  evaluateLegacySseRequest,
  HttpBoundaryError,
  type LegacySseBearerAuthenticator,
  type LegacySseBearerCredential,
  type LegacySsePrincipal,
  type LegacySseRequestHeaders,
} from "../browser/auth.js";
import type { LegacySseSecurityPolicy } from "../config.js";
import { createMcpServer, type HandlerRegistry } from "./server.js";

type LegacySseNodeServer = HttpServer | HttpsServer;

const MAXIMUM_BODY_BYTES = 1_048_576;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LegacySseDiagnostic {
  readonly code:
    | "post_routed"
    | "transport_closed"
    | "post_transport_closed"
    | "unexpected_error";
}

export type LegacySseTransportFactory = (
  endpoint: string,
  response: ServerResponse,
) => SSEServerTransport;

export interface LegacySseAdapterOptions {
  readonly handlerRegistry?: HandlerRegistry;
  readonly securityPolicy: LegacySseSecurityPolicy;
  readonly bearerCredential?: LegacySseBearerCredential;
  readonly authenticateBearer?: LegacySseBearerAuthenticator;
  readonly transportFactory?: LegacySseTransportFactory;
  readonly now?: () => number;
  readonly onDiagnostic?: (event: LegacySseDiagnostic) => void;
}

interface StreamAdmission {
  readonly principalId: string;
  released: boolean;
}

interface RoutingEntry {
  readonly principalId: string;
  readonly transport: SSEServerTransport;
  readonly server: McpServer;
  readonly admission: StreamAdmission;
  readonly cleanupWriter: () => void;
  idleTimer: NodeJS.Timeout | undefined;
}

interface AuthenticatedIncomingMessage extends IncomingMessage {
  auth?: AuthInfo;
}

type ReadBodyResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too_large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export class LegacySseAdapter {
  readonly #handlerRegistry: HandlerRegistry;
  readonly #securityPolicy: LegacySseSecurityPolicy;
  readonly #bearerCredential: LegacySseBearerCredential | undefined;
  readonly #authenticateBearer: LegacySseBearerAuthenticator | undefined;
  readonly #transportFactory: LegacySseTransportFactory;
  readonly #now: () => number;
  readonly #onDiagnostic: ((event: LegacySseDiagnostic) => void) | undefined;
  readonly #entries = new Map<string, RoutingEntry>();
  readonly #activeByPrincipal = new Map<string, number>();
  readonly #globalOpenEvents: number[] = [];
  readonly #principalOpenEvents = new Map<string, number[]>();
  #activeStreams = 0;
  #httpServer: LegacySseNodeServer | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LegacySseAdapterOptions) {
    this.#handlerRegistry = options.handlerRegistry ?? {};
    this.#securityPolicy = options.securityPolicy;
    this.#bearerCredential = options.bearerCredential;
    this.#authenticateBearer = options.authenticateBearer;
    this.#transportFactory =
      options.transportFactory ??
      ((endpoint, response) => new SSEServerTransport(endpoint, response));
    this.#now = options.now ?? Date.now;
    this.#onDiagnostic = options.onDiagnostic;
  }

  attachServer(server: LegacySseNodeServer): void {
    if (this.#closed) {
      throw new Error("Cannot attach a closed legacy SSE adapter");
    }
    if (server.listening) {
      throw new Error("Legacy SSE server must be attached before listening");
    }
    if (this.#httpServer !== undefined && this.#httpServer !== server) {
      throw new Error("Legacy SSE adapter is already attached to a server");
    }
    server.headersTimeout = this.#securityPolicy.requestHeaderTimeoutMs;
    server.requestTimeout = this.#securityPolicy.requestBodyTotalTimeoutMs;
    server.keepAliveTimeout = this.#securityPolicy.keepAliveTimeoutMs;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 1_000;
    this.#httpServer = server;
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://mcp.invalid");
      const isSseRoute = url.pathname === "/sse";
      const isMessagesRoute = url.pathname === "/messages";
      if (!isSseRoute && !isMessagesRoute) {
        sendText(response, 404, "Not Found");
        return;
      }

      if (
        !requestMatchesListenerPolicy(
          request,
          this.#securityPolicy,
          this.#httpServer,
        )
      ) {
        sendText(response, 403, "Forbidden");
        return;
      }

      const expectedMethod = isSseRoute ? "GET" : "POST";
      const principal = this.#authorize(request, expectedMethod, response);
      if (principal === undefined) return;
      if (request.method !== expectedMethod) {
        sendText(response, 405, "Method Not Allowed");
        return;
      }

      if (isSseRoute) {
        if (this.#closed) {
          sendText(response, 503, "Service Unavailable");
          return;
        }
        await this.#openStream(response, principal);
        return;
      }
      await this.#handlePost(request, response, url, principal);
    } catch {
      this.#onDiagnostic?.({ code: "unexpected_error" });
      if (!response.headersSent && !response.writableEnded) {
        sendText(response, 500, "Internal Server Error");
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  #authorize(
    request: IncomingMessage,
    method: "GET" | "POST",
    response: ServerResponse,
  ): LegacySsePrincipal | undefined {
    try {
      const host = singleHeader(request, "host");
      const origin = singleHeader(request, "origin");
      const authorization = singleHeader(request, "authorization");
      const antiCsrf = singleHeader(request, "x-jetkvm-csrf");
      return evaluateLegacySseRequest(
        {
          method,
          ...(host === undefined ? {} : { host }),
          ...(origin === undefined ? {} : { origin }),
          ...(authorization === undefined ? {} : { authorization }),
          ...(antiCsrf === undefined ? {} : { antiCsrf }),
        },
        this.#securityPolicy,
        this.#bearerCredential,
        this.#authenticateBearer,
      );
    } catch (error) {
      if (error instanceof HttpBoundaryError) {
        sendText(
          response,
          error.statusCode,
          error.statusCode === 401 ? "Unauthorized" : "Forbidden",
        );
        return undefined;
      }
      throw error;
    }
  }

  async #openStream(
    response: ServerResponse,
    principal: LegacySsePrincipal,
  ): Promise<void> {
    const admission = this.#admitStream(principal.principalId);
    if (admission === undefined) {
      sendText(response, 429, "Too Many Requests");
      return;
    }

    let cleanupWriter: (() => void) | undefined;
    let transport: SSEServerTransport | undefined;
    let entry: RoutingEntry | undefined;
    try {
      cleanupWriter = installBoundedSseWriter(
        response,
        this.#securityPolicy.maxResponseBufferedBytes,
        this.#securityPolicy.responseBackpressureTimeoutMs,
      );
      transport = this.#transportFactory("/messages", response);
      const sessionId = transport.sessionId;
      if (!SESSION_ID.test(sessionId) || this.#entries.has(sessionId)) {
        throw new Error("Legacy SSE transport returned an invalid routing ID");
      }
      const server = createMcpServer(this.#handlerRegistry);
      entry = {
        principalId: principal.principalId,
        transport,
        server,
        admission,
        cleanupWriter,
        idleTimer: undefined,
      };
      transport.onclose = () => {
        this.#removeEntry(sessionId, entry!, "transport_closed");
      };
      this.#entries.set(sessionId, entry);
      this.#refreshIdleTimer(sessionId, entry);
      await server.connect(transport);
    } catch (error) {
      if (entry !== undefined) {
        this.#removeEntry(transport!.sessionId, entry);
      } else {
        cleanupWriter?.();
        this.#releaseAdmission(admission);
      }
      if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async #handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: LegacySsePrincipal,
  ): Promise<void> {
    const sessionIds = url.searchParams.getAll("sessionId");
    if (sessionIds.length !== 1 || !SESSION_ID.test(sessionIds[0] ?? "")) {
      sendText(response, 400, "Bad Request");
      return;
    }
    const sessionId = sessionIds[0];
    if (sessionId === undefined) {
      sendText(response, 400, "Bad Request");
      return;
    }

    const entry = this.#entries.get(sessionId);
    if (entry === undefined || entry.principalId !== principal.principalId) {
      sendText(response, 404, "Not Found");
      return;
    }
    this.#onDiagnostic?.({ code: "post_routed" });

    if (singleHeader(request, "content-type") !== "application/json") {
      sendText(response, 400, "Invalid Content-Type");
      return;
    }
    const declaredLength = parseContentLength(
      singleHeader(request, "content-length"),
    );
    if (declaredLength !== undefined && declaredLength > MAXIMUM_BODY_BYTES) {
      request.resume();
      sendText(response, 400, "Request body too large");
      return;
    }

    const body = await readBody(
      request,
      this.#securityPolicy.requestBodyIdleTimeoutMs,
      this.#securityPolicy.requestBodyTotalTimeoutMs,
    );
    if (body.kind === "too_large") {
      sendText(response, 400, "Request body too large");
      return;
    }
    if (body.kind === "timeout") {
      sendText(response, 408, "Request Timeout", true);
      return;
    }
    if (body.kind === "aborted") {
      if (!response.headersSent && !response.writableEnded) {
        sendText(response, 400, "Bad Request", true);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      sendText(response, 400, "Invalid JSON");
      return;
    }
    const message = JSONRPCMessageSchema.safeParse(parsed);
    if (!message.success) {
      sendText(response, 400, "Invalid JSON-RPC message");
      return;
    }

    const authenticatedRequest = request as AuthenticatedIncomingMessage;
    authenticatedRequest.auth = {
      token: "[REDACTED]",
      clientId: principal.principalId,
      scopes: ["mcp"],
    };
    try {
      await entry.transport.handlePostMessage(
        authenticatedRequest,
        response,
        message.data,
      );
      if (
        response.statusCode === 202 &&
        this.#entries.get(sessionId) === entry
      ) {
        this.#refreshIdleTimer(sessionId, entry);
      }
    } catch {
      this.#onDiagnostic?.({ code: "post_transport_closed" });
      if (!response.headersSent && !response.writableEnded) {
        sendText(response, 500, "Internal Server Error");
      }
    }
  }

  #admitStream(principalId: string): StreamAdmission | undefined {
    const now = this.#now();
    this.#pruneRateEvents(now);
    const principalEvents = this.#principalOpenEvents.get(principalId) ?? [];
    const principalActive = this.#activeByPrincipal.get(principalId) ?? 0;
    if (
      this.#activeStreams >= this.#securityPolicy.maxConcurrentStreams ||
      principalActive >=
        this.#securityPolicy.maxConcurrentStreamsPerPrincipal ||
      this.#globalOpenEvents.length >=
        this.#securityPolicy.streamOpenRateLimit ||
      principalEvents.length >=
        this.#securityPolicy.streamOpenRateLimitPerPrincipal
    ) {
      return undefined;
    }

    this.#globalOpenEvents.push(now);
    principalEvents.push(now);
    this.#principalOpenEvents.set(principalId, principalEvents);
    this.#activeStreams += 1;
    this.#activeByPrincipal.set(principalId, principalActive + 1);
    return { principalId, released: false };
  }

  #pruneRateEvents(now: number): void {
    const cutoff = now - this.#securityPolicy.streamOpenRateWindowMs;
    pruneTimestamps(this.#globalOpenEvents, cutoff);
    for (const [principalId, events] of this.#principalOpenEvents) {
      pruneTimestamps(events, cutoff);
      if (events.length === 0) this.#principalOpenEvents.delete(principalId);
    }
  }

  #releaseAdmission(admission: StreamAdmission): void {
    if (admission.released) return;
    admission.released = true;
    this.#activeStreams -= 1;
    const principalActive =
      this.#activeByPrincipal.get(admission.principalId) ?? 0;
    if (principalActive <= 1) {
      this.#activeByPrincipal.delete(admission.principalId);
    } else {
      this.#activeByPrincipal.set(admission.principalId, principalActive - 1);
    }
  }

  #refreshIdleTimer(sessionId: string, entry: RoutingEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.#expireEntry(sessionId, entry);
    }, this.#securityPolicy.sessionIdleTimeoutMs);
    entry.idleTimer.unref();
  }

  async #expireEntry(sessionId: string, entry: RoutingEntry): Promise<void> {
    if (!this.#removeEntry(sessionId, entry, "transport_closed")) return;
    try {
      await entry.server.close();
    } catch {
      this.#onDiagnostic?.({ code: "unexpected_error" });
    }
  }

  #removeEntry(
    sessionId: string,
    entry: RoutingEntry,
    diagnostic?: "transport_closed",
  ): boolean {
    if (this.#entries.get(sessionId) !== entry) return false;
    this.#entries.delete(sessionId);
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.cleanupWriter();
    this.#releaseAdmission(entry.admission);
    if (diagnostic !== undefined) this.#onDiagnostic?.({ code: diagnostic });
    return true;
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.entries()];
    for (const [sessionId, entry] of entries) {
      this.#removeEntry(sessionId, entry);
    }
    this.#globalOpenEvents.length = 0;
    this.#principalOpenEvents.clear();
    await Promise.all(
      entries.map(async ([, entry]) => {
        try {
          await entry.server.close();
        } catch {
          this.#onDiagnostic?.({ code: "unexpected_error" });
        }
      }),
    );
  }
}

interface ListenerSocket extends Socket {
  readonly encrypted?: boolean;
  readonly server?: LegacySseNodeServer;
}

function requestMatchesListenerPolicy(
  request: IncomingMessage,
  policy: LegacySseSecurityPolicy,
  attachedServer: LegacySseNodeServer | undefined,
): boolean {
  const socket = request.socket as ListenerSocket;
  const server = socket.server;
  if (server === undefined || server !== attachedServer) return false;
  if (
    server.headersTimeout !== policy.requestHeaderTimeoutMs ||
    server.requestTimeout !== policy.requestBodyTotalTimeoutMs ||
    server.keepAliveTimeout !== policy.keepAliveTimeoutMs ||
    server.maxHeadersCount !== 64 ||
    server.maxRequestsPerSocket !== 1_000
  ) {
    return false;
  }
  const listenerAddress = server.address();
  if (listenerAddress === null || typeof listenerAddress === "string") {
    return false;
  }
  const encrypted = socket.encrypted === true;
  if ((policy.scheme === "https") !== encrypted) return false;

  const listenerHost = listenerAddress.address.toLowerCase();
  const localHost = socket.localAddress?.toLowerCase();
  if (localHost === undefined) return false;
  if (policy.bindHost === "localhost") {
    return isLoopbackAddress(listenerHost) && isLoopbackAddress(localHost);
  }
  if (policy.bindHost === "0.0.0.0") {
    return listenerHost === "0.0.0.0" && isIP(localHost) === 4;
  }
  if (policy.bindHost === "::") {
    return listenerHost === "::" && isIP(localHost) === 6;
  }
  return listenerHost === policy.bindHost && localHost === listenerHost;
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (address.startsWith("::ffff:")) {
    return isLoopbackAddress(address.slice("::ffff:".length));
  }
  if (isIP(address) !== 4) return false;
  return Number.parseInt(address.split(".")[0] ?? "", 10) === 127;
}

function pruneTimestamps(events: number[], cutoff: number): void {
  while (events.length > 0 && events[0]! <= cutoff) events.shift();
}

function installBoundedSseWriter(
  response: ServerResponse,
  maxBufferedBytes: number,
  backpressureTimeoutMs: number,
): () => void {
  const originalWrite = response.write;
  let backpressureTimer: NodeJS.Timeout | undefined;
  let cleaned = false;
  let failed = false;

  const clearBackpressureTimer = (): void => {
    if (backpressureTimer === undefined) return;
    clearTimeout(backpressureTimer);
    backpressureTimer = undefined;
  };
  const failClosed = (): void => {
    if (failed) return;
    failed = true;
    clearBackpressureTimer();
    response.destroy();
  };
  const armBackpressureTimer = (): void => {
    if (backpressureTimer !== undefined || failed) return;
    backpressureTimer = setTimeout(failClosed, backpressureTimeoutMs);
    backpressureTimer.unref();
  };
  const onDrain = (): void => {
    clearBackpressureTimer();
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearBackpressureTimer();
    response.off("drain", onDrain);
    response.off("close", cleanup);
    if (response.write === guardedWrite) response.write = originalWrite;
  };
  const guardedWrite = ((
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean => {
    const byteLength = responseChunkByteLength(chunk, encodingOrCallback);
    if (response.writableLength + byteLength > maxBufferedBytes) {
      failClosed();
      return false;
    }
    const accepted = Reflect.apply(originalWrite, response, [
      chunk,
      encodingOrCallback,
      callback,
    ]) as boolean;
    if (!accepted) armBackpressureTimer();
    return accepted;
  }) as typeof response.write;

  response.write = guardedWrite;
  response.on("drain", onDrain);
  response.on("close", cleanup);
  return cleanup;
}

function responseChunkByteLength(
  chunk: unknown,
  encodingOrCallback: unknown,
): number {
  if (typeof chunk === "string") {
    const encoding =
      typeof encodingOrCallback === "string"
        ? (encodingOrCallback as BufferEncoding)
        : "utf8";
    return Buffer.byteLength(chunk, encoding);
  }
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return Number.POSITIVE_INFINITY;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBody(
  request: IncomingMessage,
  idleTimeoutMs: number,
  totalTimeoutMs: number,
): Promise<ReadBodyResult> {
  const completion = Promise.withResolvers<ReadBodyResult>();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const cleanup = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    idleTimer = undefined;
    totalTimer = undefined;
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("aborted", onAborted);
    request.off("error", onAborted);
  };
  const settle = (result: ReadBodyResult, drain: boolean): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (drain) request.resume();
    completion.resolve(result);
  };
  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => settle({ kind: "timeout" }, true),
      idleTimeoutMs,
    );
    idleTimer.unref();
  };
  function onData(chunk: Buffer | string): void {
    armIdleTimer();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAXIMUM_BODY_BYTES) {
      settle({ kind: "too_large" }, true);
      return;
    }
    chunks.push(bytes);
  }
  function onEnd(): void {
    settle(
      {
        kind: "ok",
        text: Buffer.concat(chunks, byteLength).toString("utf8"),
      },
      false,
    );
  }
  function onAborted(): void {
    settle({ kind: "aborted" }, false);
  }

  request.on("data", onData);
  request.once("end", onEnd);
  request.once("aborted", onAborted);
  request.once("error", onAborted);
  totalTimer = setTimeout(
    () => settle({ kind: "timeout" }, true),
    totalTimeoutMs,
  );
  totalTimer.unref();
  armIdleTimer();
  return completion.promise;
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  closeConnection = false,
): void {
  if (response.headersSent || response.writableEnded) return;
  if (closeConnection) response.shouldKeepAlive = false;
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...(closeConnection ? { Connection: "close" } : {}),
  });
  response.end(body);
}
