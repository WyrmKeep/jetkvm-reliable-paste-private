import type {
  CapabilitySnapshot,
  PermissionName,
  SessionConnectInput,
  SessionConnectResult,
  SessionReconnectInput,
  SessionReconnectResult,
} from "../domain.js";
import {
  ERROR_CODES,
  REQUIRED_NEXT_STEPS,
  type ErrorCode,
  type RequiredNextStep,
} from "../errors.js";
import type { Deadline, SessionRef } from "../device/DeviceRpcAdapter.js";
import type {
  BrowserConnection,
  BrowserPlane,
} from "../planes/BrowserPlane.js";
import {
  RequestLedger,
  type LedgerReservation,
} from "../idempotency/RequestLedger.js";

export interface DeviceSessionScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface DeviceSessionClientOptions {
  readonly browser: BrowserPlane;
  readonly configuredDevice: string;
  readonly requestLedger: RequestLedger;
  readonly createSessionId: () => string;
  readonly permissionsForPrincipal: (
    principal: string,
  ) => readonly PermissionName[];
  readonly capabilitiesForConnection: (
    connection: BrowserConnection,
    deadline: Deadline,
  ) => Promise<CapabilitySnapshot>;
  readonly scheduler?: DeviceSessionScheduler;
}

export type DeviceSessionState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "drained"
  | "taken_over"
  | "closing"
  | "failed";

export interface DeviceSessionSnapshot {
  readonly ref: SessionRef;
  readonly state: DeviceSessionState;
  readonly connectionEpoch: number;
  readonly displayGeneration: number;
  readonly browserChannelGeneration: number | null;
  readonly freshCaptureRequired: boolean;
}

export interface DeviceSessionConnectSuccess {
  readonly ref: SessionRef;
  readonly result: SessionConnectResult;
}

export interface DeviceSessionReconnectSuccess {
  readonly ref: SessionRef;
  readonly result: SessionReconnectResult;
}

export type DeviceSessionErrorOutcome = "not_sent" | "unknown";
export interface DeviceSessionPlaneFailure {
  readonly code: ErrorCode;
  readonly outcome: DeviceSessionErrorOutcome;
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
}

export class DeviceSessionClientError extends Error {
  public readonly name = "DeviceSessionClientError";

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly outcome: DeviceSessionErrorOutcome,
    public readonly safeToRetry: boolean,
    public readonly requiredNextStep: RequiredNextStep,
  ) {
    super(message);
  }
}

export class DeviceSessionPlaneError
  extends Error
  implements DeviceSessionPlaneFailure
{
  public readonly name = "DeviceSessionPlaneError";

  public constructor(
    public readonly code: ErrorCode,
    public readonly outcome: DeviceSessionErrorOutcome,
    public readonly safeToRetry = outcome === "not_sent",
    public readonly requiredNextStep: RequiredNextStep = outcome === "not_sent"
      ? "none"
      : "inspect_device_state_before_retry",
  ) {
    super(
      "The injected browser plane could not complete the session operation.",
    );
  }
}

function isDeviceSessionPlaneFailure(
  error: unknown,
): error is Error & DeviceSessionPlaneFailure {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Partial<DeviceSessionPlaneFailure>;
  return (
    typeof candidate.code === "string" &&
    ERROR_CODES.some((code) => code === candidate.code) &&
    (candidate.outcome === "not_sent" || candidate.outcome === "unknown") &&
    typeof candidate.safeToRetry === "boolean" &&
    typeof candidate.requiredNextStep === "string" &&
    REQUIRED_NEXT_STEPS.some(
      (nextStep) => nextStep === candidate.requiredNextStep,
    )
  );
}

type SessionRecord = {
  readonly sessionId: string;
  readonly principal: string;
  sessionGeneration: number;
  state: DeviceSessionState;
  connectionEpoch: number;
  displayGeneration: number;
  browserChannelGeneration: number | null;
  freshCaptureRequired: boolean;
  lifecycle: AbortController;
};

