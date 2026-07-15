import type { Page } from "playwright-core";

import type { Deadline } from "../device/DeviceRpcAdapter.js";
import {
  BrowserPlaneError,
  parseAutomationSnapshot,
  parseBridgeCallEnvelope,
  parseAtxBridgeRequest,
  parseCaptureBridgeRequest,
  parseCaptureBridgeResult,
  parseKeyboardBridgeRequest,
  parseMouseBridgeRequest,
  parseMutationBridgeReceipt,
  parsePasteBridgeReceipt,
  parsePasteBridgeRequest,
  parseReadBridgeRequest,
  parseReadBridgeResult,
  parseReleaseBridgeReceipt,
  parseReleaseBridgeRequest,
  type AutomationSnapshot,
  type AtxBridgeRequest,
  type BrowserPlaneErrorInit,
  type CaptureBridgeRequest,
  type CaptureBridgeResult,
  type KeyboardBridgeRequest,
  type KeyboardBridgeReceipt,
  type MouseBridgeRequest,
  type MutationBridgeReceipt,
  type PasteBridgeRequest,
  type PasteBridgeReceipt,
  type ReadBridgeRequest,
  type ReadBridgeResult,
  type ReleaseBridgeRequest,
  type ReleaseBridgeReceipt,
} from "./bridgeProtocol.js";
const RECONNECT_STABILITY_POLL_MS = 250;
const RECONNECT_STABLE_SNAPSHOT_COUNT = 3;
export type BrowserDeadlineClock = () => number;

export function createBrowserDeadlineBudget(
  deadline: Deadline,
  clock: BrowserDeadlineClock = () => performance.now(),
): { remaining(): Deadline } {
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Browser deadline clock must return a finite value.");
  }
  const expiresAtMs = startedAtMs + deadline.timeoutMs;
  return {
    remaining: () => ({
      timeoutMs: Math.max(0, Math.ceil(expiresAtMs - clock())),
      signal: deadline.signal,
    }),
  };
}

export interface BrowserControllerPort {
  snapshot(deadline: Deadline): Promise<AutomationSnapshot>;
  stableReadySnapshot(deadline: Deadline): Promise<AutomationSnapshot>;
  capture(
    request: CaptureBridgeRequest,
    deadline: Deadline,
  ): Promise<CaptureBridgeResult>;
  mouse(
    request: MouseBridgeRequest,
    deadline: Deadline,
  ): Promise<MutationBridgeReceipt>;
  keyboard(
    request: KeyboardBridgeRequest,
    deadline: Deadline,
  ): Promise<KeyboardBridgeReceipt>;
  paste(
    request: PasteBridgeRequest,
    deadline: Deadline,
  ): Promise<PasteBridgeReceipt>;
  release(
    request: ReleaseBridgeRequest,
    deadline: Deadline,
  ): Promise<ReleaseBridgeReceipt>;
  readVideoState(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult>;
  readEdid(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult>;
  performAtx(
    request: AtxBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult>;
  /** Stable identity for the live page bridge; changes only after replacement succeeds. */
  connectionIdentity(): object;
  reconnect(deadline: Deadline): Promise<void>;
  close(deadline: Deadline): Promise<void>;
}

type FacadeCallEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

type PageFacade = {
  readonly version: unknown;
  snapshot(): unknown;
  cancel(operationId: string): boolean;
  capture(request: CaptureBridgeRequest): Promise<unknown>;
  mouse(request: MouseBridgeRequest): Promise<unknown>;
  keyboard(request: KeyboardBridgeRequest): Promise<unknown>;
  paste(request: PasteBridgeRequest): Promise<unknown>;
  release(request: ReleaseBridgeRequest): Promise<unknown>;
  readVideoState(request: ReadBridgeRequest): Promise<unknown>;
  readEdid(request: ReadBridgeRequest): Promise<unknown>;
  performAtx(request: AtxBridgeRequest): Promise<unknown>;
};
type AutomationWindow = Window & { __JETKVM_AUTOMATION__?: PageFacade };

function inputTimeoutError(
  code: "CANCELLED" | "DEADLINE_EXCEEDED",
): BrowserPlaneError {
  return new BrowserPlaneError({
    code,
    outcome: "not_sent",
    stage: "admission",
    writeBegan: false,
    acknowledged: false,
    dispatchedCount: 0,
    completedCount: 0,
    requestedCount: 0,
    safeToRetry: true,
    requiredNextStep: "none",
    suffixSuppressed: false,
  });
}

function malformedBridgeError(
  mutationInvoked: boolean,
  requestedCount: number,
): BrowserPlaneError {
  return new BrowserPlaneError({
    code: "DOWNSTREAM_MALFORMED_RESPONSE",
    outcome: mutationInvoked ? "unknown" : "not_sent",
    stage: mutationInvoked ? "acknowledgement" : "verification",
    writeBegan: mutationInvoked,
    acknowledged: false,
    dispatchedCount: 0,
    completedCount: 0,
    requestedCount,
    safeToRetry: false,
    requiredNextStep: mutationInvoked
      ? "inspect_device_state_before_retry"
      : "reconnect_then_capture",
    suffixSuppressed: mutationInvoked,
  });
}

function validateRequest<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch {
    throw malformedBridgeError(false, 0);
  }
}

function assertDeadline(deadline: Deadline, bridgeTimeoutMs?: number): void {
  if (deadline.signal.aborted) throw inputTimeoutError("CANCELLED");
  if (
    !Number.isSafeInteger(deadline.timeoutMs) ||
    deadline.timeoutMs < 100 ||
    deadline.timeoutMs > 300_000 ||
    (bridgeTimeoutMs !== undefined && bridgeTimeoutMs > deadline.timeoutMs)
  ) {
    throw inputTimeoutError("DEADLINE_EXCEEDED");
  }
}

function normalizePasteText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
}

export class BrowserController implements BrowserControllerPort {
  private closed = false;
  private identity: object = Object.freeze({});

