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
import { isIP, Socket, type AddressInfo } from "node:net";
import process from "node:process";

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
import {
  assertParsedLegacySseSecurityPolicy,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_PRINCIPAL,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_SESSION,
  LEGACY_SSE_QUEUED_RESPONSE_BUDGET_BYTES,
  LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_PRINCIPAL,
  LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_STREAM,
  LEGACY_SSE_MAX_HEADER_BYTES,
  MCP_TRANSPORT_MAX_REQUEST_BYTES,
  type LegacySseSecurityPolicy,
} from "../config.js";
import {
  assertHandlerRegistry,
  createMcpServer,
  type HandlerRegistry,
} from "./server.js";

interface HttpParserBoundServer {
  readonly maxHeaderSize: number;
  readonly insecureHTTPParser: boolean;
}
type LegacySseNodeServer = HttpServer | HttpsServer;

interface LegacySseServerConstructionProof {
  readonly owner: object;
  readonly scheme: "http" | "https";
  readonly connectionsCheckingIntervalMs: number;
  readonly absoluteHeaderTimeoutMs: number;
  readonly tlsHandshakeTimeoutMs: number | null;
  readonly absoluteTlsHandshakeTimeoutMs: number | null;
}

const serverConstructionProofs = new WeakMap<
  LegacySseNodeServer,
  LegacySseServerConstructionProof
>();

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const INITIAL_REQUEST_BODY_BUFFER_BYTES = 8_192;
const EMPTY_REQUEST_BODY = Buffer.alloc(0);

export interface LegacySseDiagnostic {
  readonly code:
    | "post_routed"
    | "transport_closed"
    | "post_transport_closed"
    | "response_capacity_exceeded"
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
  readonly sessionBucketKey: string;
  released: boolean;
}

