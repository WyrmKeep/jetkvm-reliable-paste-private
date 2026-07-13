import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerOptions as HttpServerOptions,
  type ServerResponse,
} from "node:http";
import {
  createServer as createNodeHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { isIP, type AddressInfo, type Socket } from "node:net";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  assertIndependentLegacySseBearerCredential,
  evaluateLegacySseRequest,
  HttpBoundaryError,
  type IndependentLegacySseBearerCredential,
  type LegacySseBearerAuthenticator,
  type LegacySsePrincipal,
  type LegacySseRequestHeaders,
} from "../browser/auth.js";
import type { LegacySseSecurityPolicy } from "../config.js";
import { createMcpServer, type HandlerRegistry } from "./server.js";

type LegacySseNodeServer = HttpServer | HttpsServer;

interface LegacySseServerConstructionProof {
  readonly owner: object;
  readonly scheme: "http" | "https";
  readonly connectionsCheckingIntervalMs: number;
  readonly tlsHandshakeTimeoutMs: number | null;
}

const serverConstructionProofs = new WeakMap<
  LegacySseNodeServer,
  LegacySseServerConstructionProof
>();

const MAXIMUM_BODY_BYTES = 1_048_576;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
  readonly bearerCredential?: IndependentLegacySseBearerCredential;
  readonly authenticateBearer?: LegacySseBearerAuthenticator;
  readonly transportFactory?: LegacySseTransportFactory;
  readonly now?: () => number;
  readonly onDiagnostic?: (event: LegacySseDiagnostic) => void;
}

interface StreamAdmission {
  readonly principalId: string;
  released: boolean;
}

