import {
  CancelKeyboardMacroReportMessage,
  KeyboardMacroReportMessage,
  KeyboardMacroStateMessage,
  type KeyboardMacroStep,
  unmarshalHidRpcMessage,
} from "@/hooks/hidRpc";
import { hidKeyBufferSize } from "@/hooks/stores";
import { keys, modifiers } from "@/keyboardMappings";
import { PASTE_PROFILES } from "@/utils/pasteBatches";
import { buildPasteMacroBatches, type KeyboardLayoutLike } from "@/utils/pasteMacro";
import { sendHidRpcMessage } from "@/utils/hidRpcTransport";

import type { AutomationPasteResult, AutomationPasteTransport } from "./controller";
import type { AutomationBridgeErrorCode } from "./protocol";

export interface ProductPasteChannel {
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer): void;
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
}

export interface ProductReliablePasteOptions {
  readonly nowIso?: () => string;
  readonly monotonicNow?: () => number;
}

interface PasteExecution {
  readonly promise: Promise<AutomationPasteResult>;
  readonly resolve: (result: AutomationPasteResult) => void;
  readonly reject: (error: PasteTransportFailure) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly sourceCharacters: number;
  readonly expectedBatchCount: number;
  acceptedAt: string;
  acceptedMonotonicMs: number;
  submittedBatchCount: number;
  active: boolean;
  terminalSeen: boolean;
  settled: boolean;
  cancelSent: boolean;
  cancelCode: AutomationBridgeErrorCode | null;
}

export class PasteTransportFailure extends Error {
  readonly code: AutomationBridgeErrorCode;

  constructor(code: AutomationBridgeErrorCode) {
    super(code);
    this.name = "PasteTransportFailure";
    this.code = code;
  }
}

const LOW_WATERMARK_BYTES = 64 * 1024;
const HIGH_WATERMARK_BYTES = 256 * 1024;
const RESET_KEYS = new Array<number>(hidKeyBufferSize).fill(0);

function encodeBatch(
  steps: readonly { keys: string[] | null; modifiers: string[] | null; delay: number }[],
) {
  const encoded: KeyboardMacroStep[] = [];
  for (const step of steps) {
    const keyValues = (step.keys ?? []).map(key => keys[key]).filter(value => value !== undefined);
    const modifier = (step.modifiers ?? []).reduce(
      (mask, name) => mask + (modifiers[name] ?? 0),
      0,
    );
    if (keyValues.length === 0 && modifier === 0) continue;
    encoded.push({ keys: keyValues, modifier, delay: modifier > 0 ? 10 : 5 });
    encoded.push({ keys: RESET_KEYS, modifier: 0, delay: PASTE_PROFILES.reliable.keyDelayMs });
  }
  return encoded;
}

function messageBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export class ProductReliablePasteTransport implements AutomationPasteTransport {
  private execution: PasteExecution | null = null;
  private closed = false;
  private poisoned = false;
  private readonly nowIso: () => string;
  private readonly monotonicNow: () => number;
  private readonly channel: ProductPasteChannel;
  private readonly keyboard: KeyboardLayoutLike;
  private readonly onMessage = (event: MessageEvent | Event) => {
    if (!(event instanceof MessageEvent)) return;
    const bytes = messageBytes(event.data);
    if (!bytes) return;
    let decoded: unknown;
    try {
      decoded = unmarshalHidRpcMessage(bytes);
    } catch {
      return;
    }
    if (!(decoded instanceof KeyboardMacroStateMessage) || !decoded.isPaste) return;
    this.observeMacroState(decoded.state, decoded.failed);
  };
  private readonly onClose = () => {
    this.abortCurrent("CHANNEL_LOST");
  };

  constructor(
    channel: ProductPasteChannel,
    keyboard: KeyboardLayoutLike,
    options: ProductReliablePasteOptions = {},
  ) {
    this.channel = channel;
    this.keyboard = keyboard;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("close", this.onClose);
  }

  async execute(
    normalizedText: string,
    signal: AbortSignal,
    onAccepted: (acceptedAt: string) => void,
    timeoutMs = 300_000,
  ): Promise<AutomationPasteResult> {
    if (
      this.closed ||
      this.poisoned ||
      this.execution !== null ||
      this.channel.readyState !== "open" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 300_000
    ) {
      throw new PasteTransportFailure("PASTE_LIFECYCLE");
    }
    const build = buildPasteMacroBatches(
      normalizedText,
      this.keyboard,
      PASTE_PROFILES.reliable.keyDelayMs,
      PASTE_PROFILES.reliable.maxStepsPerBatch,
      PASTE_PROFILES.reliable.maxBytesPerBatch,
    );
    if (build.invalidChars.length > 0 || build.batches.length === 0) {
      throw new PasteTransportFailure("PASTE_UNSUPPORTED");
    }

    const terminal = Promise.withResolvers<AutomationPasteResult>();
    const abortListener = () => this.abortCurrent("CANCELLED");
    const timer = setTimeout(() => this.abortCurrent("DEADLINE_EXCEEDED"), timeoutMs);
    const execution: PasteExecution = {
      promise: terminal.promise,
      resolve: terminal.resolve,
      reject: terminal.reject,
      signal,
      abortListener,
      sourceCharacters: Array.from(normalizedText).length,
      expectedBatchCount: build.batches.length,
      acceptedAt: "",
      acceptedMonotonicMs: 0,
      submittedBatchCount: 0,
      active: false,
      terminalSeen: false,
      settled: false,
      cancelSent: false,
      cancelCode: null,
    };
    this.execution = execution;
    signal.addEventListener("abort", abortListener, { once: true });
    const previousThreshold = this.channel.bufferedAmountLowThreshold;
    this.channel.bufferedAmountLowThreshold = LOW_WATERMARK_BYTES;

    try {
      for (const batch of build.batches) {
        if (execution.settled) break;
        if (signal.aborted) {
          this.failCurrent("CANCELLED");
          break;
        }
        const encoded = encodeBatch(batch);
        if (encoded.length === 0) {
          this.failCurrent("PASTE_UNSUPPORTED");
          break;
        }
        const sent = sendHidRpcMessage(
          new KeyboardMacroReportMessage(true, encoded.length, encoded),
          { reliable: this.channel },
          {
            handshakeReady: true,
            unreliableOrderedReady: false,
            unreliableNonOrderedReady: false,
          },
        );
        if (!sent) {
          this.abortCurrent("CHANNEL_LOST");
          break;
        }
        execution.submittedBatchCount += 1;
        if (execution.acceptedAt === "") {
          execution.acceptedAt = this.nowIso();
          execution.acceptedMonotonicMs = this.monotonicNow();
          onAccepted(execution.acceptedAt);
        }
        if (this.channel.bufferedAmount >= HIGH_WATERMARK_BYTES) {
          await this.waitForDrain(execution);
        }
      }
      if (!execution.settled && execution.submittedBatchCount !== execution.expectedBatchCount) {
        this.abortCurrent("PASTE_LIFECYCLE");
      }
      return await execution.promise;
    } catch (error) {
      if (error instanceof PasteTransportFailure) throw error;
      this.failCurrent("CHANNEL_LOST");
      return await execution.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortListener);
      this.channel.bufferedAmountLowThreshold = previousThreshold;
      if (this.execution === execution) this.execution = null;
    }
  }

  async cancelAndJoin(): Promise<void> {
    const execution = this.execution;
    if (!execution) return;
    execution.cancelCode = "CANCELLED";
    this.sendCancel(execution);
    if (execution.acceptedAt === "") {
      this.failCurrent("CANCELLED");
    }
    try {
      await execution.promise;
    } catch {
      // The local producer is joined only after the device reports inactive
      // or the original operation deadline makes that terminal unknowable.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const execution = this.execution;
    if (execution) this.sendCancel(execution);
    this.abortCurrent("CHANNEL_LOST");
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
  }

  private observeMacroState(active: boolean, failed: boolean): void {
    const execution = this.execution;
    if (!execution || execution.settled) return;
    if (active) {
      if (failed || execution.active || execution.terminalSeen) {
        this.abortCurrent("PASTE_LIFECYCLE");
        return;
      }
      execution.active = true;
      return;
    }
    if (execution.cancelCode !== null) {
      execution.terminalSeen = true;
      this.failCurrent(execution.cancelCode);
      return;
    }
    if (
      !execution.active ||
      execution.terminalSeen ||
      failed ||
      execution.submittedBatchCount !== execution.expectedBatchCount
    ) {
      this.abortCurrent("PASTE_LIFECYCLE");
      return;
    }
    execution.terminalSeen = true;
    const completedAt = this.nowIso();
    const completedMonotonicMs = this.monotonicNow();
    queueMicrotask(() => {
      if (this.execution !== execution || execution.settled) return;
      const elapsedMs = Math.max(1, completedMonotonicMs - execution.acceptedMonotonicMs);
      const measuredSourceCps =
        Math.round((execution.sourceCharacters * 100_000) / elapsedMs) / 100;
      execution.settled = true;
      execution.resolve({
        acceptedAt: execution.acceptedAt,
        completedAt,
        measuredSourceCps,
      });
    });
  }

  private abortCurrent(code: AutomationBridgeErrorCode): void {
    const execution = this.execution;
    if (!execution || execution.settled) return;
    if (execution.acceptedAt !== "") {
      this.sendCancel(execution);
      this.poisoned = true;
    }
    this.failCurrent(code);
  }

  private failCurrent(code: AutomationBridgeErrorCode): void {
    const execution = this.execution;
    if (!execution || execution.settled) return;
    execution.settled = true;
    execution.reject(new PasteTransportFailure(code));
  }

  private sendCancel(execution: PasteExecution): void {
    if (execution.cancelSent || this.channel.readyState !== "open") return;
    execution.cancelSent = true;
    sendHidRpcMessage(
      new CancelKeyboardMacroReportMessage(),
      { reliable: this.channel },
      {
        handshakeReady: true,
        unreliableOrderedReady: false,
        unreliableNonOrderedReady: false,
      },
    );
  }

  private async waitForDrain(execution: PasteExecution): Promise<void> {
    if (this.channel.bufferedAmount < HIGH_WATERMARK_BYTES) return;
    const drained = Promise.withResolvers<void>();
    const onLow = () => drained.resolve();
    const onAbort = () => drained.reject(new PasteTransportFailure("CANCELLED"));
    const onClose = () => drained.reject(new PasteTransportFailure("CHANNEL_LOST"));
    this.channel.addEventListener("bufferedamountlow", onLow);
    this.channel.addEventListener("close", onClose);
    execution.signal.addEventListener("abort", onAbort, { once: true });
    const terminal = execution.promise.then(
      () => undefined,
      error => Promise.reject(error),
    );
    try {
      await Promise.race([drained.promise, terminal]);
    } finally {
      this.channel.removeEventListener("bufferedamountlow", onLow);
      this.channel.removeEventListener("close", onClose);
      execution.signal.removeEventListener("abort", onAbort);
    }
  }
}
