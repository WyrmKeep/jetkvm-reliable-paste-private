import { useCallback, useEffect } from "react";

import { useRTCStore, useFailsafeModeStore } from "@hooks/stores";

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params: object;
  id?: number | string;
}

export interface JsonRpcError {
  code: number;
  data?: string;
  message: string;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: string;
  result: unknown;
  id: string | number;
}

export interface JsonRpcErrorResponse {
  jsonrpc: string;
  error: JsonRpcError;
  id: string | number;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export const RpcMethodNotFound = -32601;

export type JsonRpcValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonRpcValue[]
  | { readonly [key: string]: JsonRpcValue };

const MAX_RPC_MESSAGE_UTF8_BYTES = 1_048_576;
const MAX_RPC_VALUE_DEPTH = 64;
const MAX_RPC_VALUE_NODES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcValue(value: unknown): value is JsonRpcValue {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) return false;
    visited += 1;
    if (visited > MAX_RPC_VALUE_NODES || current.depth > MAX_RPC_VALUE_DEPTH) return false;
    const candidate = current.value;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (typeof candidate !== "object") return false;
    const values = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (const child of values) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

export interface JsonRpcRequestChannel {
  readonly readyState: string;
  send(payload: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
type RoutedResponse = (payload: unknown) => void;
type RoutedRequest = (payload: JsonRpcRequest, channel: JsonRpcRequestChannel) => void;

function parseBoundedMessage(raw: string): unknown {
  if (
    raw.length > MAX_RPC_MESSAGE_UTF8_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_RPC_MESSAGE_UTF8_BYTES
  ) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

class JsonRpcChannelRouter {
  private readonly responses = new Map<number | string, Set<RoutedResponse>>();
  private readonly requests = new Set<RoutedRequest>();
  private readonly channel: JsonRpcRequestChannel;
  private readonly onMessage: EventListener = event => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    const decoded = parseBoundedMessage(event.data);
    if (!isRecord(decoded)) return;
    if (typeof decoded.method === "string") {
      if (
        decoded.jsonrpc !== "2.0" ||
        !isRecord(decoded.params) ||
        !isJsonRpcValue(decoded.params) ||
        (decoded.id !== undefined &&
          typeof decoded.id !== "string" &&
          typeof decoded.id !== "number")
      ) {
        return;
      }
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        method: decoded.method,
        params: decoded.params,
        ...(decoded.id === undefined ? {} : { id: decoded.id }),
      };
      for (const listener of this.requests) listener(request, this.channel);
      return;
    }
    if (typeof decoded.id !== "string" && typeof decoded.id !== "number") return;
    const listeners = this.responses.get(decoded.id);
    if (!listeners) return;
    this.responses.delete(decoded.id);
    for (const listener of listeners) listener(decoded);
  };
  private readonly onClose: EventListener = () => {
    this.responses.clear();
    this.requests.clear();
  };

  constructor(channel: JsonRpcRequestChannel) {
    this.channel = channel;
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("close", this.onClose);
  }

  registerResponse(id: number | string, listener: RoutedResponse): () => void {
    const listeners = this.responses.get(id) ?? new Set<RoutedResponse>();
    listeners.add(listener);
    this.responses.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.responses.delete(id);
    };
  }