interface ActivePostLifecycle {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

interface RoutingEntry {
  readonly principalId: string;
  readonly transport: SSEServerTransport;
  readonly server: McpServer;
  readonly admission: StreamAdmission;
  readonly cleanupWriter: () => void;
  readonly abortController: AbortController;
  idleTimer: NodeJS.Timeout | undefined;
}

interface AuthenticatedIncomingMessage extends IncomingMessage {
  auth?: AuthInfo;
}

type ReadBodyOutcome =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "capacity_exceeded" }
  | { readonly kind: "too_large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

type ReadBodyResult = ReadBodyOutcome & {
  readonly release: () => void;
};

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
  readonly #activeRequestBodyBytesByPrincipal = new Map<string, number>();
  readonly #activeRequestBodyBytesBySession = new Map<string, number>();
  readonly #activePostLifecycles = new Set<ActivePostLifecycle>();
  readonly #retiringServerCloses = new Set<Promise<void>>();
  readonly #queuedResponseBytesByPrincipal = new Map<string, number>();
  readonly #queuedResponseBytesByStream = new WeakMap<object, number>();
  #routeAttemptCount = 0;
  #routeAttemptWindowStartedAt: number | undefined;
  #activeStreams = 0;
  #activePosts = 0;
  #activeRequestBodyBytes = 0;
  #queuedResponseBytes = 0;
  #postRateCount = 0;
  #postRateWindowStartedAt: number | undefined;
  #lastStreamRateObservedAt: number | undefined;
  #httpServer: LegacySseNodeServer | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LegacySseAdapterOptions) {
    const handlerRegistry = options.handlerRegistry ?? {};
    assertHandlerRegistry(handlerRegistry);
    assertParsedLegacySseSecurityPolicy(options.securityPolicy);
    if (options.bearerCredential !== undefined) {
      assertIndependentLegacySseBearerCredential(options.bearerCredential);
    }
    if (
      options.securityPolicy.enabled &&
      options.securityPolicy.networkExposed &&
      options.bearerCredential === undefined
    ) {
      throw new Error(
        "Network-exposed legacy SSE requires an activated bearer credential",
      );
    }
    this.#handlerRegistry = handlerRegistry;
    this.#securityPolicy = options.securityPolicy;
    this.#bearerCredential = options.bearerCredential;
    this.#authenticateBearer = options.authenticateBearer;
    this.#transportFactory =
      options.transportFactory ??
      ((endpoint, response) => new SSEServerTransport(endpoint, response));
    this.#now = options.now ?? Date.now;
    this.#onDiagnostic = options.onDiagnostic;
  }

  #createPostLifecycle(
    request: IncomingMessage,
    response: ServerResponse,
  ): ActivePostLifecycle {
    const completion = Promise.withResolvers<void>();
    return {
      request,
      response,
      settled: completion.promise,
      resolveSettled: completion.resolve,
    };
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
    this.#installExpectationHandlers(server);
    installAbsoluteHeaderDeadline(
      server,
      this.#securityPolicy.requestHeaderTimeoutMs,
      "http",
    );
    return this.#proveAndAttachServer(server, "http", null, null);
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
    this.#installExpectationHandlers(server);
    installAbsoluteTlsHandshakeDeadline(server, handshakeTimeout);
    installAbsoluteHeaderDeadline(server, handshakeTimeout, "https");
    return this.#proveAndAttachServer(
      server,
      "https",
      handshakeTimeout,
      handshakeTimeout,
    );
  }

  #installExpectationHandlers(server: LegacySseNodeServer): void {
    server.on("checkContinue", (request, response) => {
      void this.#handleRequest(request, response, "continue");
    });
    server.on("checkExpectation", (request, response) => {
      void this.#handleRequest(request, response, "unsupported");
    });
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
      proof.absoluteHeaderTimeoutMs <= 0 ||
      proof.absoluteHeaderTimeoutMs >
        this.#securityPolicy.requestHeaderTimeoutMs ||
      (proof.scheme === "https" &&
        (proof.tlsHandshakeTimeoutMs === null ||
          proof.tlsHandshakeTimeoutMs <= 0 ||
          proof.tlsHandshakeTimeoutMs >
            this.#securityPolicy.requestHeaderTimeoutMs ||
          proof.absoluteTlsHandshakeTimeoutMs === null ||
          proof.absoluteTlsHandshakeTimeoutMs <= 0 ||
          proof.absoluteTlsHandshakeTimeoutMs >
            this.#securityPolicy.requestHeaderTimeoutMs)) ||
      server.headersTimeout !== this.#securityPolicy.requestHeaderTimeoutMs ||
      server.requestTimeout !==
        this.#securityPolicy.requestBodyTotalTimeoutMs ||
      server.keepAliveTimeout !== this.#securityPolicy.keepAliveTimeoutMs ||
      (server as LegacySseNodeServer & HttpParserBoundServer).maxHeaderSize !==
        LEGACY_SSE_MAX_HEADER_BYTES ||
      (server as LegacySseNodeServer & HttpParserBoundServer)
        .insecureHTTPParser !== false ||
      server.keepAliveTimeoutBuffer !== 0
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
      keepAliveTimeoutBuffer: {
        configurable: false,
        value: 0,
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
      maxHeaderSize: {
        configurable: false,
        value: LEGACY_SSE_MAX_HEADER_BYTES,
        writable: false,
      },
      insecureHTTPParser: {
        configurable: false,
        value: false,
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
      maxHeaderSize: LEGACY_SSE_MAX_HEADER_BYTES,
      insecureHTTPParser: false,
      // Middleware owns missing-Host classification so auth remains the first
      // externally observable decision on both routes.
      requireHostHeader: false,
    };
  }

  #proveAndAttachServer<T extends LegacySseNodeServer>(
    server: T,
    scheme: "http" | "https",
    tlsHandshakeTimeoutMs: number | null,
    absoluteTlsHandshakeTimeoutMs: number | null,
  ): T {
    serverConstructionProofs.set(server, {
      owner: this.#constructionOwner,
      scheme,
      connectionsCheckingIntervalMs:
        this.#securityPolicy.requestHeaderTimeoutMs,
      absoluteHeaderTimeoutMs: this.#securityPolicy.requestHeaderTimeoutMs,
      tlsHandshakeTimeoutMs,
      absoluteTlsHandshakeTimeoutMs,
    });
    try {
      this.attachServer(server);
      if (scheme === "http" && this.#securityPolicy.enabled) {
        server.once("listening", () => {
          process.stderr.write("legacy SSE plaintext transport enabled\n");
        });
      }
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
    await this.#handleRequest(request, response, "none");
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    expectation: "none" | "continue" | "unsupported",
  ): Promise<void> {
    try {
      if (!this.#admitRouteAttempt()) {
        sendPreBodyRejection(request, response, 429, "Too Many Requests");
        return;
      }

      if (hasDuplicateSecurityHeaders(request)) {
        sendPreBodyRejection(request, response, 400, "Bad Request");
        return;
      }
      if (hasAmbiguousFramingHeaders(request)) {
        sendPreBodyRejection(request, response, 400, "Bad Request");
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
      if (expectation === "unsupported") {
        sendPreBodyRejection(request, response, 417, "Expectation Failed");
        return;
      }
      if (request.method !== expectedMethod) {
        sendPreBodyRejection(request, response, 405, "Method Not Allowed");
        return;
      }

      if (isSseRoute && requestDeclaresBody(request)) {
        sendPreBodyRejection(
          request,
          response,
          400,
          "Request body not allowed",
        );
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
      if (expectation === "continue") response.writeContinue();
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
    const completion = Promise.withResolvers<void>();
    this.#closePromise = completion.promise;
    void this.#performClose().then(completion.resolve, completion.reject);
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
      const requestHeaders: LegacySseRequestHeaders = {
        method,
        ...(host === undefined ? {} : { host }),
        ...(origin === undefined ? {} : { origin }),
        ...(authorization === undefined ? {} : { authorization }),
        ...(antiCsrf === undefined ? {} : { antiCsrf }),
      };
      if (this.#securityPolicy.networkExposed) {
        evaluateLegacySseRequest(
          requestHeaders,
          this.#securityPolicy,
          this.#bearerCredential,
        );
      }
      return evaluateLegacySseRequest(
        requestHeaders,
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
    const streamBudgetKey = Object.freeze({});
    const abortController = new AbortController();
    try {
      cleanupWriter = installBoundedSseWriter(
        response,
        this.#securityPolicy.maxResponseMessageBytes,
        this.#securityPolicy.maxResponseBufferedBytes,
        this.#securityPolicy.responseBackpressureTimeoutMs,
        (byteLength) =>
          this.#reserveQueuedResponseBytes(
            principal.principalId,
            streamBudgetKey,
            byteLength,
          ),
        () => {
          this.#onDiagnostic?.({ code: "response_capacity_exceeded" });
        },
      );
      transport = this.#transportFactory("/messages", response);
      const sessionId = transport.sessionId;
      if (!SESSION_ID.test(sessionId) || this.#entries.has(sessionId)) {
        throw new Error("Legacy SSE transport returned an invalid routing ID");
      }
      const server = createMcpServer(this.#handlerRegistry, {
        admissionKey: this.#handlerRegistry,
        lifetimeSignal: abortController.signal,
      });
      entry = {
        principalId: principal.principalId,
        transport,
        server,
        admission,
        cleanupWriter,
        abortController,
        idleTimer: undefined,
      };
      transport.onclose = () => {
        void this.#retireRoutingEntry(sessionId, entry!, "transport_closed");
      };
      this.#entries.set(sessionId, entry);
      this.#refreshIdleTimer(sessionId, entry);
      await server.connect(transport);
    } catch (error) {
      const retirement =
        entry === undefined
          ? undefined
          : this.#retireRoutingEntry(transport!.sessionId, entry);
      if (entry === undefined) {
        cleanupWriter?.();
        this.#releaseAdmission(admission);
      }
      if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
      await retirement;
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
    const lifecycle = this.#createPostLifecycle(request, response);
    this.#activePostLifecycles.add(lifecycle);
    let releaseBodyCapacity: (() => void) | undefined;
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
      if (
        declaredLength !== undefined &&
        declaredLength > MCP_TRANSPORT_MAX_REQUEST_BYTES
      ) {
        sendPreBodyRejection(request, response, 400, "Request body too large");
        return;
      }

      const body = await readBody(
        request,
        declaredLength,
        this.#securityPolicy.requestBodyIdleTimeoutMs,
        this.#securityPolicy.requestBodyTotalTimeoutMs,
        (byteLength) =>
          this.#reserveRequestBodyBytes(
            principal.principalId,
            sessionId,
            byteLength,
          ),
        (byteLength) =>
          this.#releaseRequestBodyBytes(
            principal.principalId,
            sessionId,
            byteLength,
          ),
      );
      releaseBodyCapacity = body.release;
      if (body.kind === "capacity_exceeded") {
        sendText(response, 429, "Too Many Requests", true);
        return;
      }
      if (body.kind === "too_large") {
        sendText(response, 400, "Request body too large", true);
        return;
      }
      if (body.kind === "timeout") {
        sendText(response, 408, "Request Timeout", true);
        return;
      }
      if (body.kind === "aborted") {
        if (
          !response.headersSent &&
          !response.writableEnded &&
          !response.destroyed
        ) {
          sendText(response, 400, "Bad Request", true);
        }
        return;
      }

      let text: string;
      try {
        text = FATAL_UTF8_DECODER.decode(body.bytes);
      } catch {
        sendText(response, 400, "Invalid UTF-8");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
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
      releaseBodyCapacity?.();
      this.#releasePostAdmission(admission);
      this.#activePostLifecycles.delete(lifecycle);
      lifecycle.resolveSettled();
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
    const sessionBucketKey = postSessionBucketKey(principalId, sessionId);
    if (!this.#admitPostRate(principalId, sessionBucketKey)) return undefined;
    const principalActive = this.#activePostsByPrincipal.get(principalId) ?? 0;
    const sessionActive = this.#activePostsBySession.get(sessionBucketKey) ?? 0;
    if (
      this.#activePosts >= this.#securityPolicy.maxConcurrentPosts ||
      principalActive >= this.#securityPolicy.maxConcurrentPostsPerPrincipal ||
      sessionActive >= this.#securityPolicy.maxConcurrentPostsPerSession
    ) {
      return undefined;
    }

    this.#activePosts += 1;
    this.#activePostsByPrincipal.set(principalId, principalActive + 1);
    this.#activePostsBySession.set(sessionBucketKey, sessionActive + 1);
    return { principalId, sessionBucketKey, released: false };
  }

  #admitPostRate(principalId: string, sessionBucketKey: string): boolean {
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
    const principalCount = this.#postRateByPrincipal.get(principalId) ?? 0;
    const sessionCount = this.#postRateBySession.get(sessionBucketKey) ?? 0;
    if (
      this.#postRateCount >= this.#securityPolicy.postRateLimit ||
      principalCount >= this.#securityPolicy.postRateLimitPerPrincipal ||
      sessionCount >= this.#securityPolicy.postRateLimitPerSession
    ) {
      return false;
    }

    this.#postRateCount += 1;
    this.#postRateByPrincipal.set(principalId, principalCount + 1);
    this.#postRateBySession.set(sessionBucketKey, sessionCount + 1);
    return true;
  }

  #releasePostAdmission(admission: PostAdmission): void {
    if (admission.released) return;
    admission.released = true;
    this.#activePosts -= 1;
    decrementCount(this.#activePostsByPrincipal, admission.principalId);
    decrementCount(this.#activePostsBySession, admission.sessionBucketKey);
  }

  #reserveRequestBodyBytes(
    principalId: string,
    sessionId: string,
    byteLength: number,
  ): boolean {
    const principalBytes =
      this.#activeRequestBodyBytesByPrincipal.get(principalId) ?? 0;
    const sessionBytes =
      this.#activeRequestBodyBytesBySession.get(sessionId) ?? 0;
    if (
      byteLength >
        LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES -
          this.#activeRequestBodyBytes ||
      byteLength >
        LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_PRINCIPAL - principalBytes ||
      byteLength >
        LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_SESSION - sessionBytes
    ) {
      return false;
    }
    this.#activeRequestBodyBytes += byteLength;
    this.#activeRequestBodyBytesByPrincipal.set(
      principalId,
      principalBytes + byteLength,
    );
    this.#activeRequestBodyBytesBySession.set(
      sessionId,
      sessionBytes + byteLength,
    );
    return true;
  }

  #releaseRequestBodyBytes(
    principalId: string,
    sessionId: string,
    byteLength: number,
  ): void {
    this.#activeRequestBodyBytes -= byteLength;
    decrementBytes(
      this.#activeRequestBodyBytesByPrincipal,
      principalId,
      byteLength,
    );
    decrementBytes(
      this.#activeRequestBodyBytesBySession,
      sessionId,
      byteLength,
    );
  }

  #reserveQueuedResponseBytes(
    principalId: string,
    streamKey: object,
    byteLength: number,
  ): (() => void) | undefined {
    const principalBytes =
      this.#queuedResponseBytesByPrincipal.get(principalId) ?? 0;
    const streamBytes = this.#queuedResponseBytesByStream.get(streamKey) ?? 0;
    if (
      byteLength >
        LEGACY_SSE_QUEUED_RESPONSE_BUDGET_BYTES - this.#queuedResponseBytes ||
      byteLength >
        LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_PRINCIPAL - principalBytes ||
      byteLength > LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_STREAM - streamBytes
    ) {
      return undefined;
    }
    this.#queuedResponseBytes += byteLength;
    this.#queuedResponseBytesByPrincipal.set(
      principalId,
      principalBytes + byteLength,
    );
    this.#queuedResponseBytesByStream.set(streamKey, streamBytes + byteLength);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#queuedResponseBytes -= byteLength;
      decrementBytes(
        this.#queuedResponseBytesByPrincipal,
        principalId,
        byteLength,
      );
      const remainingStreamBytes =
        (this.#queuedResponseBytesByStream.get(streamKey) ?? 0) - byteLength;
      if (remainingStreamBytes === 0) {
        this.#queuedResponseBytesByStream.delete(streamKey);
      } else {
        this.#queuedResponseBytesByStream.set(streamKey, remainingStreamBytes);
      }
    };
  }

  #refreshIdleTimer(sessionId: string, entry: RoutingEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.#expireEntry(sessionId, entry);
    }, this.#securityPolicy.sessionIdleTimeoutMs);
    entry.idleTimer.unref();
  }

  async #expireEntry(sessionId: string, entry: RoutingEntry): Promise<void> {
    await this.#retireRoutingEntry(sessionId, entry, "transport_closed");
  }

  #retireRoutingEntry(
    sessionId: string,
    entry: RoutingEntry,
    diagnostic?: "transport_closed",
  ): Promise<void> | undefined {
    if (this.#entries.get(sessionId) !== entry) return undefined;

    const completion = Promise.withResolvers<void>();
    const retirement = completion.promise;
    this.#retiringServerCloses.add(retirement);
    const settle = () => {
      this.#retiringServerCloses.delete(retirement);
      completion.resolve();
    };
    if (!this.#removeEntry(sessionId, entry, diagnostic)) {
      settle();
      return retirement;
    }

    void Promise.resolve()
      .then(() => entry.server.close())
      .then(settle, () => {
        try {
          this.#onDiagnostic?.({ code: "unexpected_error" });
        } finally {
          settle();
        }
      })
      .catch(() => undefined);
    return retirement;
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
    entry.abortController.abort();
    entry.cleanupWriter();
    this.#releaseAdmission(entry.admission);
    if (diagnostic !== undefined) this.#onDiagnostic?.({ code: diagnostic });
    return true;
  }

  async #awaitRetirementQuiescence(): Promise<void> {
    while (this.#retiringServerCloses.size !== 0) {
      await Promise.all([...this.#retiringServerCloses]);
    }
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.entries()];
    const activePosts = [...this.#activePostLifecycles];
    for (const [sessionId, entry] of entries) {
      void this.#retireRoutingEntry(sessionId, entry);
    }
    for (const lifecycle of activePosts) {
      lifecycle.request.pause();
      lifecycle.request.destroy();
      lifecycle.response.destroy();
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
    await Promise.all([
      this.#awaitRetirementQuiescence(),
      ...activePosts.map(({ settled }) => settled),
    ]);
    if (
      this.#activePosts !== 0 ||
      this.#activePostLifecycles.size !== 0 ||
      this.#activeRequestBodyBytes !== 0 ||
      this.#activeRequestBodyBytesByPrincipal.size !== 0 ||
      this.#activeRequestBodyBytesBySession.size !== 0 ||
      this.#queuedResponseBytes !== 0 ||
      this.#queuedResponseBytesByPrincipal.size !== 0
    ) {
      throw new Error("Legacy SSE adapter cleanup invariant failed");
    }
  }
}

interface HeaderDeadlineState {
  activeRequests: number;
  timer: NodeJS.Timeout | undefined;
}

function installAbsoluteHeaderDeadline(
  server: LegacySseNodeServer,
  timeoutMs: number,
  scheme: "http" | "https",
): void {
  const states = new WeakMap<Socket, HeaderDeadlineState>();
  const clearDeadline = (state: HeaderDeadlineState): void => {
    clearTimeout(state.timer);
    state.timer = undefined;
  };
  const armDeadline = (socket: Socket, state: HeaderDeadlineState): void => {
    clearDeadline(state);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      socket.destroy();
    }, timeoutMs);
    state.timer.unref();
  };
  const registerSocket = (socket: Socket): void => {
    if (states.has(socket)) {
      socket.destroy();
      return;
    }
    const state: HeaderDeadlineState = {
      activeRequests: 0,
      timer: undefined,
    };
    states.set(socket, state);
    armDeadline(socket, state);
    socket.once("close", () => clearDeadline(state));
  };

  if (scheme === "http") {
    server.on("connection", registerSocket);
  } else {
    (server as HttpsServer).on("secureConnection", registerSocket);
  }

  const admitHeaders = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    const socket = request.socket;
    const state = states.get(socket);
    if (state === undefined) {
      socket.destroy();
      return;
    }
    clearDeadline(state);
    state.activeRequests += 1;
    let settled = false;
    const settleRequest = (): void => {
      if (settled) return;
      settled = true;
      response.off("finish", settleRequest);
      response.off("close", settleRequest);
      state.activeRequests -= 1;
      if (
        state.activeRequests === 0 &&
        response.writableFinished &&
        response.shouldKeepAlive &&
        !socket.destroyed
      ) {
        armDeadline(socket, state);
      }
    };
    response.once("finish", settleRequest);
    response.once("close", settleRequest);
  };
  server.prependListener("request", admitHeaders);
  server.prependListener("checkContinue", admitHeaders);
  server.prependListener("checkExpectation", admitHeaders);
}

