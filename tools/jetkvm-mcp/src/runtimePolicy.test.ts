import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion } from "./runtimePolicy.js";

describe("Node runtime policy", () => {
  it("rejects the patch immediately below the supported floor", () => {
    expect(() => assertSupportedNodeVersion("22.23.0")).toThrowError(
      "Unsupported Node.js 22.23.0; expected >=22.23.1 <23",
    );
  });

  it("accepts the exact repository baseline", () => {
    expect(assertSupportedNodeVersion("22.23.1")).toBe("22.23.1");
  });

  it("accepts later Node 22 security releases", () => {
    expect(assertSupportedNodeVersion("22.99.7")).toBe("22.99.7");
  });

  it("rejects the next major", () => {
    expect(() => assertSupportedNodeVersion("23.0.0")).toThrowError(
      "Unsupported Node.js 23.0.0; expected >=22.23.1 <23",
    );
  });

  it("fails closed on malformed versions", () => {
    expect(() => assertSupportedNodeVersion("v22.23.1")).toThrowError(
      "Unsupported Node.js v22.23.1; expected >=22.23.1 <23",
    );
  });
});