  subscribeRequests(listener: RoutedRequest): () => void {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }
}

const CHANNEL_ROUTERS = new WeakMap<object, JsonRpcChannelRouter>();

function routerFor(channel: JsonRpcRequestChannel): JsonRpcChannelRouter {
  let router = CHANNEL_ROUTERS.get(channel);
  if (!router) {
    router = new JsonRpcChannelRouter(channel);
    CHANNEL_ROUTERS.set(channel, router);
  }
  return router;
}

export interface JsonRpcRequestOptions {
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onWrite: () => void;
}

export type JsonRpcRequestFailureCode =
  | "INVALID_REQUEST"
  | "CHANNEL_CLOSED"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "MALFORMED_RESPONSE"
  | "EDID_READ_FAILED"
  | "ATX_EXTENSION_INACTIVE"
  | "ATX_SERIAL_UNAVAILABLE"
  | "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT"
  | "STALE_SESSION_GENERATION"
  | "MUTATION_OUTCOME_UNKNOWN"
  | "CONFIG_INVALID"
  | "DOWNSTREAM_MALFORMED_RESPONSE"
  | "DOWNSTREAM_ERROR";

const REQUEST_FAILURE_MESSAGE: Record<JsonRpcRequestFailureCode, string> = {
  INVALID_REQUEST: "The product RPC request is invalid.",
  CHANNEL_CLOSED: "The product RPC channel is closed.",
  CANCELLED: "The product RPC request was cancelled.",
  DEADLINE_EXCEEDED: "The product RPC deadline elapsed.",
  MALFORMED_RESPONSE: "The product RPC response was invalid.",
  EDID_READ_FAILED: "The product EDID read failed.",
  DOWNSTREAM_ERROR: "The product RPC request failed.",
  ATX_EXTENSION_INACTIVE: "The ATX extension is inactive.",
  ATX_SERIAL_UNAVAILABLE: "The ATX serial controller is unavailable.",
  REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT: "The ATX request id was reused with different input.",
  STALE_SESSION_GENERATION: "The device session generation is stale.",
  MUTATION_OUTCOME_UNKNOWN: "The ATX mutation outcome is unknown.",
  CONFIG_INVALID: "The ATX action configuration is invalid.",
  DOWNSTREAM_MALFORMED_RESPONSE: "The ATX response was malformed.",
};

export class JsonRpcRequestFailure extends Error {
  readonly code: JsonRpcRequestFailureCode;
  readonly writeBegan: boolean;

  constructor(code: JsonRpcRequestFailureCode, writeBegan: boolean) {
    super(REQUEST_FAILURE_MESSAGE[code]);
    this.name = "JsonRpcRequestFailure";
    this.code = code;
    this.writeBegan = writeBegan;
  }
}

const ATX_REQUEST_FAILURE_CODES = new Set<JsonRpcRequestFailureCode>([
  "ATX_EXTENSION_INACTIVE",
  "ATX_SERIAL_UNAVAILABLE",
  "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
  "STALE_SESSION_GENERATION",
  "MUTATION_OUTCOME_UNKNOWN",
  "CONFIG_INVALID",
  "DOWNSTREAM_MALFORMED_RESPONSE",
]);

export function requestJsonRpc(
  channel: JsonRpcRequestChannel,
  method: string,
  params: unknown,
  options: JsonRpcRequestOptions,
): Promise<JsonRpcValue> {
  if (
    channel.readyState !== "open" ||
    typeof method !== "string" ||
    method.length === 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 300_000 ||
    options.signal.aborted
  ) {
    const code = channel.readyState !== "open" ? "CHANNEL_CLOSED" : "INVALID_REQUEST";
    return Promise.reject(new JsonRpcRequestFailure(code, false));
  }

  requestCounter += 1;
  const id = `automation:${requestCounter}`;
  const completion = Promise.withResolvers<JsonRpcValue>();
  let settled = false;
  let writeBegan = false;
  let unregisterResponse: () => void = () => undefined;

  const cleanup = () => {
    clearTimeout(timer);
    unregisterResponse();
    options.signal.removeEventListener("abort", onAbort);
    channel.removeEventListener("close", onClose);
  };
  const reject = (code: JsonRpcRequestFailureCode) => {
    if (settled) return;
    settled = true;
    cleanup();
    completion.reject(new JsonRpcRequestFailure(code, writeBegan));
  };
  const onAbort = () => reject("CANCELLED");
  const onClose = () => reject("CHANNEL_CLOSED");
  const onResponse = (decoded: unknown) => {
    if (!isRecord(decoded) || decoded.id !== id) return;
    const keys = Object.keys(decoded);
    const hasResult = Object.hasOwn(decoded, "result");
    const hasError = Object.hasOwn(decoded, "error");
    if (
      decoded.jsonrpc !== "2.0" ||
      hasResult === hasError ||
      keys.some(key => !["jsonrpc", "id", "result", "error"].includes(key))
    ) {
      reject("MALFORMED_RESPONSE");
      return;
    }
    if (hasError) {
      const error = decoded.error;
      const marker = isRecord(error) ? error.data : undefined;
      if (method === "getEDID" && marker === "EDID_READ_FAILED") {
        reject("EDID_READ_FAILED");
      } else if (
        method === "performATXAction" &&
        typeof marker === "string" &&
        ATX_REQUEST_FAILURE_CODES.has(marker as JsonRpcRequestFailureCode)
      ) {
        reject(marker as JsonRpcRequestFailureCode);
      } else {
        reject("DOWNSTREAM_ERROR");
      }
      return;
    }
    if (!isJsonRpcValue(decoded.result)) {
      reject("MALFORMED_RESPONSE");
      return;
    }
    settled = true;
    cleanup();
    completion.resolve(decoded.result);
  };
  const timer = setTimeout(() => reject("DEADLINE_EXCEEDED"), options.timeoutMs);
  unregisterResponse = routerFor(channel).registerResponse(id, onResponse);
  options.signal.addEventListener("abort", onAbort, { once: true });
  channel.addEventListener("close", onClose);

  try {
    channel.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    writeBegan = true;
    options.onWrite();
  } catch {
    reject("CHANNEL_CLOSED");
  }
  return completion.promise;
}

let requestCounter = 0;

// Map of blocked RPC methods by failsafe reason
const blockedMethodsByReason: Record<string, string[]> = {
  video: [
    "setStreamQualityFactor",
    "getEDID",
    "setEDID",
    "getVideoLogStatus",
    "setDisplayRotation",
    "getVideoSleepMode",
    "setVideoSleepMode",
    "getVideoState",
  ],
};

function parseJsonRpcResponse(payload: unknown): JsonRpcResponse | null {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") return null;
  if (typeof payload.id !== "string" && typeof payload.id !== "number") return null;
  const hasResult = Object.hasOwn(payload, "result");
  const hasError = Object.hasOwn(payload, "error");
  if (hasResult === hasError) return null;
  if (hasResult) {
    if (!isJsonRpcValue(payload.result)) return null;
    return {
      jsonrpc: "2.0",
      id: payload.id,
      result: payload.result,
    };
  }
  if (
    !isRecord(payload.error) ||
    typeof payload.error.code !== "number" ||
    !Number.isFinite(payload.error.code) ||
    typeof payload.error.message !== "string" ||
    (payload.error.data !== undefined && typeof payload.error.data !== "string")
  ) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id: payload.id,
    error: {
      code: payload.error.code,
      message: payload.error.message,
      ...(payload.error.data === undefined ? {} : { data: payload.error.data }),
    },
  };
}