  public constructor(private readonly page: Page) {}
  public connectionIdentity(): object {
    return this.identity;
  }

  public async snapshot(deadline: Deadline): Promise<AutomationSnapshot> {
    assertDeadline(deadline);
    if (this.closed) {
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    let raw: unknown;
    try {
      raw = await this.awaitPageEvaluation(
        this.page.evaluate(() => {
          const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
          if (!facade || facade.version !== 1) {
            throw new Error("JetKVM automation facade v1 is unavailable.");
          }
          return facade.snapshot();
        }),
        deadline,
        false,
        0,
      );
    } catch (error) {
      if (error instanceof BrowserPlaneError) throw error;
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    try {
      return parseAutomationSnapshot(raw);
    } catch {
      throw malformedBridgeError(false, 0);
    }
  }
  public async stableReadySnapshot(
    deadline: Deadline,
  ): Promise<AutomationSnapshot> {
    let previous = await this.snapshot(deadline);
    let stableSnapshotCount = previous.state === "ready" ? 1 : 0;
    while (stableSnapshotCount < RECONNECT_STABLE_SNAPSHOT_COUNT) {
      await this.awaitPageEvaluation(
        this.page.waitForTimeout(RECONNECT_STABILITY_POLL_MS),
        deadline,
        false,
        0,
      );
      const current = await this.snapshot(deadline);
      const generationsStable =
        current.lifecycle_generation === previous.lifecycle_generation &&
        current.channel_generation === previous.channel_generation;
      stableSnapshotCount =
        current.state !== "ready"
          ? 0
          : generationsStable
            ? stableSnapshotCount + 1
            : 1;
      previous = current;
    }
    return previous;
  }

  public async capture(
    rawRequest: CaptureBridgeRequest,
    deadline: Deadline,
  ): Promise<CaptureBridgeResult> {
    const request = validateRequest(parseCaptureBridgeRequest, rawRequest);
    assertDeadline(deadline, request.timeout_ms);
    await this.assertPreSnapshot(request, deadline, false);
    const envelope = await this.awaitPageEvaluation(
      this.page.evaluate(async (bridgeRequest): Promise<FacadeCallEnvelope> => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        if (!facade || facade.version !== 1) {
          throw new Error("JetKVM automation facade v1 is unavailable.");
        }
        try {
          return { ok: true, value: await facade.capture(bridgeRequest) };
        } catch (error) {
          return { ok: false, error };
        }
      }, request),
      deadline,
      false,
      0,
      request.operation_id,
    );
    const result = this.parseCallResult(
      envelope,
      request.operation_id,
      0,
      false,
      parseCaptureBridgeResult,
    );
    this.assertReadCorrelation(result, request);
    const post = await this.snapshot(deadline);
    this.assertPostReadSnapshot(post, request, result.display_generation);
    return result;
  }

  public async mouse(
    rawRequest: MouseBridgeRequest,
    deadline: Deadline,
  ): Promise<MutationBridgeReceipt> {
    const request = validateRequest(parseMouseBridgeRequest, rawRequest);
    return this.runMutation(request, deadline, request.operations.length, () =>
      this.page.evaluate(async (bridgeRequest): Promise<FacadeCallEnvelope> => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        if (!facade || facade.version !== 1) {
          throw new Error("JetKVM automation facade v1 is unavailable.");
        }
        try {
          return { ok: true, value: await facade.mouse(bridgeRequest) };
        } catch (error) {
          return { ok: false, error };
        }
      }, request),
    );
  }

