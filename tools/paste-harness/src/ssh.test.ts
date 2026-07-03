import { Buffer } from "node:buffer";

import { describe, expect, test } from "vitest";

import {
  buildScpArgs,
  buildSshArgs,
  encodePowerShellCommand,
  parseRigEnvText,
  redactRigSecrets,
  SSH_BASE_ARGS,
  stripPowerShellNoise,
} from "./ssh.js";

describe("shared SSH wrapper", () => {
  test("uses the mandated flags for every SSH and SCP invocation", () => {
    expect(SSH_BASE_ARGS).toEqual([
      "-F",
      "/dev/null",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
    ]);

    expect(buildSshArgs("root@192.168.1.155", "echo ok")).toEqual([
      ...SSH_BASE_ARGS,
      "root@192.168.1.155",
      "echo ok",
    ]);
    expect(buildScpArgs("local.txt", "root@192.168.1.110:/tmp/local.txt")).toEqual([
      ...SSH_BASE_ARGS,
      "local.txt",
      "root@192.168.1.110:/tmp/local.txt",
    ]);
  });

  test("parses rig env files without requiring values in argv or logs", () => {
    const env = parseRigEnvText(`
# ignored
JETKVM_PASSWORD='super secret'
KVM_PRIMARY=192.168.1.110
WIN_RECV="C:\\Users\\Robert\\Documents\\recv.txt"
`);

    expect(env.JETKVM_PASSWORD).toBe("super secret");
    expect(env.KVM_PRIMARY).toBe("192.168.1.110");
    expect(env.WIN_RECV).toBe("C:\\Users\\Robert\\Documents\\recv.txt");
    expect(redactRigSecrets("password=super secret host=192.168.1.110", env)).toBe(
      "password=<redacted> host=192.168.1.110",
    );
  });

  test("encodes PowerShell commands as UTF-16LE EncodedCommand payloads", () => {
    const script = "Write-Output $env:Path";
    expect(encodePowerShellCommand(script)).toBe(Buffer.from(script, "utf16le").toString("base64"));
  });

  test("strips OpenSSH warnings and PowerShell CLIXML noise", () => {
    const noisy = [
      "Warning: Permanently added '192.168.1.155' (ED25519) to the list of known hosts.",
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '<S S="progress">noise</S>',
      "</Objs>",
      '{"ok":true,"title":"recv.txt - Notepad"}',
      "",
    ].join("\n");

    expect(stripPowerShellNoise(noisy)).toBe('{"ok":true,"title":"recv.txt - Notepad"}');
  });
});
