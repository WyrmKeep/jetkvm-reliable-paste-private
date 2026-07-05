import { describe, expect, test } from "vitest";

import {
  compareNormalizedText,
  decodeUtf8Text,
  normalizeText,
  toCodePoints,
} from "./normalize.js";

describe("normalize module", () => {
  test("decodes UTF-8 while tolerating a BOM", () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x4c, 0x30, 0x30, 0x30, 0x31]);

    expect(decodeUtf8Text(bytes)).toBe("L0001");
  });

  test("normalizes CRLF to LF and trims only trailing LF newlines", () => {
    expect(normalizeText("L0001 alpha\r\nL0002 beta\r\n")).toBe("L0001 alpha\nL0002 beta");
    expect(normalizeText("L0001 alpha\n\n")).toBe("L0001 alpha");
    expect(normalizeText("L0001 alpha\r")).toBe("L0001 alpha\r");
  });

  test("compares at codepoint level including pound sterling", () => {
    const result = compareNormalizedText("L0001 cost £5\n", "L0001 cost £5\r\n");

    expect(result.equal).toBe(true);
    expect(result.expectedCodePoints).toEqual(toCodePoints("L0001 cost £5"));
    expect(result.actualCodePoints).toEqual(toCodePoints("L0001 cost £5"));
  });
});
