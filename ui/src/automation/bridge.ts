import type {
  AutomationBridgeError,
  AutomationBridgeErrorCode,
  AutomationBridgeStage,
  AutomationSnapshot,
  CaptureBridgeRequest,
  AtxBridgeRequest,
  CaptureBridgeResult,
  JetKvmAutomationV1,
  KeyboardBridgeReceipt,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  MutationBridgeReceipt,
  PasteBridgeReceipt,
  PasteBridgeRequest,
  ReadBridgeRequest,
  ReadBridgeResult,
  ReleaseBridgeReceipt,
  ReleaseBridgeRequest,
} from "./protocol";

export type AutomationInvalidationReason = "replaced" | "unmounted";

export interface AutomationOwner {
  snapshot(): AutomationSnapshot;
  cancel(operationId: string): boolean;
  capture(request: CaptureBridgeRequest): Promise<CaptureBridgeResult>;
  mouse(request: MouseBridgeRequest): Promise<MutationBridgeReceipt>;
  keyboard(request: KeyboardBridgeRequest): Promise<KeyboardBridgeReceipt>;
  paste(request: PasteBridgeRequest): Promise<PasteBridgeReceipt>;
  release(request: ReleaseBridgeRequest): Promise<ReleaseBridgeReceipt>;
  readVideoState(request: ReadBridgeRequest): Promise<ReadBridgeResult>;
  readEdid(request: ReadBridgeRequest): Promise<ReadBridgeResult>;
  performAtx(request: AtxBridgeRequest): Promise<ReadBridgeResult>;
  activate?(lifecycleGeneration: number): void;
  invalidate(reason: AutomationInvalidationReason): void;
}

export interface AutomationOwnerToken {
  unbind(): void;
}

export interface AutomationFacadeRegistry {
  readonly facade: JetKvmAutomationV1;
  bind(owner: AutomationOwner): AutomationOwnerToken;
}

interface AutomationGlobalTarget {
  __JETKVM_AUTOMATION__?: JetKvmAutomationV1;
  [REGISTRY_KEY]?: AutomationFacadeRegistry;
}

export interface BridgeErrorContext {
  readonly snapshot: AutomationSnapshot;
  readonly operationId?: string | null;
  readonly displayGeneration?: number | null;
  readonly dispatchGeneration?: number | null;
  readonly writeBegan?: boolean;
  readonly acknowledged?: boolean;
  readonly dispatchedCount?: number;
  readonly completedCount?: number;
  readonly outcome?: "not_sent" | "unknown";
}

const REGISTRY_KEY = Symbol.for("jetkvm.automation.registry.v1");

const SAFE_ERROR_MESSAGES: Record<AutomationBridgeErrorCode, string> = {
  INVALID_REQUEST: "The automation request is invalid.",
  NOT_READY: "The managed device route is not ready.",
  UNMOUNTED: "The managed device route is unmounted.",
  CLOSED: "The automation mutation gate is closed.",
  GENERATION_MISMATCH: "The automation generation is stale.",
  DEADLINE_EXCEEDED: "The automation deadline elapsed.",
  CANCELLED: "The automation operation was cancelled.",
  CHANNEL_LOST: "The managed product channel was lost.",
  DISPLAY_CHANGED: "The decoded display changed.",
  DISPATCH_REPLACED: "The input dispatch generation changed.",
  DOWNSTREAM_ERROR: "The product operation failed.",
  EDID_READ_FAILED: "The native EDID read failed.",
  ATX_EXTENSION_INACTIVE: "The ATX extension is inactive.",
  ATX_SERIAL_UNAVAILABLE: "The ATX serial controller is unavailable.",
  REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT:
    "The ATX request id was reused with different input.",
  STALE_SESSION_GENERATION: "The device session generation is stale.",
  MUTATION_OUTCOME_UNKNOWN: "The ATX mutation outcome is unknown.",
  CONFIG_INVALID: "The ATX action configuration is invalid.",
  DOWNSTREAM_MALFORMED_RESPONSE: "The ATX response was malformed.",
  MALFORMED_ACKNOWLEDGEMENT: "The product acknowledgement was invalid.",
  VIDEO_STALLED: "The decoded video did not advance.",
  CAPTURE_FAILED: "The decoded frame could not be captured.",
  CAPTURE_TOO_LARGE: "The captured frame exceeds the byte limit.",
  MIME_MISMATCH: "The captured frame MIME type is invalid.",
  PASTE_UNSUPPORTED: "Reliable Paste is unavailable.",
  PASTE_LIFECYCLE: "Reliable Paste completion could not be verified.",
  RELEASE_FAILED: "The correlated input release could not be verified.",
};

export function makeBridgeError(
  code: AutomationBridgeErrorCode,
  stage: AutomationBridgeStage,
  context: BridgeErrorContext,
): AutomationBridgeError {
  const { snapshot } = context;
  return Object.freeze({
    version: 1,
    name: "JetKvmAutomationError",
    code,
    stage,
    outcome: context.outcome ?? (context.writeBegan ? "unknown" : "not_sent"),
    operation_id: context.operationId ?? null,
    lifecycle_generation: snapshot.lifecycle_generation,
    channel_generation: snapshot.channel_generation,
    display_generation: context.displayGeneration ?? snapshot.display_generation,
    dispatch_generation: context.dispatchGeneration ?? snapshot.dispatch_generation,
    write_began: context.writeBegan ?? false,
    acknowledged: context.acknowledged ?? false,
    dispatched_count: context.dispatchedCount ?? 0,
    completed_count: context.completedCount ?? 0,
    message: SAFE_ERROR_MESSAGES[code],
  });
}