function installAbsoluteTlsHandshakeDeadline(
  server: HttpsServer,
  timeoutMs: number,
): void {
  const clearByConnection = new Map<string, () => void>();
  const connectionIdentity = (socket: Socket): string | undefined => {
    if (
      socket.remoteAddress === undefined ||
      socket.remotePort === undefined ||
      socket.localAddress === undefined ||
      socket.localPort === undefined
    ) {
      return undefined;
    }
    return [
      socket.remoteAddress,
      socket.remotePort,
      socket.localAddress,
      socket.localPort,
    ].join("\0");
  };

  server.on("connection", (socket) => {
    if (!(socket instanceof Socket)) {
      socket.destroy();
      return;
    }
    const identity = connectionIdentity(socket);
    if (identity === undefined || clearByConnection.has(identity)) {
      socket.destroy();
      return;
    }
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    timer.unref();
    const clearDeadline = (): void => {
      if (clearByConnection.get(identity) !== clearDeadline) return;
      clearByConnection.delete(identity);
      clearTimeout(timer);
      socket.off("close", clearDeadline);
    };
    clearByConnection.set(identity, clearDeadline);
    socket.once("close", clearDeadline);
  });

  server.on("secureConnection", (socket) => {
    const identity = connectionIdentity(socket);
    if (identity === undefined) {
      socket.destroy();
      return;
    }
    clearByConnection.get(identity)?.();
  });
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
    proof.absoluteHeaderTimeoutMs <= 0 ||
    proof.absoluteHeaderTimeoutMs > policy.requestHeaderTimeoutMs ||
    (proof.scheme === "https" &&
      (proof.tlsHandshakeTimeoutMs === null ||
        proof.tlsHandshakeTimeoutMs <= 0 ||
        proof.tlsHandshakeTimeoutMs > policy.requestHeaderTimeoutMs ||
        proof.absoluteTlsHandshakeTimeoutMs === null ||
        proof.absoluteTlsHandshakeTimeoutMs <= 0 ||
        proof.absoluteTlsHandshakeTimeoutMs > policy.requestHeaderTimeoutMs))
  ) {
    return false;
  }
  if (
    server.headersTimeout !== policy.requestHeaderTimeoutMs ||
    server.requestTimeout !== policy.requestBodyTotalTimeoutMs ||
    server.keepAliveTimeout !== policy.keepAliveTimeoutMs ||
    server.keepAliveTimeoutBuffer !== 0 ||
    !isImmutableKeepAliveTimeoutBuffer(server) ||
    server.maxHeadersCount !== 64 ||
    server.maxRequestsPerSocket !== 1_000 ||
    !hasImmutableHttpParserBounds(server) ||
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

const NOOP_BYTE_RELEASE = (): void => undefined;
const RESERVE_WITHOUT_SHARED_LIMIT = (): (() => void) => NOOP_BYTE_RELEASE;

export function installBoundedSseWriter(
  response: ServerResponse,
  maxMessageBytes: number,
  maxBufferedBytes: number,
  backpressureTimeoutMs: number,
  reserveQueuedBytes: (
    byteLength: number,
  ) => (() => void) | undefined = RESERVE_WITHOUT_SHARED_LIMIT,
  onCapacityExceeded: () => void = NOOP_BYTE_RELEASE,
): () => void {
  const originalWrite = response.write;
  const pendingReleases = new Set<() => void>();
  let backpressureTimer: NodeJS.Timeout | undefined;
  let cleaned = false;
  let failed = false;

  const releasePending = (): void => {
    for (const release of pendingReleases) release();
  };
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
  const failCapacity = (): void => {
    if (failed) return;
    try {
      onCapacityExceeded();
    } finally {
      failClosed();
    }
  };
  const armBackpressureTimer = (): void => {
    if (backpressureTimer !== undefined || failed) return;
    backpressureTimer = setTimeout(failClosed, backpressureTimeoutMs);
    backpressureTimer.unref();
  };
  const onDrain = (): void => {
    releasePending();
    clearBackpressureTimer();
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearBackpressureTimer();
    releasePending();
    response.off("drain", onDrain);
    response.off("close", cleanup);
    response.off("error", cleanup);
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
      failCapacity();
      return false;
    }
    const sharedRelease = reserveQueuedBytes(byteLength);
    if (sharedRelease === undefined) {
      failCapacity();
      return false;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      pendingReleases.delete(release);
      sharedRelease();
    };
    pendingReleases.add(release);
    const originalCallback =
      typeof encodingOrCallback === "function"
        ? (encodingOrCallback as (error?: Error | null) => void)
        : typeof callback === "function"
          ? (callback as (error?: Error | null) => void)
          : undefined;
    const completed = (error?: Error | null): void => {
      release();
      originalCallback?.call(response, error);
    };
    const writeArguments =
      typeof encodingOrCallback === "string"
        ? [chunk, encodingOrCallback, completed]
        : [chunk, completed];

    let accepted: boolean;
    try {
      accepted = Reflect.apply(
        originalWrite,
        response,
        writeArguments,
      ) as boolean;
    } catch (error) {
      release();
      throw error;
    }
    if (!accepted) armBackpressureTimer();
    return accepted;
  }) as typeof response.write;

  response.write = guardedWrite;
  response.on("drain", onDrain);
  response.on("close", cleanup);
  response.on("error", cleanup);
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