type DeadlineScope = {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  remaining(): Deadline;
  abortKind(): "caller" | "deadline" | null;
  dispose(): void;
};

class DeadlineAbort extends Error {
  public constructor(public readonly kind: "caller" | "deadline") {
    super(
      kind === "caller" ? "Operation cancelled" : "Operation deadline elapsed",
    );
  }
}

const SYSTEM_SCHEDULER: DeviceSessionScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (id) => globalThis.clearTimeout(id as NodeJS.Timeout),
};

function clientError(
  code: ErrorCode,
  outcome: DeviceSessionErrorOutcome,
  safeToRetry: boolean,
  requiredNextStep: RequiredNextStep,
): DeviceSessionClientError {
  const messages: Partial<Record<ErrorCode, string>> = {
    PERMISSION_DENIED: "The principal lacks the required session permission.",
    CONTROL_BUSY: "The configured device is controlled by another session.",
    SESSION_NOT_FOUND: "The device session was not found.",
    STALE_SESSION_GENERATION: "The device session generation is stale.",
    SESSION_TAKEN_OVER: "The device session was taken over.",
    SESSION_DRAINED: "The device session is not ready.",
    CANCELLED: "The device session operation was cancelled.",
    DEADLINE_EXCEEDED: "The device session operation deadline elapsed.",
    CONNECTION_LOST: "The device session connection was lost.",
    DOWNSTREAM_MALFORMED_RESPONSE:
      "The browser plane returned invalid connection evidence.",
    REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT:
      "The request ID was already used with different input.",
    MUTATION_OUTCOME_UNKNOWN:
      "The request ledger cannot safely admit this mutation.",
  };
  return new DeviceSessionClientError(
    code,
    messages[code] ?? "The device session operation failed.",
    outcome,
    safeToRetry,
    requiredNextStep,
  );
}

