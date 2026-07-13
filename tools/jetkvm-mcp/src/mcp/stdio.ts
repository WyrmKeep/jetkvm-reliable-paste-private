import process from "node:process";
import { PassThrough, Writable, type Readable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { createMcpServer, type HandlerRegistry } from "./server.js";

const MAXIMUM_FRAME_BYTES = 1_048_576;
const MAXIMUM_OUTPUT_QUEUE_BYTES = 16 * 1024 * 1024;
const OUTPUT_WRITE_TIMEOUT_MS = 10_000;

class StdioFrameBoundaryError extends Error {}
class StdioOutputBoundaryError extends Error {}

class BoundedStdioFrameGate {
  readonly output = new PassThrough();
  #pending: Buffer | undefined;
  #pendingBytes = 0;
  #started = false;
  #closed = false;

  constructor(
    readonly input: Readable,
    readonly onFailure: (error: Error) => void,
    readonly onEnd: () => void,
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.input.on("data", this.#onData);
    this.input.once("error", this.#onInputError);
    this.input.once("end", this.#onEnd);
    this.input.once("close", this.#onEnd);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.input.off("data", this.#onData);
    this.input.off("error", this.#onInputError);
    this.input.off("end", this.#onEnd);
    this.input.off("close", this.#onEnd);
    this.#pendingBytes = 0;
    this.output.end();
  }

  readonly #onData = (chunk: Buffer | Uint8Array | string): void => {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        this.#appendPending(bytes.subarray(offset));
        return;
      }

      const segment = bytes.subarray(offset, newline + 1);
      const beforeNewline =
        segment.byteLength >= 2
          ? segment[segment.byteLength - 2]
          : this.#pendingByteBeforeNewline();
      const contentBytes =
        this.#pendingBytes +
        segment.byteLength -
        1 -
        (beforeNewline === 0x0d ? 1 : 0);
      if (contentBytes > MAXIMUM_FRAME_BYTES) {
        this.#fail(
          new StdioFrameBoundaryError(
            `Inbound stdio frame exceeds ${MAXIMUM_FRAME_BYTES} bytes`,
          ),
        );
        return;
      }

      if (this.#pendingBytes === 0) {
        this.output.write(segment);
      } else {
        const pending = this.#pending;
        if (pending === undefined) {
          this.#fail(
            new StdioFrameBoundaryError("Stdio frame gate lost buffered bytes"),
          );
          return;
        }
        this.output.write(
          Buffer.concat(
            [pending.subarray(0, this.#pendingBytes), segment],
            this.#pendingBytes + segment.byteLength,
          ),
        );
      }
      this.#pendingBytes = 0;
      offset = newline + 1;
    }
  };

  readonly #onInputError = (): void => {
    this.#fail(new StdioFrameBoundaryError("Stdio input stream failed"));
  };

  readonly #onEnd = (): void => {
    if (this.#closed) return;
    if (this.#pendingBytes !== 0) {
      this.#fail(new StdioFrameBoundaryError("Incomplete stdio frame at EOF"));
      return;
    }
    this.close();
    this.onEnd();
  };

  #appendPending(bytes: Buffer): void {
    const nextTotal = this.#pendingBytes + bytes.byteLength;
    const lastByte = bytes.at(-1) ?? this.#pendingByteBeforeNewline();
    if (
      nextTotal > MAXIMUM_FRAME_BYTES + 1 ||
      (nextTotal === MAXIMUM_FRAME_BYTES + 1 && lastByte !== 0x0d)
    ) {
      this.#fail(
        new StdioFrameBoundaryError(
          `Inbound stdio frame exceeds ${MAXIMUM_FRAME_BYTES} bytes`,
        ),
      );
      return;
    }

    this.#pending ??= Buffer.allocUnsafe(MAXIMUM_FRAME_BYTES + 1);
    bytes.copy(this.#pending, this.#pendingBytes);
    this.#pendingBytes = nextTotal;
  }

  #pendingByteBeforeNewline(): number | undefined {
    return this.#pendingBytes === 0
      ? undefined
      : this.#pending?.[this.#pendingBytes - 1];
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close();
    this.onFailure(error);
  }
}

class BoundedStdioOutputGate extends Writable {
  #queuedBytes = 0;
  #activeBytes = 0;
  #activeCallback: ((error?: Error | null) => void) | undefined;
  #writeTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(
    readonly output: Writable,
    readonly onFailure: (error: Error) => void,
  ) {
    super({ highWaterMark: MAXIMUM_OUTPUT_QUEUE_BYTES });
    this.output.on("error", this.#onOutputError);
  }

  override write(
    chunk: Uint8Array | string,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: Uint8Array | string,
    encoding: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const completion =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const byteLength =
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, encoding)
        : chunk.byteLength;
    if (this.#closed) {
      completion?.();
      return true;
    }
    if (this.#queuedBytes + byteLength > MAXIMUM_OUTPUT_QUEUE_BYTES) {
      completion?.();
      this.#fail(
        new StdioOutputBoundaryError(
          `Outbound stdio queue exceeds ${MAXIMUM_OUTPUT_QUEUE_BYTES} bytes`,
        ),
      );
      return true;
    }

    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
    this.#queuedBytes += bytes.byteLength;
    try {
      return completion === undefined
        ? super.write(bytes)
        : super.write(bytes, completion);
    } catch {
      this.#queuedBytes -= bytes.byteLength;
      this.#fail(new StdioOutputBoundaryError("Outbound stdio stream failed"));
      return true;
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#activeBytes = chunk.byteLength;
    this.#activeCallback = callback;
    this.#writeTimer = setTimeout(() => {
      this.#fail(
        new StdioOutputBoundaryError(
          `Outbound stdio write timed out after ${OUTPUT_WRITE_TIMEOUT_MS} ms`,
        ),
      );
    }, OUTPUT_WRITE_TIMEOUT_MS);
    this.#writeTimer.unref();

    try {
      this.output.write(chunk, (error) => {
        if (error) {
          this.#fail(
            new StdioOutputBoundaryError("Outbound stdio stream failed"),
          );
          return;
        }
        this.#finishActiveWrite();
      });
    } catch {
      this.#fail(new StdioOutputBoundaryError("Outbound stdio stream failed"));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.output.off("error", this.#onOutputError);
    clearTimeout(this.#writeTimer);
    this.#writeTimer = undefined;
    const callback = this.#activeCallback;
    this.#activeCallback = undefined;
    this.#activeBytes = 0;
    this.#queuedBytes = 0;
    this.destroy();
    callback?.();
  }

  readonly #onOutputError = (): void => {
    this.#fail(new StdioOutputBoundaryError("Outbound stdio stream failed"));
  };

  #finishActiveWrite(): void {
    const callback = this.#activeCallback;
    if (callback === undefined) return;
    const completedBytes = this.#activeBytes;
    clearTimeout(this.#writeTimer);
    this.#writeTimer = undefined;
    this.#activeCallback = undefined;
    this.#activeBytes = 0;
    this.#queuedBytes -= completedBytes;
    callback();
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close();
    this.onFailure(error);
  }
}

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

