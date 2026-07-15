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
      const commandsCapture = join(directory, "commands.txt");
      const fakeSsh = join(directory, "ssh");
      const fakeScp = join(directory, "scp");
      const previousPath = process.env.PATH;
      const previousCapture = process.env.SCP_CAPTURE;
      const previousDestination = process.env.SCP_DESTINATION;
      const previousCommands = process.env.SSH_COMMANDS;
      try {
        await writeFile(
          fakeSsh,
          [
            "#!/bin/sh",
            'for argument in "$@"; do command="$argument"; done',
            'printf "%s\\n" "$command" >> "$SSH_COMMANDS"',
            "",
          ].join("\n"),
          "utf8",
        );
        await writeFile(
          fakeScp,
          [
            "#!/bin/sh",
            'for argument in "$@"; do',
            '  source="$destination"',
            '  destination="$argument"',
            "done",
            'cat "$source" > "$SCP_CAPTURE"',
            'printf %s "$destination" > "$SCP_DESTINATION"',
            "",
          ].join("\n"),
          "utf8",
        );
        await chmod(fakeSsh, 0o755);
        await chmod(fakeScp, 0o755);
        process.env.PATH = `${directory}:${previousPath}`;
        process.env.SCP_CAPTURE = capture;
        process.env.SCP_DESTINATION = destinationCapture;
        process.env.SSH_COMMANDS = commandsCapture;

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
        expect(await readFile(destinationCapture, "utf8")).toMatch(
          /^root@fixture\.invalid:C:\/Users\/Robert\/paste-rig\/common\.ps1\.jetkvm-upload-[0-9a-f-]+\.tmp$/,
        );
        const commands = (await readFile(commandsCapture, "utf8"))
          .trim()
          .split("\n");
        expect(commands).toHaveLength(2);
        const encodedInstallScript = commands.at(-1)?.split(/\s+/).at(-1);
        expect(encodedInstallScript).toBeTruthy();
        const installScript = Buffer.from(
          encodedInstallScript ?? "",
          "base64",
        ).toString("utf16le");
        expect(installScript).toContain("[System.IO.File]::Replace");
        expect(installScript).toContain("[System.IO.File]::Move");
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
        if (previousCommands === undefined) {
          delete process.env.SSH_COMMANDS;
        } else {
          process.env.SSH_COMMANDS = previousCommands;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.sequential(
    "preserves the installed Windows file when SCP fails mid-transfer",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "jetkvm-scp-atomic-"));
      const remoteFinal = join(directory, "remote-final.ps1");
      const remoteStaging = join(directory, "remote-staging.ps1");
      const fakeSsh = join(directory, "ssh");
      const fakeScp = join(directory, "scp");
      const previousPath = process.env.PATH;
      const previousFinal = process.env.SCP_REMOTE_FINAL;
      const previousStaging = process.env.SCP_REMOTE_STAGING;
      try {
        await writeFile(remoteFinal, "installed-safe-version", "utf8");
        await writeFile(
          fakeSsh,
          '#!/bin/sh\nrm -f "$SCP_REMOTE_STAGING"\n',
          "utf8",
        );
        await writeFile(
          fakeScp,
          [
            "#!/bin/sh",
            'output="$SCP_REMOTE_FINAL"',
            'for argument in "$@"; do',
            '  case "$argument" in',
            '    *.jetkvm-upload-*.tmp) output="$SCP_REMOTE_STAGING" ;;',
            "  esac",
            "done",
            'printf %s "partial-transfer" > "$output"',
            "exit 7",
            "",
          ].join("\n"),
          "utf8",
        );
        await chmod(fakeSsh, 0o755);
        await chmod(fakeScp, 0o755);
        process.env.PATH = `${directory}:${previousPath}`;
        process.env.SCP_REMOTE_FINAL = remoteFinal;
        process.env.SCP_REMOTE_STAGING = remoteStaging;

        await expect(
          uploadWindowsTextFile(
            "root@fixture.invalid",
            "C:\\Users\\Robert\\paste-rig\\scheduled-task.ps1",
            "replacement-version",
            5_000,
          ),
        ).rejects.toThrow(/failed to upload/);

        expect(await readFile(remoteFinal, "utf8")).toBe(
          "installed-safe-version",
        );
        await expect(readFile(remoteStaging)).rejects.toThrow();
      } finally {
        process.env.PATH = previousPath;
        if (previousFinal === undefined) {
          delete process.env.SCP_REMOTE_FINAL;
        } else {
          process.env.SCP_REMOTE_FINAL = previousFinal;
        }
        if (previousStaging === undefined) {
          delete process.env.SCP_REMOTE_STAGING;
        } else {
          process.env.SCP_REMOTE_STAGING = previousStaging;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.sequential(
    "shares one timeout budget across preparation and SCP",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "jetkvm-scp-deadline-"));
      const fakeSsh = join(directory, "ssh");
      const fakeScp = join(directory, "scp");
      const previousPath = process.env.PATH;
      try {
        await writeFile(fakeSsh, "#!/bin/sh\nsleep 1\n", "utf8");
        await writeFile(fakeScp, "#!/bin/sh\nsleep 1\n", "utf8");
        await chmod(fakeSsh, 0o755);
        await chmod(fakeScp, 0o755);
        process.env.PATH = `${directory}:${previousPath}`;
        const startedAt = Date.now();

        await expect(
          uploadWindowsTextFile(
            "root@fixture.invalid",
            "C:\\Users\\Robert\\paste-rig\\deadline.ps1",
            "replacement-version",
            1_500,
          ),
        ).rejects.toThrow(/failed to upload .*timed out/);
        expect(Date.now() - startedAt).toBeLessThan(3_000);
      } finally {
        process.env.PATH = previousPath;
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
