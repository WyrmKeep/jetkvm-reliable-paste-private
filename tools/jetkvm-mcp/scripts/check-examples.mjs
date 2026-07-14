import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examples = resolve(packageRoot, "examples");

export function runExampleCommand(
  command,
  args,
  { env = process.env, input = "" } = {},
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(
        new Error(
          `Example command failed (${signal ?? `exit ${String(code)}`}): ${stderr}`,
        ),
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function checkClientConfig() {
  const config = JSON.parse(
    await readFile(resolve(examples, "claude-desktop.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(config.mcpServers), ["jetkvm"]);
  const operatorConfig = JSON.parse(
    await readFile(resolve(examples, "operator-config.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(operatorConfig).sort(), [
    "credentialFile",
    "targetUrl",
  ]);
  assert.match(operatorConfig.targetUrl, /^https:\/\//u);
  assert.equal(operatorConfig.credentialFile.startsWith("/"), true);
  assert.equal(
    JSON.stringify(operatorConfig).toLowerCase().includes("secret"),
    false,
  );
  const server = config.mcpServers.jetkvm;
  assert.equal(server.command, "jetkvm-mcp");
  assert.deepEqual(server.args, []);
  assert.deepEqual(Object.keys(server.env).sort(), [
    "JETKVM_CREDENTIAL_FILE",
    "JETKVM_TARGET_URL",
  ]);
  assert.match(server.env.JETKVM_TARGET_URL, /^https:\/\//u);
  assert.equal(server.env.JETKVM_CREDENTIAL_FILE.startsWith("/"), true);
  assert.equal(JSON.stringify(server).toLowerCase().includes("secret"), false);
}

async function checkShellExamples() {
  const createCredential = resolve(examples, "create-credential-file.sh");
  const runStdio = resolve(examples, "run-stdio.sh");
  await runExampleCommand("bash", ["-n", createCredential]);
  await runExampleCommand("sh", ["-n", runStdio]);

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "jetkvm-examples-"));
  try {
    const credentialPath = resolve(temporaryRoot, "config", "credential");
    await runExampleCommand(createCredential, [credentialPath], {
      env: { ...process.env, JETKVM_EXAMPLE_CREDENTIAL_STDIN: "1" },
      input: "example-validation-credential\n",
    });
    const credentialStat = await stat(credentialPath);
    assert.equal(credentialStat.isFile(), true);
    assert.equal(credentialStat.mode & 0o777, 0o600);
    assert.equal(
      await readFile(credentialPath, "utf8"),
      "example-validation-credential",
    );

    const resultPath = resolve(temporaryRoot, "launch-result");
    const stub = resolve(temporaryRoot, "jetkvm-mcp-stub");
    await writeFile(
      stub,
      `#!/bin/sh\nset -eu\n[ -z "\${JETKVM_CREDENTIAL+x}" ]\n[ -z "\${JETKVM_CREDENTIAL_ENV+x}" ]\nprintf '%s\\n%s\\n' "$JETKVM_TARGET_URL" "$JETKVM_CREDENTIAL_FILE" >"$JETKVM_EXAMPLE_RESULT"\n`,
      "utf8",
    );
    await chmod(stub, 0o700);
    await runExampleCommand(runStdio, [], {
      env: {
        ...process.env,
        JETKVM_TARGET_URL: "https://jetkvm.example",
        JETKVM_CREDENTIAL_FILE: credentialPath,
        JETKVM_CREDENTIAL: "must-be-removed",
        JETKVM_CREDENTIAL_ENV: "must-be-removed",
        JETKVM_MCP_COMMAND: stub,
        JETKVM_EXAMPLE_RESULT: resultPath,
      },
    });
    assert.equal(
      await readFile(resultPath, "utf8"),
      `https://jetkvm.example\n${credentialPath}\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await checkClientConfig();
  await checkShellExamples();
  process.stdout.write("Executable examples verified.\n");
}