  public async keyboard(
    rawRequest: KeyboardBridgeRequest,
    deadline: Deadline,
  ): Promise<KeyboardBridgeReceipt> {
    const request = validateRequest(parseKeyboardBridgeRequest, rawRequest);
    return this.runMutation(request, deadline, request.operations.length, () =>
      this.page.evaluate(async (bridgeRequest): Promise<FacadeCallEnvelope> => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        if (!facade || facade.version !== 1) {
          throw new Error("JetKVM automation facade v1 is unavailable.");
        }
        try {
          return { ok: true, value: await facade.keyboard(bridgeRequest) };
        } catch (error) {
          return { ok: false, error };
        }
      }, request),
    );
  }

  public async paste(
    rawRequest: PasteBridgeRequest,
    deadline: Deadline,
  ): Promise<PasteBridgeReceipt> {
    const request = validateRequest(parsePasteBridgeRequest, rawRequest);
    assertDeadline(deadline, request.timeout_ms);
    const normalizedByteCount = Buffer.byteLength(
      normalizePasteText(request.text),
      "utf8",
    );
    await this.assertPreSnapshot(request, deadline, true);
    const envelope = await this.awaitPageEvaluation(
      this.page.evaluate(async (bridgeRequest): Promise<FacadeCallEnvelope> => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        if (!facade || facade.version !== 1) {
          throw new Error("JetKVM automation facade v1 is unavailable.");
        }
        try {
          return { ok: true, value: await facade.paste(bridgeRequest) };
        } catch (error) {
          return { ok: false, error };
        }
      }, request),
      deadline,
      true,
      normalizedByteCount,
      request.operation_id,
    );
    const result = this.parseCallResult(
      envelope,
      request.operation_id,
      normalizedByteCount,
      true,
      parsePasteBridgeReceipt,
    );
    this.assertMutationCorrelation(result, request);
    if (result.normalized_byte_count !== normalizedByteCount) {
      throw malformedBridgeError(true, normalizedByteCount);
    }
    await this.assertPostMutationSnapshot(
      request,
      deadline,
      normalizedByteCount,
      result,
    );
    return result;
  }

  public async release(
    rawRequest: ReleaseBridgeRequest,
    deadline: Deadline,
  ): Promise<ReleaseBridgeReceipt> {
    const request = validateRequest(parseReleaseBridgeRequest, rawRequest);
    assertDeadline(deadline, request.timeout_ms);
    await this.assertPreSnapshot(request, deadline, true, false);
    const envelope = await this.awaitPageEvaluation(
      this.page.evaluate(async (bridgeRequest): Promise<FacadeCallEnvelope> => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        if (!facade || facade.version !== 1) {
          throw new Error("JetKVM automation facade v1 is unavailable.");
        }
        try {
          return { ok: true, value: await facade.release(bridgeRequest) };
        } catch (error) {
          return { ok: false, error };
        }
      }, request),
      deadline,
      true,
      1,
      request.operation_id,
    );
    const result = this.parseCallResult(
      envelope,
      request.operation_id,
      1,
      true,
      parseReleaseBridgeReceipt,
    );
    if (
      result.lifecycle_generation !== request.expected_lifecycle_generation ||
      result.channel_generation !== request.expected_channel_generation ||
      result.dispatch_generation <= request.expected_dispatch_generation
    ) {
      throw malformedBridgeError(true, 1);
    }
    let post: AutomationSnapshot;
    try {
      post = await this.snapshot(deadline);
    } catch {
      throw this.appliedVerificationError(1);
    }
    if (
      post.state !== "closed" ||
      post.lifecycle_generation !== result.lifecycle_generation ||
      post.channel_generation !== result.channel_generation ||
      post.dispatch_generation !== result.dispatch_generation
    ) {
      throw this.appliedVerificationError(1);
    }
    return result;
  }

  public async readVideoState(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return this.runRead(
      validateRequest(parseReadBridgeRequest, request),
      deadline,
      (bridgeRequest) =>
        this.page.evaluate(async (pageRequest): Promise<FacadeCallEnvelope> => {
          const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
          if (!facade || facade.version !== 1) {
            throw new Error("JetKVM automation facade v1 is unavailable.");
          }
          try {
            return {
              ok: true,
              value: await facade.readVideoState(pageRequest),
            };
          } catch (error) {
            return { ok: false, error };
          }
        }, bridgeRequest),
    );
  }

  public async readEdid(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return this.runRead(
      validateRequest(parseReadBridgeRequest, request),
      deadline,
      (bridgeRequest) =>
        this.page.evaluate(async (pageRequest): Promise<FacadeCallEnvelope> => {
          const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
          if (!facade || facade.version !== 1) {
            throw new Error("JetKVM automation facade v1 is unavailable.");
          }
          try {
            return { ok: true, value: await facade.readEdid(pageRequest) };
          } catch (error) {
            return { ok: false, error };
          }
        }, bridgeRequest),
    );
  }

  public async performAtx(
    request: AtxBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return this.runRead(
      validateRequest(parseAtxBridgeRequest, request),
      deadline,
      (bridgeRequest) =>
        this.page.evaluate(async (pageRequest): Promise<FacadeCallEnvelope> => {
          const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
          if (!facade || facade.version !== 1) {
            throw new Error("JetKVM automation facade v1 is unavailable.");
          }
          try {
            return { ok: true, value: await facade.performAtx(pageRequest) };
          } catch (error) {
            return { ok: false, error };
          }
        }, bridgeRequest),
      true,
      1,
    );
  }

  public async reconnect(deadline: Deadline): Promise<void> {
    assertDeadline(deadline);
    if (this.closed) {
      throw inputTimeoutError("CANCELLED");
    }
    await this.awaitPageEvaluation(
      this.page.reload({ waitUntil: "domcontentloaded" }),
      deadline,
      false,
      0,
    );
    this.identity = Object.freeze({});
  }

  public async close(deadline: Deadline): Promise<void> {
    assertDeadline(deadline);
    if (this.closed) return;
    await this.awaitPageEvaluation(
      this.page.close({ runBeforeUnload: false }),
      deadline,
      false,
      0,
    );
    this.closed = true;
  }

  private async runMutation(
    request: MouseBridgeRequest | KeyboardBridgeRequest,
    deadline: Deadline,
    requestedCount: number,
    invoke: () => Promise<unknown>,
  ): Promise<MutationBridgeReceipt> {
    assertDeadline(deadline, request.timeout_ms);
    await this.assertPreSnapshot(request, deadline, true);
    const envelope = await this.awaitPageEvaluation(
      invoke(),
      deadline,
      true,
      requestedCount,
      request.operation_id,
    );
    const receipt = this.parseCallResult(
      envelope,
      request.operation_id,
      requestedCount,
      true,
      parseMutationBridgeReceipt,
    );
    this.assertMutationCorrelation(receipt, request);
    if (
      receipt.dispatched_count !== requestedCount ||
      receipt.completed_count !== requestedCount
    ) {
      throw malformedBridgeError(true, requestedCount);
    }
    await this.assertPostMutationSnapshot(
      request,
      deadline,
      requestedCount,
      receipt,
    );
    return receipt;
  }

  private async runRead<Request extends ReadBridgeRequest>(
    request: Request,
    deadline: Deadline,
    invoke: (request: Request) => Promise<unknown>,
    mutationInvoked = false,
    requestedCount = 0,
  ): Promise<ReadBridgeResult> {
    assertDeadline(deadline, request.timeout_ms);
    await this.assertPreSnapshot(request, deadline, false);
    const envelope = await this.awaitPageEvaluation(
      invoke(request),
      deadline,
      mutationInvoked,
      requestedCount,
      request.operation_id,
    );
    const result = this.parseCallResult(
      envelope,
      request.operation_id,
      requestedCount,
      mutationInvoked,
      parseReadBridgeResult,
    );
    this.assertReadCorrelation(result, request);
    const post = await this.snapshot(deadline);
    this.assertPostReadSnapshot(post, request);
    return result;
  }

  private parseCallResult<Result>(
    rawEnvelope: unknown,
    operationId: string,
    requestedCount: number,
    mutationInvoked: boolean,
    parseResult: (value: unknown) => Result,
  ): Result {
    let envelope;
    try {
      envelope = parseBridgeCallEnvelope(rawEnvelope);
    } catch {
      throw malformedBridgeError(mutationInvoked, requestedCount);
    }
    if (!envelope.ok) {
      if (envelope.error.operation_id !== operationId) {
        throw malformedBridgeError(
          mutationInvoked || envelope.error.write_began,
          requestedCount,
        );
      }
      throw BrowserPlaneError.fromBridge(envelope.error, requestedCount);
    }
    try {
      return parseResult(envelope.value);
    } catch {
      throw malformedBridgeError(mutationInvoked, requestedCount);
    }
  }

  private async assertPreSnapshot(
    request:
      | CaptureBridgeRequest
      | MouseBridgeRequest
      | KeyboardBridgeRequest
      | PasteBridgeRequest
      | ReleaseBridgeRequest
      | ReadBridgeRequest
      | AtxBridgeRequest,
    deadline: Deadline,
    input: boolean,
    displaySensitive = input,
  ): Promise<void> {
    const snapshot = await this.snapshot(deadline);
    if (snapshot.state !== "ready") {
      throw new BrowserPlaneError({
        code:
          snapshot.state === "closed" ? "SESSION_DRAINED" : "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: snapshot.state !== "closed",
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    if (
      snapshot.lifecycle_generation !== request.expected_lifecycle_generation
    ) {
      throw new BrowserPlaneError({
        code: "STALE_SESSION_GENERATION",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: false,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    if (snapshot.channel_generation !== request.expected_channel_generation) {
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "admission",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    if (input && "expected_display_generation" in request) {
      if (
        displaySensitive &&
        snapshot.display_generation !== request.expected_display_generation
      ) {
        throw new BrowserPlaneError({
          code: "DISPLAY_CHANGED",
          outcome: "not_sent",
          stage: "admission",
          writeBegan: false,
          acknowledged: false,
          dispatchedCount: 0,
          completedCount: 0,
          requestedCount: 0,
          safeToRetry: true,
          requiredNextStep: "capture_then_retry",
          suffixSuppressed: false,
        });
      }
      if (
        snapshot.dispatch_generation !== request.expected_dispatch_generation
      ) {
        throw new BrowserPlaneError({
          code: "SESSION_DRAINED",
          outcome: "not_sent",
          stage: "admission",
          writeBegan: false,
          acknowledged: false,
          dispatchedCount: 0,
          completedCount: 0,
          requestedCount: 0,
          safeToRetry: false,
          requiredNextStep: "reconnect_then_capture",
          suffixSuppressed: false,
        });
      }
    }
  }

  private assertReadCorrelation(
    result: CaptureBridgeResult | ReadBridgeResult,
    request: CaptureBridgeRequest | ReadBridgeRequest,
  ): void {
    if (
      result.operation_id !== request.operation_id ||
      result.lifecycle_generation !== request.expected_lifecycle_generation ||
      result.channel_generation !== request.expected_channel_generation
    ) {
      throw malformedBridgeError(false, 0);
    }
  }

  private assertMutationCorrelation(
    receipt: MutationBridgeReceipt | PasteBridgeReceipt,
    request: MouseBridgeRequest | KeyboardBridgeRequest | PasteBridgeRequest,
  ): void {
    if (
      receipt.operation_id !== request.operation_id ||
      receipt.lifecycle_generation !== request.expected_lifecycle_generation ||
      receipt.channel_generation !== request.expected_channel_generation ||
      receipt.display_generation !== request.expected_display_generation ||
      receipt.dispatch_generation !== request.expected_dispatch_generation
    ) {
      throw malformedBridgeError(true, 0);
    }
  }

  private assertPostReadSnapshot(
    snapshot: AutomationSnapshot,
    request: CaptureBridgeRequest | ReadBridgeRequest,
    displayGeneration?: number,
  ): void {
    if (
      snapshot.state !== "ready" ||
      snapshot.lifecycle_generation !== request.expected_lifecycle_generation ||
      snapshot.channel_generation !== request.expected_channel_generation
    ) {
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: "not_sent",
        stage: "verification",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "reconnect_then_capture",
        suffixSuppressed: false,
      });
    }
    if (
      displayGeneration !== undefined &&
      snapshot.display_generation !== displayGeneration
    ) {
      throw new BrowserPlaneError({
        code: "DISPLAY_CHANGED",
        outcome: "not_sent",
        stage: "verification",
        writeBegan: false,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount: 0,
        safeToRetry: true,
        requiredNextStep: "capture_then_retry",
        suffixSuppressed: false,
      });
    }
  }

  private async assertPostMutationSnapshot(
    request: MouseBridgeRequest | KeyboardBridgeRequest | PasteBridgeRequest,
    deadline: Deadline,
    requestedCount: number,
    receipt: MutationBridgeReceipt | PasteBridgeReceipt,
  ): Promise<void> {
    let post: AutomationSnapshot;
    try {
      post = await this.snapshot(deadline);
    } catch {
      throw this.appliedVerificationError(requestedCount);
    }
    if (
      post.state !== "ready" ||
      post.lifecycle_generation !== request.expected_lifecycle_generation ||
      post.channel_generation !== request.expected_channel_generation ||
      post.display_generation !== request.expected_display_generation ||
      post.dispatch_generation !== request.expected_dispatch_generation ||
      receipt.lifecycle_generation !== post.lifecycle_generation ||
      receipt.channel_generation !== post.channel_generation
    ) {
      throw this.appliedVerificationError(requestedCount);
    }
  }

  private appliedVerificationError(requestedCount: number): BrowserPlaneError {
    return new BrowserPlaneError({
      code: "PARTIAL_VERIFICATION",
      outcome: "applied",
      stage: "verification",
      writeBegan: true,
      acknowledged: true,
      dispatchedCount: requestedCount,
      completedCount: requestedCount,
      requestedCount,
      safeToRetry: false,
      requiredNextStep: "none",
      suffixSuppressed: false,
    });
  }

  private cancelPageOperation(operationId: string | undefined): void {
    if (operationId === undefined) return;
    void this.page
      .evaluate((id) => {
        const facade = (window as AutomationWindow).__JETKVM_AUTOMATION__;
        return facade?.version === 1 ? facade.cancel(id) : false;
      }, operationId)
      .catch(() => {});
  }

  private async awaitPageEvaluation(
    evaluation: Promise<unknown>,
    deadline: Deadline,
    mutationInvoked: boolean,
    requestedCount: number,
    operationId?: string,
  ): Promise<unknown> {
    let rejectCancellation!: (error: BrowserPlaneError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      this.cancelPageOperation(operationId);
      rejectCancellation(
        mutationInvoked
          ? new BrowserPlaneError({
              code: "MUTATION_OUTCOME_UNKNOWN",
              outcome: "unknown",
              stage: "write",
              writeBegan: true,
              acknowledged: false,
              dispatchedCount: 0,
              completedCount: 0,
              requestedCount,
              safeToRetry: false,
              requiredNextStep: "inspect_device_state_before_retry",
              suffixSuppressed: true,
            })
          : inputTimeoutError("CANCELLED"),
      );
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      this.cancelPageOperation(operationId);
      rejectCancellation(
        mutationInvoked
          ? new BrowserPlaneError({
              code: "MUTATION_OUTCOME_UNKNOWN",
              outcome: "unknown",
              stage: "write",
              writeBegan: true,
              acknowledged: false,
              dispatchedCount: 0,
              completedCount: 0,
              requestedCount,
              safeToRetry: false,
              requiredNextStep: "inspect_device_state_before_retry",
              suffixSuppressed: true,
            })
          : inputTimeoutError("DEADLINE_EXCEEDED"),
      );
    }, deadline.timeoutMs);
    try {
      return await Promise.race([evaluation, cancellation]);
    } catch (error) {
      if (error instanceof BrowserPlaneError) throw error;
      throw new BrowserPlaneError({
        code: "CONNECTION_LOST",
        outcome: mutationInvoked ? "unknown" : "not_sent",
        stage: mutationInvoked ? "write" : "verification",
        writeBegan: mutationInvoked,
        acknowledged: false,
        dispatchedCount: 0,
        completedCount: 0,
        requestedCount,
        safeToRetry: !mutationInvoked,
        requiredNextStep: mutationInvoked
          ? "inspect_device_state_before_retry"
          : "reconnect_then_capture",
        suffixSuppressed: mutationInvoked,
      });
    } finally {
      clearTimeout(timer);
      deadline.signal.removeEventListener("abort", onAbort);
      void evaluation.catch(() => {});
    }
  }
}
