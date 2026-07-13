import { isUtf8 } from "node:buffer";
import process from "node:process";
import { PassThrough, Writable, type Readable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { MCP_TRANSPORT_MAX_REQUEST_BYTES } from "../config.js";
import {
  assertHandlerRegistry,
  createMcpServer,
  type HandlerRegistry,
} from "./server.js";

const MAXIMUM_FRAME_BYTES = MCP_TRANSPORT_MAX_REQUEST_BYTES;
const MAXIMUM_OUTPUT_QUEUE_BYTES = 16 * 1024 * 1024;
const OUTPUT_WRITE_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000;
const MAXIMUM_MALFORMED_FRAMES = 32;

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
    readonly onMalformed: (error: Error) => void,
    readonly onEnd: () => void,
    readonly allocatePendingBuffer: (size: number) => Buffer,
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
    if (this.input.listenerCount("data") === 0) this.input.pause();
    this.#zeroPending();
    this.output.end();
  }

  abortInput(destroyInput: boolean): void {
    this.close();
    if (!destroyInput || this.input.listenerCount("data") !== 0) return;
    try {
      this.input.destroy();
    } catch {
      // The output boundary remains the only public failure.
    }
    const unref = (this.input as Readable & { unref?: () => void }).unref;
    try {
      unref?.call(this.input);
    } catch {
      // The output boundary remains the only public failure.
    }
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

      let frame: Buffer;
      if (this.#pendingBytes === 0) {
        frame = Buffer.from(segment);
      } else {
        const pending = this.#pending;
        if (pending === undefined) {
          this.#fail(
            new StdioFrameBoundaryError("Stdio frame gate lost buffered bytes"),
          );
          return;
        }
        frame = Buffer.concat(
          [pending.subarray(0, this.#pendingBytes), segment],
          this.#pendingBytes + segment.byteLength,
        );
      }
      this.#zeroPending();
      if (!isUtf8(frame)) {
        frame.fill(0);
        this.onMalformed(new Error("Invalid UTF-8 stdio protocol frame"));
        if (this.#closed) return;
        offset = newline + 1;
        continue;
      }
      try {
        this.output.write(frame);
      } finally {
        frame.fill(0);
      }
      if (this.#closed) return;
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

    if (this.#pending === undefined) {
      const allocated = this.allocatePendingBuffer(MAXIMUM_FRAME_BYTES + 1);
      if (
        !Buffer.isBuffer(allocated) ||
        allocated.byteLength < MAXIMUM_FRAME_BYTES + 1
      ) {
        this.#fail(
          new StdioFrameBoundaryError(
            "Stdio frame gate received an invalid pending buffer",
          ),
        );
        return;
      }
      this.#pending = allocated;
    }
    bytes.copy(this.#pending, this.#pendingBytes);
    this.#pendingBytes = nextTotal;
  }

  #pendingByteBeforeNewline(): number | undefined {
    return this.#pendingBytes === 0
      ? undefined
      : this.#pending?.[this.#pendingBytes - 1];
  }

  #zeroPending(): void {
    if (this.#pending !== undefined && this.#pendingBytes !== 0) {
      this.#pending.fill(0, 0, this.#pendingBytes);
    }
    this.#pendingBytes = 0;
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
  #awaitingOutputError = false;
  #listenerCleanupImmediate: NodeJS.Immediate | undefined;
  #underlyingWriteActive = false;
  #closed = false;

  constructor(
    readonly output: Writable,
    readonly onFailure: (error: Error) => void,
    readonly destroyOutputOnFailure: boolean,
  ) {
    super({ highWaterMark: MAXIMUM_OUTPUT_QUEUE_BYTES + 1 });
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
    this.#underlyingWriteActive = true;
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
        this.#underlyingWriteActive = false;
        if (error) {
          this.#expectOutputError();
          if (!this.#closed) {
            this.#fail(
              new StdioOutputBoundaryError("Outbound stdio stream failed"),
            );
          }
          return;
        }
        if (this.#closed) {
          this.#removeOutputErrorListener();
          return;
        }
        this.#finishActiveWrite();
      });
    } catch {
      this.#underlyingWriteActive = false;
      this.#fail(new StdioOutputBoundaryError("Outbound stdio stream failed"));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#awaitingOutputError && !this.#underlyingWriteActive) {
      this.#removeOutputErrorListener();
    }
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
    if (this.#awaitingOutputError) {
      this.#awaitingOutputError = false;
      this.#removeOutputErrorListener();
      return;
    }
    this.#underlyingWriteActive = false;
    if (this.#closed) {
      this.#removeOutputErrorListener();
      return;
    }
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

  #expectOutputError(): void {
    this.#awaitingOutputError = true;
    if (!this.output.listeners("error").includes(this.#onOutputError)) {
      this.output.on("error", this.#onOutputError);
    }
    clearImmediate(this.#listenerCleanupImmediate);
    this.#listenerCleanupImmediate = setImmediate(() => {
      this.#awaitingOutputError = false;
      this.#removeOutputErrorListener();
    });
    this.#listenerCleanupImmediate.unref();
  }

  #removeOutputErrorListener(): void {
    clearImmediate(this.#listenerCleanupImmediate);
    this.#listenerCleanupImmediate = undefined;
    this.output.off("error", this.#onOutputError);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close();
    if (this.destroyOutputOnFailure) {
      try {
        this.output.destroy();
      } catch {
        // The boundary failure below remains the only public diagnostic.
      }
      const unref = (this.output as Writable & { unref?: () => void }).unref;
      try {
        unref?.call(this.output);
      } catch {
        // The output boundary remains the only public failure.
      }
    }
    this.onFailure(error);
  }
}

