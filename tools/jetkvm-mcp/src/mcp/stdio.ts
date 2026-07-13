import process from "node:process";
import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { createMcpServer, type HandlerRegistry } from "./server.js";

export interface StdioServerOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly onError?: (error: Error) => void;
}

export interface StdioServerHandle {
  readonly server: Server;
  readonly transport: StdioServerTransport;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

function reportProtocolError(_error: Error): void {
  process.stderr.write("jetkvm-mcp: malformed stdio protocol frame\n");
}

export async function startStdioServer(
  handlerRegistry: HandlerRegistry = {},
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  const server = createMcpServer(handlerRegistry);
  const closedState = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const onEof = (): void => {
    void close();
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = performClose();
    return closePromise;
  };

  const performClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stdin.off("end", onEof);
    stdin.off("close", onEof);
    try {
      await server.close();
    } finally {
      closedState.resolve();
    }
  };

  transport.onerror = options.onError ?? reportProtocolError;
  stdin.once("end", onEof);
  stdin.once("close", onEof);

  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    server,
    transport,
    closed: closedState.promise,
    close,
    isClosed: () => closed,
  };
}
