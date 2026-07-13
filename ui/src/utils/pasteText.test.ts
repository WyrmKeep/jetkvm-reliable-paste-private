import { describe, expect, it } from "vitest";

import { normalizePasteText } from "./pasteText";

describe("normalizePasteText", () => {
  it("strips exactly one leading UTF-8 BOM", () => {
    expect(normalizePasteText("\uFEFF\uFEFFvalue")).toBe("\uFEFFvalue");
    expect(normalizePasteText("value\uFEFF")).toBe("value\uFEFF");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizePasteText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("normalizes Unicode to NFC after line ending conversion", () => {
    expect(normalizePasteText("Cafe\u0301\r\n")).toBe("Caf\u00e9\n");
  });

  it("does not retain prior text between calls", () => {
    expect(normalizePasteText("first-secret")).toBe("first-secret");
    expect(normalizePasteText("second")).toBe("second");
  });
});