function emptySnapshot(lifecycleGeneration: number): AutomationSnapshot {
  return Object.freeze({
    version: 1,
    state: "unmounted",
    lifecycle_generation: lifecycleGeneration,
    channel_generation: lifecycleGeneration,
    display_generation: lifecycleGeneration,
    dispatch_generation: lifecycleGeneration,
    rpc_ready: false,
    hid_ready: false,
    video_ready: false,
    absolute_pointer: false,
    scroll_throttling_disabled: false,
    keyboard_layout: null,
    reliable_paste: false,
    source_width: null,
    source_height: null,
  });
}

class Registry implements AutomationFacadeRegistry {
  readonly facade: JetKvmAutomationV1;
  private owner: AutomationOwner | null = null;
  private ownerIdentity: symbol | null = null;
  private lifecycleGeneration = 1;

  constructor() {
    const delegate = <Request, Result>(
      method: (owner: AutomationOwner, request: Request) => Promise<Result>,
    ) => {
      return async (request: Request): Promise<Result> => {
        const current = this.owner;
        const currentSnapshot = current?.snapshot() ?? emptySnapshot(this.lifecycleGeneration);
        if (!current || currentSnapshot.state !== "ready") {
          const code =
            currentSnapshot.state === "closed"
              ? "CLOSED"
              : currentSnapshot.state === "not_ready"
                ? "NOT_READY"
                : "UNMOUNTED";
          const operationId =
            typeof request === "object" && request !== null && "operation_id" in request
              ? String(request.operation_id)
              : null;
          throw makeBridgeError(code, "admission", {
            snapshot: currentSnapshot,
            operationId,
          });
        }
        return method(current, request);
      };
    };

    this.facade = Object.freeze({
      version: 1,
      snapshot: () => this.owner?.snapshot() ?? emptySnapshot(this.lifecycleGeneration),
      cancel: (operationId: string) => this.owner?.cancel(operationId) ?? false,
      capture: delegate((owner, request: CaptureBridgeRequest) => owner.capture(request)),
      mouse: delegate((owner, request: MouseBridgeRequest) => owner.mouse(request)),
      keyboard: delegate((owner, request: KeyboardBridgeRequest) => owner.keyboard(request)),
      paste: delegate((owner, request: PasteBridgeRequest) => owner.paste(request)),
      release: delegate((owner, request: ReleaseBridgeRequest) => owner.release(request)),
      readVideoState: delegate((owner, request: ReadBridgeRequest) =>
        owner.readVideoState(request),
      ),
      readEdid: delegate((owner, request: ReadBridgeRequest) => owner.readEdid(request)),
      performAtx: delegate((owner, request: AtxBridgeRequest) =>
        owner.performAtx(request),
      ),
    });
  }

  bind(owner: AutomationOwner): AutomationOwnerToken {
    const previous = this.owner;
    const previousSnapshot = previous?.snapshot();
    if (previous) previous.invalidate("replaced");

    this.lifecycleGeneration = Math.max(
      this.lifecycleGeneration + 1,
      (previousSnapshot?.lifecycle_generation ?? 0) + 1,
    );
    owner.activate?.(this.lifecycleGeneration);
    this.lifecycleGeneration = Math.max(
      this.lifecycleGeneration,
      owner.snapshot().lifecycle_generation,
    );
    const identity = Symbol("automation-owner");
    this.owner = owner;
    this.ownerIdentity = identity;

    let unbound = false;
    return Object.freeze({
      unbind: () => {
        if (unbound) return;
        unbound = true;
        if (this.ownerIdentity !== identity || this.owner !== owner) return;
        const finalSnapshot = owner.snapshot();
        owner.invalidate("unmounted");
        const invalidatedSnapshot = owner.snapshot();
        this.owner = null;
        this.ownerIdentity = null;
        this.lifecycleGeneration = Math.max(
          this.lifecycleGeneration + 1,
          finalSnapshot.lifecycle_generation + 1,
          invalidatedSnapshot.lifecycle_generation + 1,
        );
      },
    });
  }
}

export function createAutomationFacadeRegistry(
  target: Record<PropertyKey, unknown> = window as unknown as Record<PropertyKey, unknown>,
): AutomationFacadeRegistry {
  const automationTarget = target as AutomationGlobalTarget;
  const existing = automationTarget[REGISTRY_KEY];
  if (existing) return existing;

  if (automationTarget.__JETKVM_AUTOMATION__ !== undefined) {
    throw new Error("A different JetKVM automation facade is already installed.");
  }

  const registry = new Registry();
  Object.defineProperty(automationTarget, REGISTRY_KEY, {
    configurable: false,
    enumerable: false,
    value: registry,
    writable: false,
  });
  Object.defineProperty(automationTarget, "__JETKVM_AUTOMATION__", {
    configurable: false,
    enumerable: false,
    value: registry.facade,
    writable: false,
  });
  return registry;
}
