import { normalizePasteText } from "@/utils/pasteText";

import { makeBridgeError } from "./bridge";
import type {
  AutomationBridgeStage,
  AutomationSnapshot,
  BridgeRequest,
  InputBridgeRequest,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  PasteBridgeRequest,
} from "./protocol";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MOUSE_OPERATIONS = 1056;
const MAX_KEYBOARD_OPERATIONS = 1024;
const MAX_PASTE_BYTES = 262_144;

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function invalid(request: Partial<BridgeRequest>, snapshot: AutomationSnapshot): never {
  throw makeBridgeError("INVALID_REQUEST", "admission", {
    snapshot,
    operationId: typeof request.operation_id === "string" ? request.operation_id : null,
  });
}

export function validateBridgeRequest(
  request: BridgeRequest,
  snapshot: AutomationSnapshot,
  maximumTimeoutMs: number,
): void {
  if (
    typeof request !== "object" ||
    request === null ||
    !OPAQUE_ID_PATTERN.test(request.operation_id) ||
    !isPositiveSafeInteger(request.expected_lifecycle_generation) ||
    !isPositiveSafeInteger(request.expected_channel_generation) ||
    !Number.isSafeInteger(request.timeout_ms) ||
    request.timeout_ms < 100 ||
    request.timeout_ms > maximumTimeoutMs
  ) {
    invalid(request, snapshot);
  }
  if (
    request.expected_lifecycle_generation !== snapshot.lifecycle_generation ||
    request.expected_channel_generation !== snapshot.channel_generation
  ) {
    throw makeBridgeError("GENERATION_MISMATCH", "admission", {
      snapshot,
      operationId: request.operation_id,
    });
  }
}

export function validateInputBridgeRequest(
  request: InputBridgeRequest,
  snapshot: AutomationSnapshot,
  maximumTimeoutMs: number,
): void {
  validateBridgeRequest(request, snapshot, maximumTimeoutMs);
  if (
    !isPositiveSafeInteger(request.expected_display_generation) ||
    !isPositiveSafeInteger(request.expected_dispatch_generation)
  ) {
    invalid(request, snapshot);
  }
  if (
    request.expected_display_generation !== snapshot.display_generation ||
    request.expected_dispatch_generation !== snapshot.dispatch_generation
  ) {
    throw makeBridgeError("GENERATION_MISMATCH", "admission", {
      snapshot,
      operationId: request.operation_id,
    });
  }
}

export function validateMouseRequest(
  request: MouseBridgeRequest,
  snapshot: AutomationSnapshot,
): void {
  validateInputBridgeRequest(request, snapshot, 60_000);
  if (
    !Array.isArray(request.operations) ||
    request.operations.length === 0 ||
    request.operations.length > MAX_MOUSE_OPERATIONS
  ) {
    invalid(request, snapshot);
  }
  for (const operation of request.operations) {
    if (operation.kind === "absolute") {
      if (
        !Number.isInteger(operation.x) ||
        operation.x < 0 ||
        operation.x > 32767 ||
        !Number.isInteger(operation.y) ||
        operation.y < 0 ||
        operation.y > 32767 ||
        !Number.isInteger(operation.buttons) ||
        operation.buttons < 0 ||
        operation.buttons > 7
      ) {
        invalid(request, snapshot);
      }
    } else if (operation.kind === "wheel") {
      if (
        !Number.isInteger(operation.delta_y) ||
        operation.delta_y === 0 ||
        operation.delta_y < -127 ||
        operation.delta_y > 127
      ) {
        invalid(request, snapshot);
      }
    } else {
      invalid(request, snapshot);
    }
  }
}

export function validateKeyboardRequest(
  request: KeyboardBridgeRequest,
  snapshot: AutomationSnapshot,
): void {
  validateInputBridgeRequest(request, snapshot, 60_000);
  if (
    !Array.isArray(request.operations) ||
    request.operations.length === 0 ||
    request.operations.length > MAX_KEYBOARD_OPERATIONS
  ) {
    invalid(request, snapshot);
  }
  for (const operation of request.operations) {
    if (
      !Number.isInteger(operation.key) ||
      operation.key < 1 ||
      operation.key > 255 ||
      typeof operation.press !== "boolean"
    ) {
      invalid(request, snapshot);
    }
  }
}

