import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseOperatorConfig } from "./config.js";
import { JETKVM_TOOL_NAMES } from "./domain.js";
import { createProductionRuntime } from "./runtime.js";

async function withCredentialFile<T>(operation: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-runtime-test-"));
  const path = join(directory, "credential");
  try {
    await writeFile(path, "test-only-password\n", { mode: 0o600 });
    await chmod(directory, 0o700);
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("production runtime", () => {
  it("assembles all handlers over one browser-owned device adapter without launching", async () => {
    await withCredentialFile(async (credentialFile) => {
      const config = parseOperatorConfig({
        targetUrl: "https://jetkvm.test",
        credentialFile,
      });
      const runtime = createProductionRuntime(config);
      expect(Object.keys(runtime.handlers).sort()).toEqual(
        [...JETKVM_TOOL_NAMES].sort(),
      );
      expect(runtime.browser.deviceRpc).toBe(runtime.native.deviceRpc);
      await runtime.close();
      await runtime.close();
    });
  });
});
