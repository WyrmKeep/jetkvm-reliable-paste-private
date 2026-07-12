export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MutationOutcome = "not_sent" | "sent" | "unknown";
export type MouseButton = "left" | "middle" | "right";
export type Point = { x: number; y: number };

type ModifiedAction = { keys?: string[] };

export type ClickAction = ModifiedAction &
  Point & { type: "click"; button?: MouseButton };
export type DoubleClickAction = ModifiedAction &
  Point & { type: "double_click"; button?: MouseButton };
export type MoveAction = ModifiedAction & Point & { type: "move" };
export type DragAction = ModifiedAction & { type: "drag"; path: Point[] };
export type ScrollAction = ModifiedAction &
  Point & { type: "scroll"; scrollY: number; scrollX?: 0 };
export type KeypressAction = { type: "keypress"; keys: string[] };
export type TypeAction = { type: "type"; text: string };
export type WaitAction = { type: "wait"; ms: number };

export type Action =
  | ClickAction
  | DoubleClickAction
  | MoveAction
  | DragAction
  | ScrollAction
  | KeypressAction
  | TypeAction
  | WaitAction;

export type CoordinateAction = Extract<
  Action,
  { type: "click" | "double_click" | "move" | "drag" | "scroll" }
>;

const COORDINATE_ACTION_TYPES: Record<CoordinateAction["type"], true> = {
  click: true,
  double_click: true,
  move: true,
  drag: true,
  scroll: true,
};

export function isCoordinateAction(action: Action): action is CoordinateAction {
  return action.type in COORDINATE_ACTION_TYPES;
}

declare const viewIdBrand: unique symbol;
export type ViewId = string & { readonly [viewIdBrand]: "ViewId" };

export interface ContentGeometry {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly renderedX: number;
  readonly renderedY: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly fingerprint: string;
}

export interface View {
  readonly viewId: ViewId;
  readonly connectionEpoch: number;
  readonly displayGeneration: number;
  readonly decodedFrameId: string;
  readonly decodedMediaTimeSeconds: number;
  readonly capturedAt: string;
  readonly capturedAtMonotonicMs: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly rotationDegrees: 0 | 90 | 180 | 270;
  readonly contentGeometry: Readonly<ContentGeometry>;
  readonly format: "jpeg" | "png";
  readonly sha256: string;
  readonly imageBase64: string;
}

export interface SuccessEnvelope {
  ok: true;
  operationId: string;
  connectionEpoch: number;
  displayGeneration: number;
  durationMs: number;
}

export interface FailureEnvelope {
  ok: false;
  operationId?: string;
  error: {
    code: string;
    message: string;
    phase: string;
    outcome: MutationOutcome;
    retryable: boolean;
    effectsUnknown: boolean;
    [key: string]: JsonValue | undefined;
  };
  view?: View;
}

export interface ComputerScreenshotSuccess extends SuccessEnvelope {
  view: View;
}

export interface MutationReceipt {
  dispatchedAt: string;
  sourceViewId: ViewId;
}

interface ComputerActionsSuccessBase extends SuccessEnvelope {
  completedActionCount: number;
  view: View;
}

export interface ComputerActionsWaitOnlySuccess extends ComputerActionsSuccessBase {
  outcome: "not_sent";
  receipt?: never;
}

export interface ComputerActionsDispatchedSuccess extends ComputerActionsSuccessBase {
  outcome: "sent";
  receipt: MutationReceipt;
}

export type ComputerActionsSuccess =
  | ComputerActionsWaitOnlySuccess
  | ComputerActionsDispatchedSuccess;

export interface ComputerPasteTextSuccess extends SuccessEnvelope {
  outcome: "sent";
  originalByteCount: number;
  normalizedByteCount: number;
  normalizedSha256: string;
  view: View;
}

export type UnknownFact = "unknown";

export interface CurrentPasteStatus {
  operationId: string;
  state:
    | "submitted"
    | "active"
    | "succeeded"
    | "failed"
    | "cancelled"
    | UnknownFact;
}

export interface ControllerStatus {
  mode: "observe" | "control";
  controller: "idle" | "starting" | "ready" | "closed" | "failed" | UnknownFact;
  ownership: "unclaimed" | "owned" | "taken_over" | UnknownFact;
  takeover: "none" | "taken_over" | UnknownFact;
  setup: "required" | "complete" | UnknownFact;
  deviceReachability: "reachable" | "unreachable" | UnknownFact;
  authMode:
    | "no_password"
    | "password_required"
    | "authenticated"
    | "failed"
    | UnknownFact;
  browser: "not_started" | "starting" | "ready" | "failed" | UnknownFact;
  page: "not_started" | "loading" | "ready" | "failed" | UnknownFact;
  route: "not_mounted" | "mounted" | "failed" | UnknownFact;
  webRtc: "connecting" | "connected" | "disconnected" | "failed" | UnknownFact;
  hidRpc: "ready" | "not_ready" | UnknownFact;
  video: "ready" | "stalled" | "unavailable" | UnknownFact;
  connectionEpoch: number | UnknownFact;
  displayGeneration: number | UnknownFact;
  nativeWidth: number | UnknownFact;
  nativeHeight: number | UnknownFact;
  lastDecodedFrameAgeMs: number | UnknownFact;
  pasteCapability: "ready" | "unsupported" | UnknownFact;
  currentPaste: CurrentPasteStatus | null | UnknownFact;
  mutationGateReason: string | null;
  serverVersion: string | UnknownFact;
  packageVersion: string | UnknownFact;
  protocolVersion: string | UnknownFact;
  uiContractVersion: number | UnknownFact;
}

export interface ComputerStatusSuccess extends SuccessEnvelope {
  status: ControllerStatus;
}

export interface ReleaseReceipt {
  operationId: string;
  serverGeneration: number;
  draining: true;
  emittersJoined: true;
  pasteInactive: true;
  macroInactive: true;
  ordinaryLeases: 0;
  keyboardZeroed: true;
  pointerZeroed: true;
}

export interface ComputerReleaseInputSuccess extends SuccessEnvelope {
  outcome: "sent";
  receipt: ReleaseReceipt;
}

export type ComputerScreenshotResult =
  | ComputerScreenshotSuccess
  | FailureEnvelope;
export type ComputerActionsResult = ComputerActionsSuccess | FailureEnvelope;
export type ComputerPasteTextResult =
  | ComputerPasteTextSuccess
  | FailureEnvelope;
export type ComputerStatusResult = ComputerStatusSuccess | FailureEnvelope;
export type ComputerReleaseInputResult =
  | ComputerReleaseInputSuccess
  | FailureEnvelope;

export type ToolResult =
  | ComputerScreenshotSuccess
  | ComputerActionsSuccess
  | ComputerPasteTextSuccess
  | ComputerStatusSuccess
  | ComputerReleaseInputSuccess
  | FailureEnvelope;
