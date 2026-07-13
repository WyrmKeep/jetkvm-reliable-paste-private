import type { Deadline } from "../../device/DeviceRpcAdapter.js";

export type PlaneOperation =
  | "connect"
  | "reconnect"
  | "capture"
  | "mouse"
  | "keyboard"
  | "paste"
  | "release"
  | "close"
  | "sessionStatus"
  | "displayStatus"
  | "powerControl"
  | "readDisplayState"
  | "readEdid"
  | "performAtx";

export type PlaneFault =
  | "deadline_before_admission"
  | "cancellation_before_admission"
  | "disconnect_before_write"
  | "disconnect_after_write_before_ack"
  | "disconnect_after_ack_before_post_read"
  | "disconnect_after_persisted_terminal"
  | "malformed_response"
  | "permission_denied"
  | "capability_missing"
  | "control_busy"
  | "takeover"
  | "stale_generation"
  | "partial_multi_event"
  | "partial_verification"
  | "cleanup_failure"
  | "post_reconnect_without_capture"
  | "event_gap"
  | "duplicate_request_id";

export interface PlaneScenarioStep {
  readonly operation: PlaneOperation;
  readonly fault?: PlaneFault;
  readonly result?: unknown;
  readonly dispatchedCount?: number;
  readonly completedCount?: number;
}

export interface PlaneScenario {
  readonly version: 1;
  readonly steps: readonly PlaneScenarioStep[];
}

export interface PlaneEvent {
  readonly sequence: number;
  readonly operation: PlaneOperation;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly fault?: PlaneFault;
  readonly terminalPersisted?: boolean;
}

interface FaultClassification {
  readonly code: string;
  readonly outcome: "not_sent" | "unknown" | "applied" | "already_applied";
  readonly boundary:
    | "admission"
    | "queue"
    | "send"
    | "ack"
    | "post_ack"
    | "persisted";
  readonly acknowledged: boolean;
  readonly suffixSuppressed: boolean;
}

