import { describe, expect, it } from "vitest";

import type { MouseAction } from "../domain.js";
import {
  expandMouseActions,
  mapImagePointToAbsolute,
  type ExpandedMouseOperation,
} from "./geometry.js";

const geometry = {
  imageWidth: 1280,
  imageHeight: 720,
  contentX: 100,
  contentY: 50,
  contentWidth: 1080,
  contentHeight: 620,
};

describe("mapImagePointToAbsolute", () => {
  it("maps the immutable content rectangle endpoints to the complete HID range", () => {
    expect(mapImagePointToAbsolute({ x: 100, y: 50 }, geometry)).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapImagePointToAbsolute({ x: 1179, y: 669 }, geometry)).toEqual({
      x: 32_767,
      y: 32_767,
    });
    expect(mapImagePointToAbsolute({ x: 640, y: 360 }, geometry)).toEqual({
      x: 16_399,
      y: 16_410,
    });
  });

  it.each([
    { x: 99, y: 50 },
    { x: 1180, y: 50 },
    { x: 100, y: 49 },
    { x: 100, y: 670 },
    { x: 100.5, y: 50 },
    { x: 100, y: Number.NaN },
  ])("rejects a coordinate outside exact captured content: %o", (point) => {
    expect(() => mapImagePointToAbsolute(point, geometry)).toThrow(
      /coordinate/i,
    );
  });
});

describe("expandMouseActions", () => {
  it("expands every canonical mouse action into absolute and wheel reports", () => {
    const actions: MouseAction[] = [
      { type: "move", x: 100, y: 50 },
      { type: "click", x: 1179, y: 669, button: "left" },
      { type: "double_click", x: 100, y: 50, button: "right" },
      {
        type: "drag",
        button: "middle",
        path: [
          { x: 100, y: 50 },
          { x: 640, y: 360 },
          { x: 1179, y: 669 },
        ],
      },
      { type: "scroll", x: 640, y: 360, delta_y: -127, delta_x: 0 },
    ];

    const expanded = expandMouseActions(actions, geometry);
    expect(expanded.actionOperationEnds).toEqual([1, 4, 9, 14, 16]);
    expect(expanded.operations).toEqual<ExpandedMouseOperation[]>([
      { kind: "absolute", x: 0, y: 0, buttons: 0 },
      { kind: "absolute", x: 32_767, y: 32_767, buttons: 0 },
      { kind: "absolute", x: 32_767, y: 32_767, buttons: 1 },
      { kind: "absolute", x: 32_767, y: 32_767, buttons: 0 },
      { kind: "absolute", x: 0, y: 0, buttons: 0 },
      { kind: "absolute", x: 0, y: 0, buttons: 2 },
      { kind: "absolute", x: 0, y: 0, buttons: 0 },
      { kind: "absolute", x: 0, y: 0, buttons: 2 },
      { kind: "absolute", x: 0, y: 0, buttons: 0 },
      { kind: "absolute", x: 0, y: 0, buttons: 0 },
      { kind: "absolute", x: 0, y: 0, buttons: 4 },
      { kind: "absolute", x: 16_399, y: 16_410, buttons: 4 },
      { kind: "absolute", x: 32_767, y: 32_767, buttons: 4 },
      { kind: "absolute", x: 32_767, y: 32_767, buttons: 0 },
      { kind: "absolute", x: 16_399, y: 16_410, buttons: 0 },
      { kind: "wheel", delta_y: -127 },
    ]);
  });

  it.each([-127, -1, 1, 127])(
    "accepts the complete nonzero signed wheel boundary %i",
    (deltaY) => {
      const result = expandMouseActions(
        [{ type: "scroll", x: 100, y: 50, delta_y: deltaY }],
        geometry,
      );
      expect(result.operations.at(-1)).toEqual({
        kind: "wheel",
        delta_y: deltaY,
      });
    },
  );

  it.each([0, -128, 128, 1.5, Number.NaN])(
    "rejects invalid vertical wheel delta %s before expansion",
    (deltaY) => {
      expect(() =>
        expandMouseActions(
          [{ type: "scroll", x: 100, y: 50, delta_y: deltaY }],
          geometry,
        ),
      ).toThrow(/scroll/i);
    },
  );

  it("rejects nonzero horizontal scrolling and malformed drag paths", () => {
    expect(() =>
      expandMouseActions(
        [
          {
            type: "scroll",
            x: 100,
            y: 50,
            delta_y: 1,
            delta_x: 1 as 0,
          },
        ],
        geometry,
      ),
    ).toThrow(/horizontal/i);
    expect(() =>
      expandMouseActions(
        [{ type: "drag", button: "left", path: [{ x: 100, y: 50 }] }],
        geometry,
      ),
    ).toThrow(/drag/i);
  });
});
