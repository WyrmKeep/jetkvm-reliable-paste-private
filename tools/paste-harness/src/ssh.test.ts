import { Buffer } from "node:buffer";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildScpArgs,
  buildSshArgs,
  encodePowerShellCommand,
  parseRigEnvText,
  redactRigSecrets,
  runSshCommand,
  uploadWindowsTextFile,
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
      "LogLevel=ERROR",
      "-o",
      "BatchMode=yes",
    ]);

    expect(buildSshArgs("root@192.168.1.155", "echo ok")).toEqual([
      ...SSH_BASE_ARGS,
      "root@192.168.1.155",
      "echo ok",
    ]);
    expect(
      buildScpArgs("local.txt", "root@192.168.1.110:/tmp/local.txt"),
    ).toEqual([
      ...SSH_BASE_ARGS,
      "local.txt",
      "root@192.168.1.110:/tmp/local.txt",
    ]);
  });

  test.sequential("streams file input through SSH stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jetkvm-ssh-stream-"));
    const source = join(directory, "source.bin");
    const capture = join(directory, "capture.bin");
    const fakeSsh = join(directory, "ssh");
    const previousPath = process.env.PATH;
    const previousCapture = process.env.SSH_CAPTURE;
    try {
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
      await writeFile(source, payload);
      await writeFile(fakeSsh, '#!/bin/sh\ncat > "$SSH_CAPTURE"\n', "utf8");
      await chmod(fakeSsh, 0o755);
      process.env.PATH = `${directory}:${previousPath}`;
      process.env.SSH_CAPTURE = capture;

      const result = await runSshCommand("root@fixture.invalid", "cat", {
        inputFile: source,
        timeoutMs: 5_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(await readFile(capture)).toEqual(payload);
    } finally {
      process.env.PATH = previousPath;
      if (previousCapture === undefined) {
        delete process.env.SSH_CAPTURE;
      } else {
        process.env.SSH_CAPTURE = previousCapture;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.sequential(
    "uploads Windows fixture text through SCP instead of remote stdin",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "jetkvm-scp-upload-"));
      const capture = join(directory, "capture.bin");
      const destinationCapture = join(directory, "destination.txt");
      const fakeSsh = join(directory, "ssh");
      const fakeScp = join(directory, "scp");
      const previousPath = process.env.PATH;
      const previousCapture = process.env.SCP_CAPTURE;
      const previousDestination = process.env.SCP_DESTINATION;
      try {
        await writeFile(fakeSsh, "#!/bin/sh\ncat >/dev/null\n", "utf8");
        await writeFile(
          fakeScp,
          '#!/bin/sh\ncat "${13}" > "$SCP_CAPTURE"\nprintf %s "${14}" > "$SCP_DESTINATION"\n',
          "utf8",
        );
        await chmod(fakeSsh, 0o755);
        await chmod(fakeScp, 0o755);
        process.env.PATH = `${directory}:${previousPath}`;
        process.env.SCP_CAPTURE = capture;
        process.env.SCP_DESTINATION = destinationCapture;

        const content = "Write-Output 'fixture ready'\n";
        await uploadWindowsTextFile(
          "root@fixture.invalid",
          "C:\\Users\\Robert\\paste-rig\\common.ps1",
          content,
          5_000,
        );

        const captureExists = await readFile(capture).then(
          () => true,
          () => false,
        );
        expect(captureExists).toBe(true);
        expect(await readFile(capture, "utf8")).toBe(content);
        expect(await readFile(destinationCapture, "utf8")).toBe(
          "root@fixture.invalid:C:/Users/Robert/paste-rig/common.ps1",
        );
      } finally {
        process.env.PATH = previousPath;
        if (previousCapture === undefined) {
          delete process.env.SCP_CAPTURE;
        } else {
          process.env.SCP_CAPTURE = previousCapture;
        }
        if (previousDestination === undefined) {
          delete process.env.SCP_DESTINATION;
        } else {
          process.env.SCP_DESTINATION = previousDestination;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
    expect(
      redactRigSecrets("password=super secret host=192.168.1.110", env),
    ).toBe("password=<redacted> host=192.168.1.110");
  });

  test("encodes PowerShell commands as UTF-16LE EncodedCommand payloads", () => {
    const script = "Write-Output $env:Path";
    expect(encodePowerShellCommand(script)).toBe(
      Buffer.from(script, "utf16le").toString("base64"),
    );
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

    expect(stripPowerShellNoise(noisy)).toBe(
      '{"ok":true,"title":"recv.txt - Notepad"}',
    );
  });
});