export function validatePasteRequest(
  request: PasteBridgeRequest,
  snapshot: AutomationSnapshot,
): string {
  validateInputBridgeRequest(request, snapshot, 300_000);
  if (typeof request.text !== "string") invalid(request, snapshot);
  const normalized = normalizePasteText(request.text);
  const byteLength = new TextEncoder().encode(normalized).byteLength;
  if (byteLength === 0 || byteLength > MAX_PASTE_BYTES) invalid(request, snapshot);
  return normalized;
}

export class OperationFence {
  private writeBegan = false;
  private acknowledged = false;
  private dispatchedCount = 0;
  private completedCount = 0;

  private readonly request: BridgeRequest | InputBridgeRequest;
  private readonly getSnapshot: () => AutomationSnapshot;
  private readonly isOwnerActive: () => boolean;
  private readonly startedAtMs: number;

  constructor(
    request: BridgeRequest | InputBridgeRequest,
    getSnapshot: () => AutomationSnapshot,
    isOwnerActive: () => boolean,
    startedAtMs: number,
  ) {
    this.request = request;
    this.getSnapshot = getSnapshot;
    this.isOwnerActive = isOwnerActive;
    this.startedAtMs = startedAtMs;
  }

  markWriteBegan(): void {
    this.writeBegan = true;
  }

  markDispatched(): void {
    this.dispatchedCount += 1;
  }

  markCompleted(): void {
    this.completedCount += 1;
  }

  markAcknowledged(): void {
    this.acknowledged = true;
  }

  outcome(): {
    readonly writeBegan: boolean;
    readonly acknowledged: boolean;
    readonly dispatchedCount: number;
    readonly completedCount: number;
  } {
    return {
      writeBegan: this.writeBegan,
      acknowledged: this.acknowledged,
      dispatchedCount: this.dispatchedCount,
      completedCount: this.completedCount,
    };
  }
  remainingMs(nowMs: number = performance.now()): number {
    const remaining = this.request.timeout_ms - (nowMs - this.startedAtMs);
    if (remaining <= 0) return 0;
    return Math.max(1, Math.floor(remaining));
  }

  verify(stage: AutomationBridgeStage, nowMs: number = performance.now()): void {
    const snapshot = this.getSnapshot();
    if (nowMs - this.startedAtMs >= this.request.timeout_ms) {
      this.raise("DEADLINE_EXCEEDED", stage, snapshot);
    }
    if (
      !this.isOwnerActive() ||
      snapshot.lifecycle_generation !== this.request.expected_lifecycle_generation ||
      snapshot.channel_generation !== this.request.expected_channel_generation
    ) {
      this.raise("CHANNEL_LOST", stage, snapshot);
    }
    if (
      "expected_display_generation" in this.request &&
      snapshot.display_generation !== this.request.expected_display_generation
    ) {
      this.raise("DISPLAY_CHANGED", stage, snapshot);
    }
    if (
      "expected_dispatch_generation" in this.request &&
      snapshot.dispatch_generation !== this.request.expected_dispatch_generation
    ) {
      this.raise("DISPATCH_REPLACED", stage, snapshot);
    }
    if (snapshot.state === "closed") this.raise("CLOSED", stage, snapshot);
    if (snapshot.state !== "ready") this.raise("NOT_READY", stage, snapshot);
  }

  private raise(
    code:
      | "DEADLINE_EXCEEDED"
      | "CHANNEL_LOST"
      | "DISPLAY_CHANGED"
      | "DISPATCH_REPLACED"
      | "CLOSED"
      | "NOT_READY",
    stage: AutomationBridgeStage,
    snapshot: AutomationSnapshot,
  ): never {
    throw makeBridgeError(code, stage, {
      snapshot,
      operationId: this.request.operation_id,
      displayGeneration:
        "expected_display_generation" in this.request
          ? this.request.expected_display_generation
          : null,
      dispatchGeneration:
        "expected_dispatch_generation" in this.request
          ? this.request.expected_dispatch_generation
          : null,
      writeBegan: this.writeBegan,
      acknowledged: this.acknowledged,
      dispatchedCount: this.dispatchedCount,
      completedCount: this.completedCount,
    });
  }
}
