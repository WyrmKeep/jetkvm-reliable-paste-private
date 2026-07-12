import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLeaseChildEnvironment } from "./deviceLeaseRunner.js";

const wrapperPath = fileURLToPath(
  new URL("../scripts/with-device-lease.mjs", import.meta.url),
);

type ProcessResult = { code: number | null; stdout: string; stderr: string };

async function runWrapper(
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const child = spawn(process.execPath, [wrapperPath, ...args], {
    env: { ...process.env, ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = Promise.withResolvers<number | null>();
  child.once("error", (error) => completion.reject(error));
  child.once("close", (code) => completion.resolve(code));
  return { code: await completion.promise, stdout, stderr };
}

describe("device lease runner", () => {
  it("passes only a protected proof reference and scrubs raw proof variables", () => {
    const environment = buildLeaseChildEnvironment(
      {
        SAFE_VALUE: "kept",
        JETKVM_DEVICE_LEASE_TOKEN: "must-not-survive",
        JETKVM_DEVICE_LEASE_OWNER: "must-not-survive",
      },
      "/private/proof.json",
    );

    expect(environment).toEqual({
      SAFE_VALUE: "kept",
      JETKVM_DEVICE_LEASE_PROOF_PATH: "/private/proof.json",
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-survive");
  });

  it("keeps raw proof material out of child env and wrapper output", async () => {
    const childScript =
      'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.includes("DEVICE_LEASE")))))';
    const result = await runWrapper([
      "--device-key",
      "env-scan-device",
      "--",
      process.execPath,
      "-e",
      childScript,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("JETKVM_DEVICE_LEASE_PROOF_PATH");
    expect(result.stdout).not.toContain("TOKEN");
    expect(result.stdout).not.toContain("OWNER");
    expect(result.stderr).not.toMatch(/[a-f0-9]{64}/i);
  });

  it("supports nested inheritance through the protected proof reference", async () => {
    const result = await runWrapper([
      "--device-key",
      "nested-device",
      "--",
      process.execPath,
      wrapperPath,
      "--device-key",
      "nested-device",
      "--",
      process.execPath,
      "--version",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim()).toBe(process.version);
  });

  it("fails closed for invalid or partial inherited proof references without echoing them", async () => {
    const invalidReference = "/definitely/not/a/device-lease-proof";
    const invalid = await runWrapper(
      ["--device-key", "device-a", "--", process.execPath, "--version"],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: invalidReference },
    );
    expect(invalid.code).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
      invalidReference,
    );

    const empty = await runWrapper(
      ["--device-key", "device-a", "--", process.execPath, "--version"],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: "" },
    );
    expect(empty.code).not.toBe(0);

    const partial = await runWrapper(
      ["--device-key", "device-a", "--", process.execPath, "--version"],
      { JETKVM_DEVICE_LEASE_TOKEN: "raw-token-without-reference" },
    );
    expect(partial.code).not.toBe(0);
    expect(`${partial.stdout}${partial.stderr}`).not.toContain(
      "raw-token-without-reference",
    );
  });
});