const FAULT_CLASSIFICATION: Record<PlaneFault, FaultClassification> = {
  deadline_before_admission: {
    code: "DEADLINE_EXCEEDED",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  cancellation_before_admission: {
    code: "CANCELLED",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  disconnect_before_write: {
    code: "CONNECTION_LOST",
    outcome: "not_sent",
    boundary: "send",
    acknowledged: false,
    suffixSuppressed: false,
  },
  disconnect_after_write_before_ack: {
    code: "CONNECTION_LOST",
    outcome: "unknown",
    boundary: "ack",
    acknowledged: false,
    suffixSuppressed: false,
  },
  disconnect_after_ack_before_post_read: {
    code: "POST_ACK_READ_FAILED",
    outcome: "applied",
    boundary: "post_ack",
    acknowledged: true,
    suffixSuppressed: false,
  },
  disconnect_after_persisted_terminal: {
    code: "TERMINAL_RESULT_PRESERVED",
    outcome: "applied",
    boundary: "persisted",
    acknowledged: true,
    suffixSuppressed: false,
  },
  malformed_response: {
    code: "MALFORMED_RESPONSE",
    outcome: "unknown",
    boundary: "ack",
    acknowledged: false,
    suffixSuppressed: false,
  },
  permission_denied: {
    code: "PERMISSION_DENIED",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  capability_missing: {
    code: "CAPABILITY_MISSING",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  control_busy: {
    code: "CONTROL_BUSY",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  takeover: {
    code: "SESSION_TAKEN_OVER",
    outcome: "unknown",
    boundary: "ack",
    acknowledged: false,
    suffixSuppressed: false,
  },
  stale_generation: {
    code: "STALE_SESSION_GENERATION",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  partial_multi_event: {
    code: "PARTIAL_DISPATCH",
    outcome: "unknown",
    boundary: "ack",
    acknowledged: false,
    suffixSuppressed: true,
  },
  partial_verification: {
    code: "POST_ACK_READ_FAILED",
    outcome: "applied",
    boundary: "post_ack",
    acknowledged: true,
    suffixSuppressed: false,
  },
  cleanup_failure: {
    code: "CLEANUP_FAILED",
    outcome: "unknown",
    boundary: "post_ack",
    acknowledged: false,
    suffixSuppressed: true,
  },
  post_reconnect_without_capture: {
    code: "FRESH_CAPTURE_REQUIRED",
    outcome: "not_sent",
    boundary: "admission",
    acknowledged: false,
    suffixSuppressed: false,
  },
  event_gap: {
    code: "EVENT_GAP",
    outcome: "unknown",
    boundary: "ack",
    acknowledged: false,
    suffixSuppressed: true,
  },
  duplicate_request_id: {
    code: "ALREADY_APPLIED",
    outcome: "already_applied",
    boundary: "admission",
    acknowledged: true,
    suffixSuppressed: false,
  },
};

export class PlaneFaultError extends Error {
  public readonly name = "PlaneFaultError";
  public readonly code: string;
  public readonly outcome:
    | "not_sent"
    | "unknown"
    | "applied"
    | "already_applied";
  public readonly boundary: FaultClassification["boundary"];
  public readonly acknowledged: boolean;
  public readonly suffixSuppressed: boolean;

  public constructor(
    public readonly fault: PlaneFault,
    public readonly dispatchedCount: number,
    public readonly completedCount: number,
  ) {
    const classification = FAULT_CLASSIFICATION[fault];
    super(`The fake plane forced ${classification.code}.`);
    this.code = classification.code;
    this.outcome = classification.outcome;
    this.boundary = classification.boundary;
    this.acknowledged = classification.acknowledged;
    this.suffixSuppressed = classification.suffixSuppressed;
  }
}

export class PlaneScenarioEngine {
  private steps: PlaneScenarioStep[] = [];
  private readonly eventLog: PlaneEvent[] = [];
  private sequence = 0;

  public loadScenario(scenario: PlaneScenario): void {
    if (scenario.version !== 1 || !Array.isArray(scenario.steps)) {
      throw new Error("Invalid fake plane scenario.");
    }
    this.steps = scenario.steps.map((step) => ({ ...step }));
    this.eventLog.length = 0;
    this.sequence = 0;
  }

  public consume(
    operation: PlaneOperation,
    metadata: Readonly<Record<string, unknown>>,
    deadline: Deadline,
  ): unknown {
    if (deadline.signal.aborted) {
      throw new PlaneFaultError("cancellation_before_admission", 0, 0);
    }
    if (!Number.isSafeInteger(deadline.timeoutMs) || deadline.timeoutMs < 100) {
      throw new PlaneFaultError("deadline_before_admission", 0, 0);
    }
    const step = this.steps[0];
    if (step === undefined || step.operation !== operation) {
      throw new Error(
        `Unexpected fake plane call ${operation}; expected ${step?.operation ?? "no further calls"}.`,
      );
    }
    this.steps.shift();
    const event: PlaneEvent = {
      sequence: ++this.sequence,
      operation,
      metadata,
      ...(step.fault === undefined ? {} : { fault: step.fault }),
      ...(step.fault === "disconnect_after_persisted_terminal"
        ? { terminalPersisted: true }
        : {}),
    };
    this.eventLog.push(Object.freeze(event));
    if (step.fault === "disconnect_after_persisted_terminal") {
      if (step.result === undefined) {
        throw new Error("A persisted-terminal fake step requires a result.");
      }
      return step.result;
    }
    if (step.fault !== undefined) {
      throw new PlaneFaultError(
        step.fault,
        step.dispatchedCount ?? 0,
        step.completedCount ?? 0,
      );
    }
    return step.result;
  }

  public events(): readonly PlaneEvent[] {
    return this.eventLog;
  }

  public assertExhausted(): void {
    if (this.steps.length !== 0) {
      throw new Error(
        `${this.steps.length} unconsumed fake plane scenario step(s).`,
      );
    }
  }
}