function decrementBytes(
  counts: Map<string, number>,
  key: string,
  byteLength: number,
): void {
  const remaining = (counts.get(key) ?? 0) - byteLength;
  if (remaining === 0) {
    counts.delete(key);
  } else {
    counts.set(key, remaining);
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

function isImmutableKeepAliveTimeoutBuffer(
  server: LegacySseNodeServer,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    server,
    "keepAliveTimeoutBuffer",
  );
  return (
    descriptor?.configurable === false &&
    descriptor.writable === false &&
    descriptor.value === 0
  );
}

function hasImmutableHttpParserBounds(server: LegacySseNodeServer): boolean {
  const maxHeaderSize = Object.getOwnPropertyDescriptor(
    server,
    "maxHeaderSize",
  );
  const insecureHttpParser = Object.getOwnPropertyDescriptor(
    server,
    "insecureHTTPParser",
  );
  return (
    maxHeaderSize?.configurable === false &&
    maxHeaderSize.writable === false &&
    maxHeaderSize.value === LEGACY_SSE_MAX_HEADER_BYTES &&
    insecureHttpParser?.configurable === false &&
    insecureHttpParser.writable === false &&
    insecureHttpParser.value === false
  );
}

function hasDuplicateSecurityHeaders(request: IncomingMessage): boolean {
  let seen = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    let mask = 0;
    if (name === "host") mask = 1;
    else if (name === "origin") mask = 2;
    else if (name === "authorization") mask = 4;
    else if (name === "x-jetkvm-csrf") mask = 8;
    if (mask === 0) continue;
    if ((seen & mask) !== 0) return true;
    seen |= mask;
  }
  return false;
}

