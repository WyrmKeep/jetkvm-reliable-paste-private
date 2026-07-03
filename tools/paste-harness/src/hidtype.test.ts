import { describe, expect, test } from "vitest";

import {
  buildHidtypeRemoteCommand,
  buildSaveChordCommand,
  parseHidtypeStats,
} from "./hidtype.js";

describe("hidtype raw injector helpers", () => {
  test("builds an explicit UK hidtype command with clear enabled by default", () => {
    expect(buildHidtypeRemoteCommand()).toBe(
      "'/userdata/hidtype' '-layout' 'uk' '-dev' '/dev/hidg0' '-rate' '91' '-clear'",
    );
  });

  test("builds a US negative-control command without clear when requested", () => {
    expect(
      buildHidtypeRemoteCommand({
        executable: "/userdata/hidtype test",
        device: "/dev/hidg0",
        layout: "us",
        rate: 50,
        clear: false,
      }),
    ).toBe("'/userdata/hidtype test' '-layout' 'us' '-dev' '/dev/hidg0' '-rate' '50'");
  });

  test("builds the Ctrl+S save chord as press then all-zero release", () => {
    expect(buildSaveChordCommand()).toBe(
      "printf '\\001\\000\\026\\000\\000\\000\\000\\000' > '/dev/hidg0'; sleep 0.08; printf '\\000\\000\\000\\000\\000\\000\\000\\000' > '/dev/hidg0'",
    );
  });

  test("parses the final hidtype stats JSON line", () => {
    expect(parseHidtypeStats("noise\n{\"charsTyped\":12,\"writes\":28,\"skipped\":0}\n")).toEqual({
      charsTyped: 12,
      writes: 28,
      skipped: 0,
    });
  });
});
