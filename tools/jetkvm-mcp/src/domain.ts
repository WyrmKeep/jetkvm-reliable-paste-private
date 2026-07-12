export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MutationOutcome = "not_sent" | "sent" | "unknown";
export type MouseButton = "left" | "middle" | "right";
export type Point = { x: number; y: number };

type ModifiedAction = { keys?: string[] };

export type ClickAction = ModifiedAction & Point & { type: "click"; button?: MouseButton };
export type DoubleClickAction = ModifiedAction & Point & { type: "double_click"; button?: MouseButton };
export type MoveAction = ModifiedAction & Point & { type: "move" };
export type DragAction = ModifiedAction & { type: "drag"; path: Point[] };
export type ScrollAction = ModifiedAction & Point & { type: "scroll"; scrollY: number; scrollX?: 0 };
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

export type CoordinateAction = Extract<Action, { type: "click" | "double_click" | "move" | "drag" | "scroll" }>;

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

export interface View {
  viewId: string;
  connectionEpoch: number;
  displayGeneration: number;
  capturedAt: string;
  width: number;
  height: number;
  format: "jpeg" | "png";
  sha256: string;
  imageBase64: string;
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
}

export interface ComputerScreenshotSuccess extends SuccessEnvelope {
  view: View;
}

export interface MutationReceipt {
  dispatchedAt: string;
  sourceViewId: string;
}

export interface ComputerActionsSuccess extends SuccessEnvelope {
  outcome: "sent";
  completedActionCount: number;
  receipt: MutationReceipt;
  view: View;
}

export interface ComputerPasteTextSuccess extends SuccessEnvelope {
  outcome: "sent";
  originalByteCount: number;
  normalizedByteCount: number;
  normalizedSha256: string;
  view: View;
}

export type UnknownFact = "unknown";

export interface ControllerStatus {
  mode: "observe" | "control";
  controller: "idle" | "starting" | "ready" | "closed" | "failed" | UnknownFact;
  ownership: "unclaimed" | "owned" | "taken_over" | UnknownFact;
  device: "reachable" | "unreachable" | UnknownFact;
  auth: "no_password" | "password_required" | "authenticated" | "failed" | UnknownFact;
  browser: "not_started" | "starting" | "ready" | "failed" | UnknownFact;
  webRtc: "connecting" | "connected" | "disconnected" | "failed" | UnknownFact;
  hidRpc: "ready" | "not_ready" | UnknownFact;
  video: "ready" | "stalled" | "unavailable" | UnknownFact;
  pasteLifecycle: "ready" | "unsupported" | UnknownFact;
  mutationGate: string | null;
  [key: string]: JsonValue;
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

export type ComputerScreenshotResult = ComputerScreenshotSuccess | FailureEnvelope;
export type ComputerActionsResult = ComputerActionsSuccess | FailureEnvelope;
export type ComputerPasteTextResult = ComputerPasteTextSuccess | FailureEnvelope;
export type ComputerStatusResult = ComputerStatusSuccess | FailureEnvelope;
export type ComputerReleaseInputResult = ComputerReleaseInputSuccess | FailureEnvelope;

export type ToolResult =
  | ComputerScreenshotSuccess
  | ComputerActionsSuccess
  | ComputerPasteTextSuccess
  | ComputerStatusSuccess
  | ComputerReleaseInputSuccess
  | FailureEnvelope;