interface PostAdmission {
  readonly principalId: string;
  readonly sessionId: string;
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
  | { readonly kind: "invalid_utf8" }
  | { readonly kind: "too_large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export class LegacySseAdapter {
  readonly #handlerRegistry: HandlerRegistry;
  readonly #securityPolicy: LegacySseSecurityPolicy;
  readonly #bearerCredential: IndependentLegacySseBearerCredential | undefined;
  readonly #authenticateBearer: LegacySseBearerAuthenticator | undefined;
  readonly #transportFactory: LegacySseTransportFactory;
  readonly #now: () => number;
  readonly #onDiagnostic: ((event: LegacySseDiagnostic) => void) | undefined;
  readonly #constructionOwner = Object.freeze({});
  readonly #entries = new Map<string, RoutingEntry>();
  readonly #activeByPrincipal = new Map<string, number>();
  readonly #globalOpenEvents: number[] = [];
  readonly #principalOpenEvents = new Map<string, number[]>();
  readonly #activePostsByPrincipal = new Map<string, number>();
  readonly #activePostsBySession = new Map<string, number>();
  readonly #postRateByPrincipal = new Map<string, number>();
  readonly #postRateBySession = new Map<string, number>();
  #routeAttemptCount = 0;
  #routeAttemptWindowStartedAt: number | undefined;
  #activeStreams = 0;
  #activePosts = 0;
  #postRateCount = 0;
  #postRateWindowStartedAt: number | undefined;
  #lastStreamRateObservedAt: number | undefined;
  #httpServer: LegacySseNodeServer | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LegacySseAdapterOptions) {
    if (options.bearerCredential !== undefined) {
      assertIndependentLegacySseBearerCredential(options.bearerCredential);
    }
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

  createHttpServer(): HttpServer {
    if (this.#securityPolicy.scheme !== "http") {
      throw new Error("Legacy SSE HTTPS policy requires an HTTPS server");
    }
    const server = createNodeHttpServer(
      this.#httpServerOptions(),
      (request, response) => {
        void this.handleRequest(request, response);
      },
    );
    return this.#proveAndAttachServer(server, "http", null);
  }

  createHttpsServer(options: HttpsServerOptions): HttpsServer {
    if (this.#securityPolicy.scheme !== "https") {
      throw new Error("Legacy SSE HTTP policy requires an HTTP server");
    }
    const handshakeTimeout = this.#securityPolicy.requestHeaderTimeoutMs;
    const server = createNodeHttpsServer(
      {
        ...options,
        ...this.#httpServerOptions(),
        handshakeTimeout,
      },
      (request, response) => {
        void this.handleRequest(request, response);
      },
    );
    return this.#proveAndAttachServer(server, "https", handshakeTimeout);
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
    const proof = serverConstructionProofs.get(server);
    if (proof?.owner !== this.#constructionOwner) {
      throw new Error(
        "Legacy SSE server lacks project-owned construction proof",
      );
    }
    if (
      proof.scheme !== this.#securityPolicy.scheme ||
      proof.connectionsCheckingIntervalMs <= 0 ||
      proof.connectionsCheckingIntervalMs >
        this.#securityPolicy.requestHeaderTimeoutMs ||
      (proof.scheme === "https" &&
        (proof.tlsHandshakeTimeoutMs === null ||
          proof.tlsHandshakeTimeoutMs <= 0 ||
          proof.tlsHandshakeTimeoutMs >
            this.#securityPolicy.requestHeaderTimeoutMs)) ||
      server.headersTimeout !== this.#securityPolicy.requestHeaderTimeoutMs ||
      server.requestTimeout !==
        this.#securityPolicy.requestBodyTotalTimeoutMs ||
      server.keepAliveTimeout !== this.#securityPolicy.keepAliveTimeoutMs
    ) {
      throw new Error("Legacy SSE server construction proof is invalid");
    }
    Object.defineProperties(server, {
      headersTimeout: {
        configurable: false,
        value: this.#securityPolicy.requestHeaderTimeoutMs,
        writable: false,
      },
      requestTimeout: {
        configurable: false,
        value: this.#securityPolicy.requestBodyTotalTimeoutMs,
        writable: false,
      },
      keepAliveTimeout: {
        configurable: false,
        value: this.#securityPolicy.keepAliveTimeoutMs,
        writable: false,
      },
      maxHeadersCount: {
        configurable: false,
        value: 64,
        writable: false,
      },
      maxRequestsPerSocket: {
        configurable: false,
        value: 1_000,
        writable: false,
      },
      maxConnections: {
        configurable: false,
        value: this.#securityPolicy.maxConnections,
        writable: false,
      },
    });
    this.#httpServer = server;
  }

  #httpServerOptions(): HttpServerOptions {
    return {
      connectionsCheckingInterval: this.#securityPolicy.requestHeaderTimeoutMs,
      headersTimeout: this.#securityPolicy.requestHeaderTimeoutMs,
      requestTimeout: this.#securityPolicy.requestBodyTotalTimeoutMs,
      keepAliveTimeout: this.#securityPolicy.keepAliveTimeoutMs,
      keepAliveTimeoutBuffer: 0,
      insecureHTTPParser: false,
      requireHostHeader: true,
    };
  }

  #proveAndAttachServer<T extends LegacySseNodeServer>(
    server: T,
    scheme: "http" | "https",
    tlsHandshakeTimeoutMs: number | null,
  ): T {
    serverConstructionProofs.set(server, {
      owner: this.#constructionOwner,
      scheme,
      connectionsCheckingIntervalMs:
        this.#securityPolicy.requestHeaderTimeoutMs,
      tlsHandshakeTimeoutMs,
    });
    try {
      this.attachServer(server);
      return server;
    } catch (error) {
      serverConstructionProofs.delete(server);
      throw error;
    }
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.#admitRouteAttempt()) {
        sendPreBodyRejection(request, response, 429, "Too Many Requests");
        return;
      }

      const url = new URL(request.url ?? "/", "http://mcp.invalid");
      const isSseRoute = url.pathname === "/sse";
      const isMessagesRoute = url.pathname === "/messages";
      if (!isSseRoute && !isMessagesRoute) {
        sendPreBodyRejection(request, response, 404, "Not Found");
        return;
      }

      if (
        !requestMatchesListenerPolicy(
          request,
          this.#securityPolicy,
          this.#httpServer,
        )
      ) {
        sendPreBodyRejection(request, response, 403, "Forbidden");
        return;
      }

      const expectedMethod = isSseRoute ? "GET" : "POST";
      const principal = this.#authorize(request, expectedMethod, response);
      if (principal === undefined) return;
      if (request.method !== expectedMethod) {
        sendPreBodyRejection(request, response, 405, "Method Not Allowed");
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
        sendPreBodyRejection(request, response, 500, "Internal Server Error");
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
        sendPreBodyRejection(
          request,
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
        this.#securityPolicy.maxResponseMessageBytes,
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
      sendPreBodyRejection(request, response, 400, "Bad Request");
      return;
    }
    const sessionId = sessionIds[0];
    if (sessionId === undefined) {
      sendPreBodyRejection(request, response, 400, "Bad Request");
      return;
    }

    const admission = this.#admitPost(principal.principalId, sessionId);
    if (admission === undefined) {
      sendPreBodyRejection(request, response, 429, "Too Many Requests");
      return;
    }
    try {
      const entry = this.#entries.get(sessionId);
      if (entry === undefined || entry.principalId !== principal.principalId) {
        sendPreBodyRejection(request, response, 404, "Not Found");
        return;
      }
      this.#onDiagnostic?.({ code: "post_routed" });

      if (singleHeader(request, "content-type") !== "application/json") {
        sendPreBodyRejection(request, response, 400, "Invalid Content-Type");
        return;
      }
      const declaredLength = parseContentLength(
        singleHeader(request, "content-length"),
      );
      if (declaredLength !== undefined && declaredLength > MAXIMUM_BODY_BYTES) {
        sendPreBodyRejection(request, response, 400, "Request body too large");
        return;
      }

      const body = await readBody(
        request,
        this.#securityPolicy.requestBodyIdleTimeoutMs,
        this.#securityPolicy.requestBodyTotalTimeoutMs,
      );
      if (body.kind === "too_large") {
        sendText(response, 400, "Request body too large", true);
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
      if (body.kind === "invalid_utf8") {
        sendText(response, 400, "Invalid UTF-8");
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
    } finally {
      this.#releasePostAdmission(admission);
    }
  }

  #admitRouteAttempt(): boolean {
    const now = this.#now();
    const windowStartedAt = this.#routeAttemptWindowStartedAt;
    if (
      windowStartedAt === undefined ||
      now < windowStartedAt ||
      now - windowStartedAt >= this.#securityPolicy.routeAttemptRateWindowMs
    ) {
      this.#routeAttemptWindowStartedAt = now;
      this.#routeAttemptCount = 0;
    }
    if (this.#routeAttemptCount >= this.#securityPolicy.routeAttemptRateLimit) {
      return false;
    }
    this.#routeAttemptCount += 1;
    return true;
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
    const lastObservedAt = this.#lastStreamRateObservedAt;
    if (lastObservedAt !== undefined && now < lastObservedAt) {
      this.#globalOpenEvents.length = 0;
      this.#principalOpenEvents.clear();
    }
    this.#lastStreamRateObservedAt = now;
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

  #admitPost(
    principalId: string,
    sessionId: string,
  ): PostAdmission | undefined {
    if (!this.#admitPostRate(principalId, sessionId)) return undefined;
    const principalActive = this.#activePostsByPrincipal.get(principalId) ?? 0;
    const sessionActive = this.#activePostsBySession.get(sessionId) ?? 0;
    if (
      this.#activePosts >= this.#securityPolicy.maxConcurrentPosts ||
      principalActive >= this.#securityPolicy.maxConcurrentPostsPerPrincipal ||
      sessionActive >= this.#securityPolicy.maxConcurrentPostsPerSession
    ) {
      return undefined;
    }

    this.#activePosts += 1;
    this.#activePostsByPrincipal.set(principalId, principalActive + 1);
    this.#activePostsBySession.set(sessionId, sessionActive + 1);
    return { principalId, sessionId, released: false };
  }

  #admitPostRate(principalId: string, sessionId: string): boolean {
    const now = this.#now();
    const windowStartedAt = this.#postRateWindowStartedAt;
    if (
      windowStartedAt === undefined ||
      now < windowStartedAt ||
      now - windowStartedAt >= this.#securityPolicy.postRateWindowMs
    ) {
      this.#postRateWindowStartedAt = now;
      this.#postRateCount = 0;
      this.#postRateByPrincipal.clear();
      this.#postRateBySession.clear();
    }
    if (this.#postRateCount >= this.#securityPolicy.postRateLimit) {
      return false;
    }

    const principalCount = this.#postRateByPrincipal.get(principalId) ?? 0;
    const sessionCount = this.#postRateBySession.get(sessionId) ?? 0;
    this.#postRateCount += 1;
    if (principalCount < this.#securityPolicy.postRateLimitPerPrincipal) {
      this.#postRateByPrincipal.set(principalId, principalCount + 1);
    }
    if (sessionCount < this.#securityPolicy.postRateLimitPerSession) {
      this.#postRateBySession.set(sessionId, sessionCount + 1);
    }
    return (
      principalCount < this.#securityPolicy.postRateLimitPerPrincipal &&
      sessionCount < this.#securityPolicy.postRateLimitPerSession
    );
  }

  #releasePostAdmission(admission: PostAdmission): void {
    if (admission.released) return;
    admission.released = true;
    this.#activePosts -= 1;
    decrementCount(this.#activePostsByPrincipal, admission.principalId);
    decrementCount(this.#activePostsBySession, admission.sessionId);
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
    this.#routeAttemptCount = 0;
    this.#routeAttemptWindowStartedAt = undefined;
    this.#globalOpenEvents.length = 0;
    this.#principalOpenEvents.clear();
    this.#lastStreamRateObservedAt = undefined;
    this.#postRateCount = 0;
    this.#postRateWindowStartedAt = undefined;
    this.#postRateByPrincipal.clear();
    this.#postRateBySession.clear();
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
  const proof = serverConstructionProofs.get(server);
  if (
    proof === undefined ||
    proof.scheme !== policy.scheme ||
    proof.connectionsCheckingIntervalMs <= 0 ||
    proof.connectionsCheckingIntervalMs > policy.requestHeaderTimeoutMs ||
    (proof.scheme === "https" &&
      (proof.tlsHandshakeTimeoutMs === null ||
        proof.tlsHandshakeTimeoutMs <= 0 ||
        proof.tlsHandshakeTimeoutMs > policy.requestHeaderTimeoutMs))
  ) {
    return false;
  }
  if (
    server.headersTimeout !== policy.requestHeaderTimeoutMs ||
    server.requestTimeout !== policy.requestBodyTotalTimeoutMs ||
    server.keepAliveTimeout !== policy.keepAliveTimeoutMs ||
    server.maxHeadersCount !== 64 ||
    server.maxRequestsPerSocket !== 1_000 ||
    server.maxConnections !== policy.maxConnections ||
    !isImmutableConnectionCap(server, policy.maxConnections)
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

export function installBoundedSseWriter(
  response: ServerResponse,
  maxMessageBytes: number,
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
    if (
      byteLength > maxMessageBytes ||
      response.writableLength + byteLength > maxBufferedBytes
    ) {
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

function decrementCount(counts: Map<string, number>, key: string): void {
  const count = counts.get(key) ?? 0;
  if (count <= 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
}

function isImmutableConnectionCap(
  server: LegacySseNodeServer,
  expected: number,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(server, "maxConnections");
  return (
    descriptor?.configurable === false &&
    descriptor.writable === false &&
    descriptor.value === expected
  );
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
  const settle = (result: ReadBodyResult): void => {
    if (settled) return;
    settled = true;
    cleanup();
    completion.resolve(result);
  };
  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => settle({ kind: "timeout" }), idleTimeoutMs);
    idleTimer.unref();
  };
  function onData(chunk: Buffer | string): void {
    armIdleTimer();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAXIMUM_BODY_BYTES) {
      settle({ kind: "too_large" });
      return;
    }
    chunks.push(bytes);
  }
  function onEnd(): void {
    let text: string;
    try {
      text = FATAL_UTF8_DECODER.decode(Buffer.concat(chunks, byteLength));
    } catch {
      settle({ kind: "invalid_utf8" });
      return;
    }
    settle({ kind: "ok", text });
  }
  function onAborted(): void {
    settle({ kind: "aborted" });
  }

  request.on("data", onData);
  request.once("end", onEnd);
  request.once("aborted", onAborted);
  request.once("error", onAborted);
  totalTimer = setTimeout(() => settle({ kind: "timeout" }), totalTimeoutMs);
  totalTimer.unref();
  armIdleTimer();
  return completion.promise;
}

function sendPreBodyRejection(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  sendText(response, statusCode, body, request.method === "POST");
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
  if (closeConnection) {
    response.end(body, () => response.destroy());
    return;
  }
  response.end(body);
}
