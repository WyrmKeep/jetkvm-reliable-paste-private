import type { MouseAction, MouseButton, Point } from "../domain.js";

const HID_ABSOLUTE_MAX = 32_767;
const MAX_MOUSE_ACTIONS = 16;
const MIN_DRAG_POINTS = 2;
const MAX_DRAG_POINTS = 64;

export interface CapturedContentGeometry {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

export type ExpandedMouseOperation =
  | {
      readonly kind: "absolute";
      readonly x: number;
      readonly y: number;
      readonly buttons: number;
    }
  | { readonly kind: "wheel"; readonly delta_y: number };

export interface ExpandedMouseActions {
  readonly operations: readonly ExpandedMouseOperation[];
  /** Exclusive operation offsets at which each public action is complete. */
  readonly actionOperationEnds: readonly number[];
}

const BUTTON_MASK: Readonly<Record<MouseButton, number>> = Object.freeze({
  left: 1,
  right: 2,
  middle: 4,
});

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer coordinate.`);
  }
}

function assertGeometry(geometry: CapturedContentGeometry): void {
  const values = [
    geometry.imageWidth,
    geometry.imageHeight,
    geometry.contentX,
    geometry.contentY,
    geometry.contentWidth,
    geometry.contentHeight,
  ];
  if (!values.every(Number.isSafeInteger)) {
    throw new RangeError("Captured geometry must contain integers.");
  }
  if (
    geometry.imageWidth <= 0 ||
    geometry.imageHeight <= 0 ||
    geometry.contentX < 0 ||
    geometry.contentY < 0 ||
    geometry.contentWidth <= 0 ||
    geometry.contentHeight <= 0 ||
    geometry.contentX + geometry.contentWidth > geometry.imageWidth ||
    geometry.contentY + geometry.contentHeight > geometry.imageHeight
  ) {
    throw new RangeError("Captured content geometry is invalid.");
  }
}

function mapAxis(value: number, start: number, length: number): number {
  if (length === 1) return 0;
  return Math.round(((value - start) * HID_ABSOLUTE_MAX) / (length - 1));
}

export function mapImagePointToAbsolute(
  point: Readonly<Point>,
  geometry: CapturedContentGeometry,
): { readonly x: number; readonly y: number } {
  assertGeometry(geometry);
  assertSafeInteger(point.x, "x");
  assertSafeInteger(point.y, "y");
  if (
    point.x < geometry.contentX ||
    point.x >= geometry.contentX + geometry.contentWidth ||
    point.y < geometry.contentY ||
    point.y >= geometry.contentY + geometry.contentHeight
  ) {
    throw new RangeError("The coordinate is outside captured content.");
  }
  return {
    x: mapAxis(point.x, geometry.contentX, geometry.contentWidth),
    y: mapAxis(point.y, geometry.contentY, geometry.contentHeight),
  };
}

function absolute(
  point: Readonly<Point>,
  geometry: CapturedContentGeometry,
  buttons: number,
): ExpandedMouseOperation {
  return {
    kind: "absolute",
    ...mapImagePointToAbsolute(point, geometry),
    buttons,
  };
}

function assertButton(button: MouseButton): number {
  const mask = BUTTON_MASK[button];
  if (mask === undefined) throw new RangeError("Mouse button is invalid.");
  return mask;
}

function appendClick(
  operations: ExpandedMouseOperation[],
  action: Extract<MouseAction, { readonly type: "click" | "double_click" }>,
  geometry: CapturedContentGeometry,
): void {
  const point = { x: action.x, y: action.y };
  const mask = assertButton(action.button);
  operations.push(absolute(point, geometry, 0));
  const repetitions = action.type === "double_click" ? 2 : 1;
  for (let index = 0; index < repetitions; index += 1) {
    operations.push(absolute(point, geometry, mask));
    operations.push(absolute(point, geometry, 0));
  }
}

function appendDrag(
  operations: ExpandedMouseOperation[],
  action: Extract<MouseAction, { readonly type: "drag" }>,
  geometry: CapturedContentGeometry,
): void {
  if (
    !Array.isArray(action.path) ||
    action.path.length < MIN_DRAG_POINTS ||
    action.path.length > MAX_DRAG_POINTS
  ) {
    throw new RangeError("Drag path must contain 2 through 64 coordinates.");
  }
  const mask = assertButton(action.button);
  const first = action.path[0];
  if (first === undefined) throw new RangeError("Drag path is invalid.");
  operations.push(absolute(first, geometry, 0));
  operations.push(absolute(first, geometry, mask));
  for (let index = 1; index < action.path.length; index += 1) {
    const point = action.path[index];
    if (point === undefined) throw new RangeError("Drag path is invalid.");
    operations.push(absolute(point, geometry, mask));
  }
  const last = action.path[action.path.length - 1];
  if (last === undefined) throw new RangeError("Drag path is invalid.");
  operations.push(absolute(last, geometry, 0));
}

function appendScroll(
  operations: ExpandedMouseOperation[],
  action: Extract<MouseAction, { readonly type: "scroll" }>,
  geometry: CapturedContentGeometry,
): void {
  if (action.delta_x !== undefined && action.delta_x !== 0) {
    throw new RangeError("Horizontal scroll is unsupported.");
  }
  if (
    !Number.isSafeInteger(action.delta_y) ||
    action.delta_y < -127 ||
    action.delta_y > 127 ||
    action.delta_y === 0
  ) {
    throw new RangeError(
      "Vertical scroll must be a nonzero integer from -127 to 127.",
    );
  }
  operations.push(absolute({ x: action.x, y: action.y }, geometry, 0));
  operations.push({ kind: "wheel", delta_y: action.delta_y });
}

export function expandMouseActions(
  actions: readonly MouseAction[],
  geometry: CapturedContentGeometry,
): ExpandedMouseActions {
  assertGeometry(geometry);
  if (
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > MAX_MOUSE_ACTIONS
  ) {
    throw new RangeError("Mouse request must contain 1 through 16 actions.");
  }
  const operations: ExpandedMouseOperation[] = [];
  const actionOperationEnds: number[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "move":
        operations.push(absolute(action, geometry, 0));
        break;
      case "click":
      case "double_click":
        appendClick(operations, action, geometry);
        break;
      case "drag":
        appendDrag(operations, action, geometry);
        break;
      case "scroll":
        appendScroll(operations, action, geometry);
        break;
      default:
        throw new RangeError("Mouse action is invalid.");
    }
    actionOperationEnds.push(operations.length);
  }
  return { operations, actionOperationEnds };
}