function hasAmbiguousFramingHeaders(request: IncomingMessage): boolean {
  let contentLengthCount = 0;
  let contentTypeCount = 0;
  let transferEncodingCount = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name === "content-length") contentLengthCount += 1;
    else if (name === "content-type") contentTypeCount += 1;
    else if (name === "transfer-encoding") transferEncodingCount += 1;
    if (
      contentLengthCount > 1 ||
      contentTypeCount > 1 ||
      transferEncodingCount > 1
    ) {
      return true;
    }
  }
  return contentLengthCount > 0 && transferEncodingCount > 0;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    const next = request.rawHeaders[index + 1];
    if (value !== undefined || next === undefined) return undefined;
    value = next;
  }
  return value;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function postSessionBucketKey(principalId: string, sessionId: string): string {
  return `${principalId.length}:${principalId}${sessionId}`;
}

async function readBody(
  request: IncomingMessage,
  declaredLength: number | undefined,
  idleTimeoutMs: number,
  totalTimeoutMs: number,
  reserveCapacity: (byteLength: number) => boolean,
  releaseCapacity: (byteLength: number) => void,
): Promise<ReadBodyResult> {
  const completion = Promise.withResolvers<ReadBodyResult>();
  const maximumBodyBytes = declaredLength ?? MCP_TRANSPORT_MAX_REQUEST_BYTES;
  let bytes: Buffer | undefined;
  let byteLength = 0;
  let reservedBytes = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    bytes?.fill(0);
    bytes = undefined;
    if (reservedBytes === 0) return;
    releaseCapacity(reservedBytes);
    reservedBytes = 0;
  };
  const cleanup = (): void => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    idleTimer = undefined;
    totalTimer = undefined;
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("aborted", onAborted);
    request.off("error", onAborted);
  };
  const settle = (result: ReadBodyOutcome): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (result.kind !== "ok") request.pause();
    completion.resolve({ ...result, release });
  };
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => settle({ kind: "timeout" }), idleTimeoutMs);
    idleTimer.unref();
  };
  const ensureCapacity = (requiredBytes: number): boolean => {
    if (requiredBytes <= (bytes?.byteLength ?? 0)) return true;

    let nextCapacity = Math.min(
      INITIAL_REQUEST_BODY_BUFFER_BYTES,
      maximumBodyBytes,
    );
    while (nextCapacity < requiredBytes) {
      nextCapacity = Math.min(nextCapacity * 2, maximumBodyBytes);
    }
    if (!reserveCapacity(nextCapacity)) return false;

    try {
      const next = Buffer.allocUnsafe(nextCapacity);
      bytes?.copy(next, 0, 0, byteLength);
      bytes?.fill(0);
      if (reservedBytes !== 0) releaseCapacity(reservedBytes);
      bytes = next;
      reservedBytes = nextCapacity;
      return true;
    } catch (error) {
      releaseCapacity(nextCapacity);
      throw error;
    }
  };
  function onData(chunk: Buffer | string): void {
    armIdleTimer();
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      if (incoming.byteLength > maximumBodyBytes - byteLength) {
        settle({ kind: "too_large" });
        return;
      }
      if (!ensureCapacity(byteLength + incoming.byteLength)) {
        settle({ kind: "capacity_exceeded" });
        return;
      }
      incoming.copy(bytes!, byteLength);
      byteLength += incoming.byteLength;
    } finally {
      incoming.fill(0);
    }
  }
  function onEnd(): void {
    settle({
      kind: "ok",
      bytes:
        bytes === undefined
          ? EMPTY_REQUEST_BODY
          : bytes.subarray(0, byteLength),
    });
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

function requestDeclaresBody(request: IncomingMessage): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name === "transfer-encoding") return true;
    if (name !== "content-length") continue;
    const value = request.rawHeaders[index + 1];
    if (value === undefined || parseContentLength(value) !== 0) return true;
  }
  return false;
}

function sendPreBodyRejection(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  request.pause();
  sendText(response, statusCode, body, true);
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