class BoundedDiagnosticSink {
  #backpressured = false;
  #drainListening = false;
  #awaitingError = false;
  #listenerCleanupImmediate: NodeJS.Immediate | undefined;
  readonly #activeWrites = new Set<{
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  }>();
  #closed = false;

  constructor(readonly output: Writable) {
    this.output.on("error", this.#onError);
  }

  write(message: string): void {
    if (this.#closed || this.#backpressured) return;
    const activeWrite = Promise.withResolvers<void>();
    this.#activeWrites.add(activeWrite);
    let accepted: boolean;
    try {
      accepted = this.output.write(message, (error) => {
        this.#settleActiveWrite(activeWrite);
        if (error) {
          this.#expectErrorEvent();
          this.#disable();
          return;
        }
        if (
          this.#closed &&
          this.#activeWrites.size === 0 &&
          !this.#awaitingError
        ) {
          this.#removeErrorListener();
        }
      });
    } catch {
      this.#settleActiveWrite(activeWrite);
      this.#disable();
      return;
    }
    if (!accepted && !this.#closed) {
      this.#backpressured = true;
      if (!this.#drainListening) {
        this.#drainListening = true;
        this.output.once("drain", this.#onDrain);
      }
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    if (this.#activeWrites.size === 0) return;
    const pending = Promise.all(
      [...this.#activeWrites].map((activeWrite) => activeWrite.promise),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachDrain();
    if (this.#activeWrites.size === 0 && !this.#awaitingError) {
      this.#removeErrorListener();
    }
  }

  readonly #onDrain = (): void => {
    this.#drainListening = false;
    this.#backpressured = false;
  };

  readonly #onError = (): void => {
    if (this.#awaitingError) {
      this.#awaitingError = false;
      if (this.#activeWrites.size === 0) this.#removeErrorListener();
      return;
    }
    this.#disable();
  };

  #disable(): void {
    this.#closed = true;
    this.#detachDrain();
    if (this.#activeWrites.size === 0 && !this.#awaitingError) {
      this.#removeErrorListener();
    }
  }

  #detachDrain(): void {
    if (!this.#drainListening) return;
    this.#drainListening = false;
    this.output.off("drain", this.#onDrain);
  }

  #expectErrorEvent(): void {
    this.#awaitingError = true;
    if (!this.output.listeners("error").includes(this.#onError)) {
      this.output.on("error", this.#onError);
    }
    clearImmediate(this.#listenerCleanupImmediate);
    this.#listenerCleanupImmediate = setImmediate(() => {
      this.#awaitingError = false;
      if (this.#activeWrites.size === 0) this.#removeErrorListener();
    });
    this.#listenerCleanupImmediate.unref();
  }

  #settleActiveWrite(activeWrite: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  }): void {
    if (!this.#activeWrites.delete(activeWrite)) return;
    activeWrite.resolve();
  }

  #removeErrorListener(): void {
    clearImmediate(this.#listenerCleanupImmediate);
    this.#listenerCleanupImmediate = undefined;
    this.output.off("error", this.#onError);
  }
}

export interface StdioServerOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly onError?: (error: Error) => void;
  readonly allocatePendingBuffer?: (size: number) => Buffer;
  readonly exitProcess?: (code: number) => void;
}

export interface StdioServerHandle {
  readonly server: Server;
  readonly transport: StdioServerTransport;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

function protocolDiagnostic(error: Error): string {
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
  return `jetkvm-mcp: ${diagnostic}\n`;
}

export async function startStdioServer(
  handlerRegistry: HandlerRegistry = {},
  options: StdioServerOptions = {},
): Promise<StdioServerHandle> {
  assertHandlerRegistry(handlerRegistry);
  const server = createMcpServer(handlerRegistry);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const ownsDefaultProcessStdio =
    stdin === process.stdin && stdout === process.stdout;
  const exitProcess =
    options.exitProcess ?? ((code: number): void => process.exit(code));
  const diagnosticSink =
    options.onError === undefined
      ? new BoundedDiagnosticSink(options.stderr ?? process.stderr)
      : undefined;
  const reportError =
    options.onError ??
    ((error: Error) => {
      diagnosticSink?.write(protocolDiagnostic(error));
    });
  const closedState = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  let gate: BoundedStdioFrameGate;
  let outputGate: BoundedStdioOutputGate;
  let malformedFrames = 0;
  let fatalClosePromise: Promise<void> | undefined;

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
    diagnosticSink?.close();
    try {
      await server.close();
    } finally {
      closedState.resolve();
    }
  };

  const reportMalformedFrame = (error: Error): void => {
    reportError(error);
    malformedFrames += 1;
    if (malformedFrames >= MAXIMUM_MALFORMED_FRAMES) void close();
  };

  const closeForFatalOutput = (error: Error): Promise<void> => {
    if (fatalClosePromise !== undefined) return fatalClosePromise;
    gate.abortInput(ownsDefaultProcessStdio);
    reportError(error);
    fatalClosePromise = (async () => {
      await close();
      await diagnosticSink?.flush(DIAGNOSTIC_FLUSH_TIMEOUT_MS);
      if (ownsDefaultProcessStdio) exitProcess(1);
    })();
    return fatalClosePromise;
  };

  outputGate = new BoundedStdioOutputGate(
    stdout,
    (error) => {
      void closeForFatalOutput(error);
    },
    ownsDefaultProcessStdio,
  );
  gate = new BoundedStdioFrameGate(
    stdin,
    (error) => {
      reportError(error);
      void close();
    },
    reportMalformedFrame,
    () => {
      void close();
    },
    options.allocatePendingBuffer ?? ((size) => Buffer.allocUnsafe(size)),
  );
  const transport = new StdioServerTransport(gate.output, outputGate);
  transport.onerror = () => {
    reportMalformedFrame(new Error("Malformed stdio protocol frame"));
  };

  try {
    await server.connect(transport);
    const sdkTransportErrorHandler = transport.onerror;
    transport.onerror = () => {
      sdkTransportErrorHandler?.(new Error("Malformed stdio protocol frame"));
    };
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