export function useJsonRpc(
  onRequest?: (payload: JsonRpcRequest, channel: JsonRpcRequestChannel) => void,
) {
  const { rpcDataChannel } = useRTCStore();

  const send = useCallback(
    async (method: string, params: unknown, callback?: (resp: JsonRpcResponse) => void) => {
      const { rpcDataChannel: channel } = useRTCStore.getState();
      if (channel?.readyState !== "open") return;
      const { isFailsafeMode, reason } = useFailsafeModeStore.getState();

      if (isFailsafeMode && reason) {
        const blockedMethods = blockedMethodsByReason[reason] || [];
        if (blockedMethods.includes(method)) {
          console.warn(`RPC method "${method}" is blocked in failsafe mode (reason: ${reason})`);
          if (callback) {
            const errorResponse: JsonRpcErrorResponse = {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Method unavailable in failsafe mode",
                data: `This feature is unavailable while in failsafe mode (${reason})`,
              },
              id: requestCounter + 1,
            };
            callback(errorResponse);
          }
          return;
        }
      }

      requestCounter += 1;
      const payload = { jsonrpc: "2.0", method, params, id: requestCounter };
      const unregister =
        callback === undefined
          ? () => undefined
          : routerFor(channel).registerResponse(payload.id, response => {
              const parsed = parseJsonRpcResponse(response);
              if (!parsed) return;
              if ("error" in parsed) console.error("RPC error response received");
              callback(parsed);
            });
      try {
        channel.send(JSON.stringify(payload));
      } catch {
        unregister();
      }
    },
    [],
  );

  const request = useCallback(
    async (method: string, params: unknown, options: JsonRpcRequestOptions) => {
      const { rpcDataChannel: channel } = useRTCStore.getState();
      if (!channel) throw new JsonRpcRequestFailure("CHANNEL_CLOSED", false);
      const { isFailsafeMode, reason } = useFailsafeModeStore.getState();
      if (isFailsafeMode && reason) {
        const blockedMethods = blockedMethodsByReason[reason] || [];
        if (blockedMethods.includes(method)) {
          throw new JsonRpcRequestFailure("DOWNSTREAM_ERROR", false);
        }
      }
      return requestJsonRpc(channel, method, params, options);
    },
    [],
  );

  useEffect(() => {
    if (!rpcDataChannel || !onRequest) return;
    return routerFor(rpcDataChannel).subscribeRequests(onRequest);
  }, [rpcDataChannel, onRequest]);

  return { request, send };
}