export class DeviceSessionClient {
  readonly #browser: BrowserPlane;
  readonly #configuredDevice: string;
  readonly #requestLedger: RequestLedger;
  readonly #createSessionId: () => string;
  readonly #permissionsForPrincipal: (
    principal: string,
  ) => readonly PermissionName[];
  readonly #capabilitiesForConnection: DeviceSessionClientOptions["capabilitiesForConnection"];
  readonly #scheduler: DeviceSessionScheduler;
  readonly #sessions = new Map<string, SessionRecord>();
  #activeSessionId: string | null = null;
  #lockTail = Promise.resolve();

  public constructor(options: DeviceSessionClientOptions) {
    if (options.configuredDevice.length === 0) {
      throw new Error("configuredDevice must not be empty");
    }
    this.#browser = options.browser;
    this.#configuredDevice = options.configuredDevice;
    this.#requestLedger = options.requestLedger;
    this.#createSessionId = options.createSessionId;
    this.#permissionsForPrincipal = options.permissionsForPrincipal;
    this.#capabilitiesForConnection = options.capabilitiesForConnection;
    this.#scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
  }

  public async connect(
    principal: string,
    input: SessionConnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionConnectSuccess> {
    const scope = this.#deadline(input.timeout_ms, callerSignal);
    const takeover = input.takeover ?? false;
    let reservation: LedgerReservation | null = null;
    let planeInvoked = false;
    let irreversibleTransition = false;
    try {
      const permissions = [...this.#permissionsForPrincipal(principal)];
      if (!permissions.includes("session.connect")) {
        throw clientError(
          "PERMISSION_DENIED",
          "not_sent",
          false,
          "grant_permission",
        );
      }
      if (takeover && !permissions.includes("session.takeover")) {
        throw clientError(
          "PERMISSION_DENIED",
          "not_sent",
          false,
          "grant_permission",
        );
      }

      const decision = this.#requestLedger.acquire<DeviceSessionConnectSuccess>(
        {
          principal,
          configuredDevice: this.#configuredDevice,
          tool: "jetkvm_session_connect",
          requestId: input.request_id,
        },
        { ...input, takeover },
      );
      if (decision.kind === "replay") {
        if (
          decision.replayOutcome !== "already_applied" ||
          decision.terminal.outcome !== "applied"
        ) {
          throw clientError(
            "MUTATION_OUTCOME_UNKNOWN",
            decision.terminal.outcome === "applied"
              ? "unknown"
              : decision.terminal.outcome,
            false,
            "inspect_device_state_before_retry",
          );
        }
        return {
          ...decision.terminal.value,
          result: {
            ...decision.terminal.value.result,
            outcome: "already_applied",
          },
        };
      }
      if (decision.kind === "conflict") {
        throw clientError(decision.code, "not_sent", false, "none");
      }
      if (decision.kind === "capacity_exceeded") {
        throw clientError(
          "ADMISSION_CAPACITY_EXCEEDED",
          "not_sent",
          true,
          "none",
        );
      }
      if (decision.kind !== "acquired") {
        throw clientError(
          "MUTATION_OUTCOME_UNKNOWN",
          "unknown",
          false,
          "inspect_device_state_before_retry",
        );
      }
      reservation = decision.reservation;
      const activeReservation = decision.reservation;

      const connected = await this.#withLock(scope.signal, async () => {
        this.#throwIfAborted(scope, false);
        let takeoverPerformed = false;
        const incumbent = this.#activeRecord();
        if (incumbent !== null) {
          if (!takeover) {
            throw clientError(
              "CONTROL_BUSY",
              "not_sent",
              true,
              "wait_or_request_takeover",
            );
          }
          takeoverPerformed = true;
          irreversibleTransition = true;
          incumbent.state = "taken_over";
          incumbent.lifecycle.abort(new DeadlineAbort("caller"));
          planeInvoked = true;
          await this.#browser.close(this.#ref(incumbent), scope.remaining());
          if (this.#activeSessionId === incumbent.sessionId) {
            this.#activeSessionId = null;
          }
        }

        this.#throwIfAborted(scope, planeInvoked);
        const sessionId = this.#createSessionId();
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId) ||
          this.#sessions.has(sessionId)
        ) {
          throw new Error("createSessionId must return a unique canonical ID");
        }
        const record: SessionRecord = {
          sessionId,
          principal,
          sessionGeneration: 1,
          state: "connecting",
          connectionEpoch: 0,
          displayGeneration: 0,
          browserChannelGeneration: null,
          freshCaptureRequired: true,
          lifecycle: new AbortController(),
        };
        this.#sessions.set(sessionId, record);
        const ref = this.#ref(record);
        let connectionOpened = false;
        try {
          planeInvoked = true;
          const connection = await this.#browser.connect(
            ref,
            scope.remaining(),
          );
          connectionOpened = true;
          this.#assertConnection(connection, ref);
          const capabilities = await this.#capabilitiesForConnection(
            connection,
            scope.remaining(),
          );
          this.#throwIfAborted(scope, true);
          const result: DeviceSessionConnectSuccess = {
            ref,
            result: {
              request_id: input.request_id,
              outcome: "applied",
              verification: "device_state_verified",
              safe_to_retry: false,
              required_next_step: "none",
              state: "ready",
              connection_epoch: connection.connectionEpoch,
              display_generation: connection.displayGeneration,
              takeover_performed: takeoverPerformed,
              fresh_capture_required: true,
              permissions,
              capabilities,
            },
          };
          if (
            !this.#requestLedger.complete(activeReservation, {
              outcome: "applied",
              verification: "device_state_verified",
              value: result,
            })
          ) {
            throw clientError(
              "MUTATION_OUTCOME_UNKNOWN",
              "unknown",
              false,
              "inspect_device_state_before_retry",
            );
          }
          record.state = "ready";
          record.connectionEpoch = connection.connectionEpoch;
          record.displayGeneration = connection.displayGeneration;
          record.browserChannelGeneration = connection.browserChannelGeneration;
          this.#activeSessionId = sessionId;
          return result;
        } catch (error) {
          record.state = "failed";
          if (this.#activeSessionId === sessionId) {
            this.#activeSessionId = null;
          }
          let failure = this.#mapFailure(
            error,
            scope,
            planeInvoked,
            irreversibleTransition,
          );
          if (connectionOpened || failure.outcome === "unknown") {
            const cleanupSucceeded = await this.#closeForCleanup(ref);
            if (!cleanupSucceeded) {
              this.#activeSessionId = record.sessionId;
              if (failure.outcome === "not_sent") {
                failure = clientError(
                  failure.code,
                  "unknown",
                  false,
                  "inspect_device_state_before_retry",
                );
              }
            }
          }
          throw failure;
        }
      });
      return connected;
    } catch (error) {
      const failure = this.#mapFailure(
        error,
        scope,
        planeInvoked,
        irreversibleTransition,
      );
      this.#finishFailedReservation(reservation, failure.outcome);
      throw failure;
    } finally {
      scope.dispose();
    }
  }

  public async reconnect(
    principal: string,
    input: SessionReconnectInput,
    callerSignal?: AbortSignal,
  ): Promise<DeviceSessionReconnectSuccess> {
    const scope = this.#deadline(input.timeout_ms, callerSignal);
    const takeover = input.takeover ?? false;
    let reservation: LedgerReservation | null = null;
    let planeInvoked = false;
    let irreversibleTransition = false;
    try {
      const permissions = [...this.#permissionsForPrincipal(principal)];
      if (!permissions.includes("session.reconnect")) {
        throw clientError(
          "PERMISSION_DENIED",
          "not_sent",
          false,
          "grant_permission",
        );
      }
      if (takeover && !permissions.includes("session.takeover")) {
        throw clientError(
          "PERMISSION_DENIED",
          "not_sent",
          false,
          "grant_permission",
        );
      }
      const requestedRef: SessionRef = {
        sessionId: input.session_id,
        sessionGeneration: input.session_generation,
      };
      this.#recordForPrincipal(principal, requestedRef.sessionId);
      const decision =
        this.#requestLedger.acquire<DeviceSessionReconnectSuccess>(
          {
            ...requestedRef,
            tool: "jetkvm_session_reconnect",
            requestId: input.request_id,
          },
          { ...input, takeover },
        );
      if (decision.kind === "replay") {
        if (
          decision.replayOutcome !== "already_applied" ||
          decision.terminal.outcome !== "applied"
        ) {
          throw clientError(
            "MUTATION_OUTCOME_UNKNOWN",
            decision.terminal.outcome === "applied"
              ? "unknown"
              : decision.terminal.outcome,
            false,
            "inspect_device_state_before_retry",
          );
        }
        return {
          ...decision.terminal.value,
          result: {
            ...decision.terminal.value.result,
            outcome: "already_applied",
          },
        };
      }
      if (decision.kind === "conflict") {
        throw clientError(decision.code, "not_sent", false, "none");
      }
      if (decision.kind === "capacity_exceeded") {
        throw clientError(
          "ADMISSION_CAPACITY_EXCEEDED",
          "not_sent",
          true,
          "none",
        );
      }
      if (decision.kind !== "acquired") {
        throw clientError(
          "MUTATION_OUTCOME_UNKNOWN",
          "unknown",
          false,
          "inspect_device_state_before_retry",
        );
      }
      reservation = decision.reservation;
      const activeReservation = decision.reservation;

      const reconnected = await this.#withLock(scope.signal, async () => {
        this.#throwIfAborted(scope, false);
        const record = this.#recordForPrincipal(
          principal,
          requestedRef.sessionId,
        );
        if (record.sessionGeneration !== requestedRef.sessionGeneration) {
          throw clientError(
            "STALE_SESSION_GENERATION",
            "not_sent",
            false,
            "reconnect_then_capture",
          );
        }
        const previousConnectionEpoch = record.connectionEpoch;
        const previousBrowserChannelGeneration =
          record.browserChannelGeneration;
        const recordWasTakenOver = record.state === "taken_over";
        let takeoverPerformed = recordWasTakenOver;
        const incumbent = this.#activeRecord();
        if (incumbent !== null && incumbent.sessionId !== record.sessionId) {
          if (!takeover) {
            throw clientError(
              "CONTROL_BUSY",
              "not_sent",
              true,
              "wait_or_request_takeover",
            );
          }
          takeoverPerformed = true;
          irreversibleTransition = true;
          incumbent.state = "taken_over";
          incumbent.lifecycle.abort(new DeadlineAbort("caller"));
          planeInvoked = true;
          await this.#browser.close(this.#ref(incumbent), scope.remaining());
          if (this.#activeSessionId === incumbent.sessionId) {
            this.#activeSessionId = null;
          }
        } else if (recordWasTakenOver && !takeover) {
          throw clientError(
            "SESSION_TAKEN_OVER",
            "not_sent",
            false,
            "reconnect_then_capture",
          );
        }

        const previousGeneration = record.sessionGeneration;
        const previousRef = this.#ref(record);
        irreversibleTransition = true;
        record.state = "closing";
        record.lifecycle.abort(new DeadlineAbort("caller"));
        if (!recordWasTakenOver) {
          planeInvoked = true;
          await this.#browser.close(previousRef, scope.remaining());
          if (this.#activeSessionId === record.sessionId) {
            this.#activeSessionId = null;
          }
          this.#throwIfAborted(scope, true);
        }

        record.sessionGeneration += 1;
        record.state = "reconnecting";
        record.freshCaptureRequired = true;
        record.lifecycle = new AbortController();
        const nextRef = this.#ref(record);
        let connectionOpened = false;
        try {
          planeInvoked = true;
          const connection = await this.#browser.reconnect(
            nextRef,
            scope.remaining(),
          );
          connectionOpened = true;
          this.#assertConnection(connection, nextRef, {
            connectionEpoch: previousConnectionEpoch,
            browserChannelGeneration: previousBrowserChannelGeneration,
          });
          await this.#capabilitiesForConnection(connection, scope.remaining());
          this.#throwIfAborted(scope, true);
          const result: DeviceSessionReconnectSuccess = {
            ref: nextRef,
            result: {
              request_id: input.request_id,
              outcome: "applied",
              verification: "device_state_verified",
              safe_to_retry: false,
              required_next_step: "none",
              previous_session_generation: previousGeneration,
              new_session_generation: record.sessionGeneration,
              connection_epoch: connection.connectionEpoch,
              state: "ready",
              takeover_performed: takeoverPerformed,
              fresh_capture_required: true,
            },
          };
          if (
            !this.#requestLedger.complete(activeReservation, {
              outcome: "applied",
              verification: "device_state_verified",
              value: result,
            })
          ) {
            throw clientError(
              "MUTATION_OUTCOME_UNKNOWN",
              "unknown",
              false,
              "inspect_device_state_before_retry",
            );
          }
          record.state = "ready";
          record.connectionEpoch = connection.connectionEpoch;
          record.displayGeneration = connection.displayGeneration;
          record.browserChannelGeneration = connection.browserChannelGeneration;
          this.#activeSessionId = record.sessionId;
          return result;
        } catch (error) {
          record.state = "drained";
          if (this.#activeSessionId === record.sessionId) {
            this.#activeSessionId = null;
          }
          let failure = this.#mapFailure(
            error,
            scope,
            planeInvoked,
            irreversibleTransition,
          );
          if (connectionOpened || failure.outcome === "unknown") {
            const cleanupSucceeded = await this.#closeForCleanup(nextRef);
            if (!cleanupSucceeded) {
              this.#activeSessionId = record.sessionId;
              if (failure.outcome === "not_sent") {
                failure = clientError(
                  failure.code,
                  "unknown",
                  false,
                  "inspect_device_state_before_retry",
                );
              }
            }
          }
          throw failure;
        }
      });
      return reconnected;
    } catch (error) {
      const failure = this.#mapFailure(
        error,
        scope,
        planeInvoked,
        irreversibleTransition,
      );
      this.#finishFailedReservation(reservation, failure.outcome);
      throw failure;
    } finally {
      scope.dispose();
    }
  }

  public resolveSession(
    principal: string,
    ref: SessionRef,
  ): DeviceSessionSnapshot {
    const record = this.#recordForPrincipal(principal, ref.sessionId);
    if (record.sessionGeneration !== ref.sessionGeneration) {
      throw clientError(
        "STALE_SESSION_GENERATION",
        "not_sent",
        false,
        "reconnect_then_capture",
      );
    }
    if (record.state === "taken_over") {
      throw clientError(
        "SESSION_TAKEN_OVER",
        "not_sent",
        false,
        "reconnect_then_capture",
      );
    }
    if (
      record.state !== "ready" ||
      this.#activeSessionId !== record.sessionId
    ) {
      throw clientError(
        "SESSION_DRAINED",
        "not_sent",
        false,
        "reconnect_then_capture",
      );
    }
    return {
      ref: this.#ref(record),
      state: record.state,
      connectionEpoch: record.connectionEpoch,
      displayGeneration: record.displayGeneration,
      browserChannelGeneration: record.browserChannelGeneration,
      freshCaptureRequired: record.freshCaptureRequired,
    };
  }

  #deadline(timeoutMs: number, callerSignal?: AbortSignal): DeadlineScope {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60_000
    ) {
      throw clientError("DEADLINE_EXCEEDED", "not_sent", false, "none");
    }
    const startedAtMs = this.#scheduler.now();
    if (!Number.isFinite(startedAtMs)) {
      throw new Error("DeviceSessionScheduler.now() must be finite");
    }
    const deadlineAtMs = startedAtMs + timeoutMs;
    const controller = new AbortController();
    let abortKind: "caller" | "deadline" | null = null;
    const onCallerAbort = () => {
      if (!controller.signal.aborted) {
        abortKind = "caller";
        controller.abort(new DeadlineAbort("caller"));
      }
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted === true) {
      onCallerAbort();
    }
    const timer = this.#scheduler.setTimeout(() => {
      if (!controller.signal.aborted) {
        abortKind = "deadline";
        controller.abort(new DeadlineAbort("deadline"));
      }
    }, timeoutMs);
    return {
      deadlineAtMs,
      signal: controller.signal,
      remaining: () => ({
        timeoutMs: Math.max(0, Math.ceil(deadlineAtMs - this.#scheduler.now())),
        signal: controller.signal,
      }),
      abortKind: () => abortKind,
      dispose: () => {
        this.#scheduler.clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      },
    };
  }

  async #withLock<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#lockTail;
    const slot = Promise.withResolvers<void>();
    this.#lockTail = previous.then(() => slot.promise);
    const abort = Promise.withResolvers<never>();
    const onAbort = () => abort.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([previous, abort.promise]);
      signal.throwIfAborted();
      return await operation();
    } finally {
      signal.removeEventListener("abort", onAbort);
      slot.resolve();
    }
  }

  #throwIfAborted(scope: DeadlineScope, planeInvoked: boolean): void {
    if (!scope.signal.aborted) {
      return;
    }
    const kind = scope.abortKind();
    throw clientError(
      kind === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED",
      planeInvoked ? "unknown" : "not_sent",
      !planeInvoked,
      planeInvoked ? "inspect_device_state_before_retry" : "none",
    );
  }

  #mapFailure(
    error: unknown,
    scope: DeadlineScope,
    planeInvoked: boolean,
    irreversibleTransition: boolean,
  ): DeviceSessionClientError {
    if (error instanceof DeviceSessionClientError) {
      if (irreversibleTransition && error.outcome === "not_sent") {
        return clientError(
          error.code,
          "unknown",
          false,
          "inspect_device_state_before_retry",
        );
      }
      return error;
    }
    if (isDeviceSessionPlaneFailure(error)) {
      return clientError(
        error.code,
        irreversibleTransition ? "unknown" : error.outcome,
        irreversibleTransition ? false : error.safeToRetry,
        irreversibleTransition
          ? "inspect_device_state_before_retry"
          : error.requiredNextStep,
      );
    }
    if (scope.signal.aborted || error instanceof DeadlineAbort) {
      const kind =
        scope.abortKind() ??
        (error instanceof DeadlineAbort ? error.kind : "caller");
      return clientError(
        kind === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED",
        planeInvoked ? "unknown" : "not_sent",
        !planeInvoked,
        planeInvoked ? "inspect_device_state_before_retry" : "none",
      );
    }
    return clientError(
      "CONNECTION_LOST",
      planeInvoked ? "unknown" : "not_sent",
      false,
      planeInvoked
        ? "inspect_device_state_before_retry"
        : "reconnect_then_capture",
    );
  }

  #finishFailedReservation(
    reservation: LedgerReservation | null,
    outcome: DeviceSessionErrorOutcome,
  ): void {
    if (reservation === null) {
      return;
    }
    if (outcome === "not_sent") {
      this.#requestLedger.release(reservation, "not_sent");
      return;
    }
    this.#requestLedger.complete(reservation, {
      outcome: "unknown",
      verification: "none",
      value: { downstream_stage: "write" },
    });
  }

  async #closeForCleanup(ref: SessionRef): Promise<boolean> {
    const cleanupScope = this.#deadline(1_000);
    try {
      await this.#browser.close(ref, cleanupScope.remaining());
      return true;
    } catch {
      return false;
    } finally {
      cleanupScope.dispose();
    }
  }

  #activeRecord(): SessionRecord | null {
    return this.#activeSessionId === null
      ? null
      : (this.#sessions.get(this.#activeSessionId) ?? null);
  }

  #recordForPrincipal(principal: string, sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (record === undefined || record.principal !== principal) {
      throw clientError(
        "SESSION_NOT_FOUND",
        "not_sent",
        false,
        "reconnect_then_capture",
      );
    }
    return record;
  }

  #ref(record: SessionRecord): SessionRef {
    return {
      sessionId: record.sessionId,
      sessionGeneration: record.sessionGeneration,
    };
  }

  #assertConnection(
    connection: BrowserConnection,
    expected: SessionRef,
    previous?: {
      readonly connectionEpoch: number;
      readonly browserChannelGeneration: number | null;
    },
  ): void {
    const binding = connection.binding;
    const rpcBinding = connection.deviceRpc.binding;
    if (
      connection.state !== "ready" ||
      connection.ref.sessionId !== expected.sessionId ||
      connection.ref.sessionGeneration !== expected.sessionGeneration ||
      binding.sessionId !== expected.sessionId ||
      binding.sessionGeneration !== expected.sessionGeneration ||
      rpcBinding.sessionId !== expected.sessionId ||
      rpcBinding.sessionGeneration !== expected.sessionGeneration ||
      binding.connectionEpoch !== connection.connectionEpoch ||
      rpcBinding.connectionEpoch !== connection.connectionEpoch ||
      binding.browserChannelGeneration !==
        connection.browserChannelGeneration ||
      rpcBinding.browserChannelGeneration !==
        connection.browserChannelGeneration ||
      !Number.isSafeInteger(connection.connectionEpoch) ||
      connection.connectionEpoch < 1 ||
      !Number.isSafeInteger(connection.displayGeneration) ||
      connection.displayGeneration < 0 ||
      !Number.isSafeInteger(connection.browserChannelGeneration) ||
      connection.browserChannelGeneration < 1 ||
      (previous !== undefined &&
        (previous.browserChannelGeneration === null ||
          connection.connectionEpoch <= previous.connectionEpoch ||
          connection.browserChannelGeneration <=
            previous.browserChannelGeneration))
    ) {
      throw clientError(
        "DOWNSTREAM_MALFORMED_RESPONSE",
        "unknown",
        false,
        "inspect_device_state_before_retry",
      );
    }
  }
}