function reportProtocolError(error: Error): void {
  let diagnostic: string;
  if (error instanceof StdioOutputBoundaryError) {
    diagnostic = error.message.includes("queue")
      ? "stdio output queue overflow"
      : error.message.includes("timed out")
        ? "stdio output write timeout"
        : "stdio output failure";
  } else if (error instanceof StdioFrameBoundaryError) {
    diagnostic = error.message.startsWith("Inbound stdio frame")
      ? "oversized stdio protocol frame"
      : error.message === "Incomplete stdio frame at EOF"
        ? "incomplete stdio protocol frame"
        : "stdio input failure";
  } else {
    diagnostic = "malformed stdio protocol frame";
  }
  process.stderr.write(`jetkvm-mcp: ${diagnostic}\n`);
}

export async function startStdioServer(
  handlerRegistry: HandlerRegistry = {},
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const reportError = options.onError ?? reportProtocolError;
  const server = createMcpServer(handlerRegistry);
  const closedState = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  let gate: BoundedStdioFrameGate;
  let outputGate: BoundedStdioOutputGate;

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = performClose();
    return closePromise;
  };

  const performClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    gate.close();
    outputGate.close();
    try {
      await server.close();
    } finally {
      closedState.resolve();
    }
  };

  outputGate = new BoundedStdioOutputGate(stdout, (error) => {
    reportError(error);
    void close();
  });
  gate = new BoundedStdioFrameGate(
    stdin,
    (error) => {
      reportError(error);
      void close();
    },
    () => {
      void close();
    },
  );
  const transport = new StdioServerTransport(gate.output, outputGate);
  transport.onerror = reportError;

  try {
    await server.connect(transport);
    gate.start();
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
