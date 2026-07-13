import { mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseOperatorConfig } from "../config.js";
import type { SecretByteAllocator } from "./auth.js";
import {
  activateIndependentLegacySseBearerCredential,
  CREDENTIAL_MAX_BYTES,
  CredentialConfigurationError,
  DisposableSecret,
  HttpBoundaryError,
  evaluateLegacySseRequest,
  loadCredentialSecret,
  selectCredentialSource,
  validateCredentialFileMetadata,
} from "./auth.js";

const protectedCredentialReadHooks = vi.hoisted(() => ({
  afterOpen: undefined as (() => void) | undefined,
  beforeRead: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("node:fs");
  const actualReadSync = actual["readSync"];
  const actualOpenSync = actual["openSync"];
  if (typeof actualReadSync !== "function") {
    throw new Error("node:fs readSync is unavailable");
  }
  if (typeof actualOpenSync !== "function") {
    throw new Error("node:fs openSync is unavailable");
  }
  return {
    ...actual,
    openSync(path: string, flags: number, mode?: number): number {
      const descriptor = Reflect.apply(actualOpenSync, actual, [
        path,
        flags,
        mode,
      ]) as number;
      protectedCredentialReadHooks.afterOpen?.();
      return descriptor;
    },
    readSync(
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | bigint | null,
    ): number {
      protectedCredentialReadHooks.beforeRead?.();
      return Reflect.apply(actualReadSync, actual, [
        descriptor,
        buffer,
        offset,
        length,
        position,
      ]) as number;
    },
  };
});

const EXPECTED_CREDENTIAL_MAX_BYTES = 4_096;

describe("credential source selection", () => {
  it("keeps the documented credential cap fixed at 4096 bytes", () => {
    expect(CREDENTIAL_MAX_BYTES).toBe(EXPECTED_CREDENTIAL_MAX_BYTES);
  });

  it("uses the CLI file location ahead of the environment file location", () => {
    expect(
      selectCredentialSource({
        cliFilePath: "/cli/credential",
        environmentFilePath: "/env/credential",
        environmentVariable: "JETKVM_CREDENTIAL",
      }),
    ).toEqual({
      environmentVariable: "JETKVM_CREDENTIAL",
      filePath: "/cli/credential",
    });
  });

  it("uses the named environment source when no file is configured", () => {
    expect(
      selectCredentialSource({ environmentVariable: "CUSTOM_DEVICE_SECRET" }),
    ).toEqual({ environmentVariable: "CUSTOM_DEVICE_SECRET" });
  });

  it("rejects invalid environment-variable names and empty paths", () => {
    expect(() =>
      selectCredentialSource({ environmentVariable: "bad-name" }),
    ).toThrowError(CredentialConfigurationError);
    expect(() => selectCredentialSource({ cliFilePath: "" })).toThrowError(
      CredentialConfigurationError,
    );
  });

  it("fails closed when environment and file secrets are both configured", () => {
    const access = {
      readEnvironment: vi.fn(() => "environment-secret"),
      deleteEnvironment: vi.fn(),
      readProtectedFile: vi.fn(() => Buffer.from("file-secret")),
    };

    expect(() =>
      loadCredentialSecret(
        {
          environmentVariable: "JETKVM_CREDENTIAL",
          filePath: "/run/secrets/jetkvm",
        },
        access,
      ),
    ).toThrowError("Conflicting credential sources");
    expect(access.readProtectedFile).not.toHaveBeenCalled();
    expect(access.deleteEnvironment).not.toHaveBeenCalled();
  });

  it("copies then removes the environment secret source", () => {
    const access = {
      readEnvironment: vi.fn(() => "environment-secret"),
      deleteEnvironment: vi.fn(),
      readProtectedFile: vi.fn(),
    };

    const secret = loadCredentialSecret(
      { environmentVariable: "JETKVM_CREDENTIAL" },
      access,
    );
    expect(secret.useUtf8((value) => value)).toBe("environment-secret");
    expect(access.deleteEnvironment).toHaveBeenCalledWith("JETKVM_CREDENTIAL");
    expect(access.readProtectedFile).not.toHaveBeenCalled();
    secret.dispose();
  });

  it("zeroes the environment allocation when clearing its source fails", () => {
    const sentinel = "PRIVATE_ENVIRONMENT_DELETE_FAILURE_SENTINEL";
    const allocations: Uint8Array[] = [];
    const originalEncode = TextEncoder.prototype.encode;
    const encodeSpy = vi
      .spyOn(TextEncoder.prototype, "encode")
      .mockImplementation(function (
        this: TextEncoder,
        value?: string,
      ): Uint8Array<ArrayBuffer> {
        const bytes = originalEncode.call(
          this,
          value,
        ) as Uint8Array<ArrayBuffer>;
        allocations.push(bytes);
        return bytes;
      });
    let caught: unknown;

    try {
      loadCredentialSecret(
        { environmentVariable: "JETKVM_CREDENTIAL" },
        {
          readEnvironment: () => "environment-secret",
          deleteEnvironment: () => {
            throw new Error(sentinel);
          },
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      encodeSpy.mockRestore();
    }

    expect(caught).toBeInstanceOf(CredentialConfigurationError);
    expect((caught as Error).message).toBe(
      "Credential environment source could not be cleared",
    );
    expect((caught as Error).message).not.toContain(sentinel);
    expect(allocations).toHaveLength(1);
    expect([...allocations[0]!]).toEqual(
      new Array(allocations[0]!.byteLength).fill(0),
    );
  });

  it("accepts an environment credential at the fixed UTF-8 byte cap", () => {
    const value = "é".repeat(EXPECTED_CREDENTIAL_MAX_BYTES / 2);
    const secret = loadCredentialSecret(
      { environmentVariable: "JETKVM_CREDENTIAL" },
      {
        readEnvironment: () => value,
        deleteEnvironment: () => undefined,
      },
    );

    expect(secret.useUtf8((candidate) => candidate)).toBe(value);
    secret.dispose();
  });

  it("rejects an environment credential one UTF-8 byte over the cap without echoing it", () => {
    const sentinel = "PRIVATE_OVERSIZED_ENVIRONMENT_CREDENTIAL_SENTINEL";
    const value = `${sentinel.padEnd(EXPECTED_CREDENTIAL_MAX_BYTES, "x")}x`;
    let unexpectedSecret: DisposableSecret | undefined;
    let caught: unknown;

    try {
      unexpectedSecret = loadCredentialSecret(
        { environmentVariable: "JETKVM_CREDENTIAL" },
        {
          readEnvironment: () => value,
          deleteEnvironment: () => undefined,
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      unexpectedSecret?.dispose();
    }

    expectCredentialSizeError(caught, sentinel);
  });

  it("loads only a current-user regular file with no group/other permission bits", () => {
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-"));
    const path = join(directory, "credential");
    writeFileSync(path, "file-secret\n", { mode: 0o600 });

    const secret = loadCredentialSecret(
      { environmentVariable: "UNSET", filePath: path },
      {
        readEnvironment: () => undefined,
        deleteEnvironment: () => undefined,
      },
    );
    expect(secret.useUtf8((value) => value)).toBe("file-secret");
    secret.dispose();
  });

  it("accepts an owner-only credential file at the fixed byte cap", () => {
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-max-file-"));
    const path = join(directory, "credential");
    writeFileSync(path, Buffer.alloc(EXPECTED_CREDENTIAL_MAX_BYTES, 0x61), {
      mode: 0o600,
    });

    const secret = loadCredentialSecret(
      { environmentVariable: "UNSET", filePath: path },
      {
        readEnvironment: () => undefined,
        deleteEnvironment: () => undefined,
      },
    );
    expect(secret.useBytes((bytes) => bytes.byteLength)).toBe(
      EXPECTED_CREDENTIAL_MAX_BYTES,
    );
    secret.dispose();
  });

  it("rejects an owner-only credential file one byte over the cap with a path-free error", () => {
    const sentinel =
      "Bearer_PRIVATE_BEARER_SENTINEL_PRIVATE_OVERSIZED_FILE_PATH_SENTINEL";
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-max-file-"));
    const path = join(directory, sentinel);
    writeFileSync(path, Buffer.alloc(EXPECTED_CREDENTIAL_MAX_BYTES + 1, 0x61), {
      mode: 0o600,
    });
    let unexpectedSecret: DisposableSecret | undefined;
    let caught: unknown;
    let opened = false;
    let readAttempted = false;
    protectedCredentialReadHooks.afterOpen = () => {
      opened = true;
    };
    protectedCredentialReadHooks.beforeRead = () => {
      readAttempted = true;
    };

    try {
      unexpectedSecret = loadCredentialSecret(
        { environmentVariable: "UNSET", filePath: path },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      unexpectedSecret?.dispose();
      protectedCredentialReadHooks.afterOpen = undefined;
      protectedCredentialReadHooks.beforeRead = undefined;
    }

    expectCredentialSizeError(caught, sentinel);
    expect(opened).toBe(false);
    expect(readAttempted).toBe(false);
  });

  it("rejects growth between lstat and fstat without reading the file", () => {
    const sentinel = "PRIVATE_FSTAT_GROWTH_CREDENTIAL_PATH_SENTINEL";
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-grow-file-"));
    const path = join(directory, sentinel);
    const appendByte = Buffer.from([0x62]);
    writeFileSync(path, Buffer.alloc(EXPECTED_CREDENTIAL_MAX_BYTES, 0x61), {
      mode: 0o600,
    });
    let injected = false;
    let readAttempted = false;
    let caught: unknown;

    protectedCredentialReadHooks.afterOpen = () => {
      injected = true;
      writeFileSync(path, appendByte, { flag: "a" });
    };
    protectedCredentialReadHooks.beforeRead = () => {
      readAttempted = true;
    };
    try {
      loadCredentialSecret(
        { environmentVariable: "UNSET", filePath: path },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      protectedCredentialReadHooks.afterOpen = undefined;
      protectedCredentialReadHooks.beforeRead = undefined;
    }

    expect(injected).toBe(true);
    expect(readAttempted).toBe(false);
    expectCredentialSizeError(caught, sentinel);
  });

  it("rejects a protected file that grows after its opened-file size check", () => {
    const sentinel = "PRIVATE_GROWING_CREDENTIAL_PATH_SENTINEL";
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-grow-file-"));
    const path = join(directory, sentinel);
    writeFileSync(path, Buffer.alloc(EXPECTED_CREDENTIAL_MAX_BYTES, 0x61), {
      mode: 0o600,
    });
    const appendByte = Buffer.from([0x62]);
    let staging: Buffer<ArrayBuffer> | undefined;
    const allocUnsafeSpy = vi
      .spyOn(Buffer, "allocUnsafe")
      .mockImplementationOnce((size) => {
        staging = Buffer.alloc(size, 0x7f);
        return staging;
      });
    let injected = false;
    let caught: unknown;

    protectedCredentialReadHooks.beforeRead = () => {
      if (injected) {
        return;
      }
      injected = true;
      writeFileSync(path, appendByte, { flag: "a" });
    };
    try {
      loadCredentialSecret(
        { environmentVariable: "UNSET", filePath: path },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      protectedCredentialReadHooks.beforeRead = undefined;
      allocUnsafeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expectCredentialSizeError(caught, sentinel);
    expect(staging).toBeDefined();
    expect([...staging!]).toEqual(new Array(staging!.byteLength).fill(0));
  });

  it.each([
    {
      lookup: "absent",
      createPath: () => {
        const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-absent-"));
        return join(
          directory,
          "Bearer_PRIVATE_BEARER_SENTINEL_https%3A%2F%2Fprivate-url-sentinel.invalid_PRIVATE_PASTE_SENTINEL",
        );
      },
    },
    {
      lookup: "inaccessible",
      createPath: () => {
        const directory = mkdtempSync(
          join(tmpdir(), "jetkvm-auth-inaccessible-"),
        );
        const nonDirectory = join(directory, "blocked-parent");
        writeFileSync(nonDirectory, "not a directory", { mode: 0o600 });
        return join(
          nonDirectory,
          "Bearer_PRIVATE_BEARER_SENTINEL_https%3A%2F%2Fprivate-url-sentinel.invalid_PRIVATE_PASTE_SENTINEL",
        );
      },
    },
  ])(
    "uses one sanitized error for an $lookup credential-file metadata lookup",
    ({ createPath }) => {
      const path = createPath();
      expectProtectedCredentialFileLookupError(() =>
        loadCredentialSecret(
          { environmentVariable: "UNSET", filePath: path },
          {
            readEnvironment: () => undefined,
            deleteEnvironment: () => undefined,
          },
        ),
      );
    },
  );

  it("zeroes the exact Buffer returned by the protected file reader", () => {
    const source = Buffer.from("file-secret\r\n");
    const secret = loadCredentialSecret(
      { environmentVariable: "UNSET", filePath: "/protected/credential" },
      {
        readEnvironment: () => undefined,
        deleteEnvironment: () => undefined,
        readProtectedFile: () => source,
      },
    );

    expect(secret.useUtf8((value) => value)).toBe("file-secret");
    expect([...source]).toEqual(new Array(source.byteLength).fill(0));
    secret.dispose();
  });

  it("zeroes an over-cap protected-file buffer on rejection", () => {
    const sentinel = "PRIVATE_OVERSIZED_READER_PATH_SENTINEL";
    const source = Buffer.alloc(EXPECTED_CREDENTIAL_MAX_BYTES + 1, 0x61);
    let unexpectedSecret: DisposableSecret | undefined;
    let caught: unknown;

    try {
      unexpectedSecret = loadCredentialSecret(
        {
          environmentVariable: "UNSET",
          filePath: `/protected/${sentinel}`,
        },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
          readProtectedFile: () => source,
        },
      );
    } catch (error) {
      caught = error;
    } finally {
      unexpectedSecret?.dispose();
    }

    expectCredentialSizeError(caught, sentinel);
    expect([...source]).toEqual(new Array(source.byteLength).fill(0));
  });

  it.each([0o640, 0o604, 0o666])("rejects credential file mode %s", (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-mode-"));
    const path = join(directory, "credential");
    writeFileSync(path, "file-secret", { mode: 0o600 });
    chmodSync(path, mode);

    expect(() =>
      loadCredentialSecret(
        { environmentVariable: "UNSET", filePath: path },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      ),
    ).toThrowError("Credential file permissions are not private");
  });

  it("rejects symbolic-link credential files", () => {
    const directory = mkdtempSync(join(tmpdir(), "jetkvm-auth-link-"));
    const target = join(directory, "target");
    const path = join(directory, "credential");
    writeFileSync(target, "file-secret", { mode: 0o600 });
    symlinkSync(target, path);

    expect(() =>
      loadCredentialSecret(
        { environmentVariable: "UNSET", filePath: path },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      ),
    ).toThrowError("Credential source must be a protected regular file");
  });

  it("rejects a regular private file owned by another user", () => {
    expect(() =>
      validateCredentialFileMetadata(
        { uid: 501, mode: 0o100600, isFile: true, isSymbolicLink: false },
        502,
      ),
    ).toThrowError("Credential file is not owned by the current user");
  });

  it("rejects absent and empty secrets without revealing their source", () => {
    expect(() =>
      loadCredentialSecret(
        { environmentVariable: "UNSET" },
        {
          readEnvironment: () => undefined,
          deleteEnvironment: () => undefined,
        },
      ),
    ).toThrowError("Credential is not available");

    expect(() =>
      loadCredentialSecret(
        { environmentVariable: "SET" },
        {
          readEnvironment: () => "",
          deleteEnvironment: () => undefined,
        },
      ),
    ).toThrowError("Credential is empty");
  });
});

describe("DisposableSecret", () => {
  it("zeroes its storage, is idempotently disposable, and cannot be serialized", () => {
    const secret = DisposableSecret.fromUtf8("do-not-log");
    let retained: Uint8Array | undefined;
    secret.useBytes((bytes) => {
      retained = bytes;
    });

    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(String(secret)).toBe("[REDACTED]");
    secret.dispose();
    secret.dispose();

    expect([...retained!]).toEqual(new Array("do-not-log".length).fill(0));
    expect(secret.disposed).toBe(true);
    expect(() => secret.useUtf8((value) => value)).toThrowError(
      "Secret has been disposed",
    );
  });

  it("zeroes its sole captured UTF-8 allocation after true, false, and error consumers", () => {
    for (const outcome of ["true", "false", "error"] as const) {
      const allocations: Uint8Array[] = [];
      const allocator: SecretByteAllocator = {
        allocateUtf8(value) {
          const bytes = new TextEncoder().encode(value);
          allocations.push(bytes);
          return bytes;
        },
        copyBytes(value) {
          const bytes = Uint8Array.from(value);
          allocations.push(bytes);
          return bytes;
        },
      };
      const secret = DisposableSecret.fromUtf8("sëcret-bytes", allocator);

      try {
        if (outcome === "error") {
          expect(() =>
            secret.useUtf8(() => {
              throw new Error("consumer failed");
            }),
          ).toThrowError("consumer failed");
        } else {
          expect(secret.useUtf8(() => outcome === "true")).toBe(
            outcome === "true",
          );
        }
        expect(allocations).toHaveLength(1);
      } finally {
        secret.dispose();
      }

      expect(allocations).toHaveLength(1);
      expect([...allocations[0]!]).toEqual(
        new Array(allocations[0]!.byteLength).fill(0),
      );
    }
  });

  it("zeroes the captured owned copy without mutating caller-owned input", () => {
    const source = new TextEncoder().encode("caller-owned-secret");
    const expectedSource = [...source];
    const allocations: Uint8Array[] = [];
    const allocator: SecretByteAllocator = {
      allocateUtf8(value) {
        const bytes = new TextEncoder().encode(value);
        allocations.push(bytes);
        return bytes;
      },
      copyBytes(value) {
        const bytes = Uint8Array.from(value);
        allocations.push(bytes);
        return bytes;
      },
    };

    const secret = DisposableSecret.fromBytes(source, allocator);
    expect(secret.useUtf8((value) => value)).toBe("caller-owned-secret");
    secret.dispose();

    expect(source).toEqual(Uint8Array.from(expectedSource));
    expect(allocations).toHaveLength(1);
    expect([...allocations[0]!]).toEqual(
      new Array(allocations[0]!.byteLength).fill(0),
    );
  });

  it("allocates no internal byte storage when construction rejects empty input", () => {
    const allocations: Uint8Array[] = [];
    const allocator: SecretByteAllocator = {
      allocateUtf8(value) {
        const bytes = new TextEncoder().encode(value);
        allocations.push(bytes);
        return bytes;
      },
      copyBytes(value) {
        const bytes = Uint8Array.from(value);
        allocations.push(bytes);
        return bytes;
      },
    };

    expect(() => DisposableSecret.fromUtf8("", allocator)).toThrowError(
      "Credential is empty",
    );
    expect(() =>
      DisposableSecret.fromBytes(new Uint8Array(), allocator),
    ).toThrowError("Credential is empty");
    expect(allocations).toEqual([]);
  });

  it("allocates no secret bytes when construction rejects an over-cap input", () => {
    const allocations: Uint8Array[] = [];
    const allocator: SecretByteAllocator = {
      allocateUtf8(value) {
        const bytes = new TextEncoder().encode(value);
        allocations.push(bytes);
        return bytes;
      },
      copyBytes(value) {
        const bytes = Uint8Array.from(value);
        allocations.push(bytes);
        return bytes;
      },
    };

    expect(() =>
      DisposableSecret.fromUtf8(
        "x".repeat(EXPECTED_CREDENTIAL_MAX_BYTES + 1),
        allocator,
      ),
    ).toThrowError("Credential exceeds maximum size");
    expect(() =>
      DisposableSecret.fromBytes(
        new Uint8Array(EXPECTED_CREDENTIAL_MAX_BYTES + 1),
        allocator,
      ),
    ).toThrowError("Credential exceeds maximum size");
    expect(allocations).toEqual([]);
  });
});

describe("legacy SSE credential activation", () => {
  it("returns only a bearer proven different from the loaded target secret", () => {
    const target = DisposableSecret.fromUtf8("target-only-secret");
    const bearer = {
      principalId: "operator-a",
      secret: DisposableSecret.fromUtf8("sse-only-secret"),
    };

    const activated = activateIndependentLegacySseBearerCredential(
      target,
      bearer,
    );

    expect(activated).not.toBe(bearer);
    expect(activated).toEqual(bearer);
    expect(Object.isFrozen(activated)).toBe(true);
    expect(target.disposed).toBe(false);
    expect(bearer.secret.disposed).toBe(false);
    target.dispose();
    bearer.secret.dispose();
  });

  it("fails with one redacted error and disposes both equal loaded secrets", () => {
    const target = DisposableSecret.fromUtf8("shared-secret-value");
    const bearer = {
      principalId: "operator-a",
      secret: DisposableSecret.fromUtf8("shared-secret-value"),
    };

    expect(() =>
      activateIndependentLegacySseBearerCredential(target, bearer),
    ).toThrowError("Target and legacy SSE credentials must be independent");
    expect(target.disposed).toBe(true);
    expect(bearer.secret.disposed).toBe(true);
  });

  it("disposes every loaded secret when activation cannot compare them", () => {
    const target = DisposableSecret.fromUtf8("target-only-secret");
    const bearer = {
      principalId: "operator-a",
      secret: DisposableSecret.fromUtf8("sse-only-secret"),
    };
    target.dispose();

    expect(() =>
      activateIndependentLegacySseBearerCredential(target, bearer),
    ).toThrowError("Target and legacy SSE credentials must be independent");
    expect(target.disposed).toBe(true);
    expect(bearer.secret.disposed).toBe(true);
  });
});

describe("legacy SSE HTTP security boundary", () => {
  const localConfig = parseOperatorConfig({
    targetUrl: "https://unrelated-device.tail1234.ts.net",
    legacySse: {
      enabled: true,
      hostAuthorities: ["127.0.0.1:9311"],
      allowedOrigins: ["http://127.0.0.1:9311"],
    },
  }).legacySse;

  it.each(["GET", "POST"] as const)(
    "applies the same exact Host/Origin policy to %s independently of the target URL",
    (method) => {
      expect(
        evaluateLegacySseRequest(
          {
            method,
            host: "127.0.0.1:9311",
            origin: "http://127.0.0.1:9311",
          },
          localConfig,
        ),
      ).toEqual({ principalId: "local-operator" });
    },
  );

  it("allows absent Origin on loopback but rejects a mismatched present Origin", () => {
    expect(
      evaluateLegacySseRequest(
        { method: "GET", host: "127.0.0.1:9311" },
        localConfig,
      ),
    ).toEqual({ principalId: "local-operator" });

    expectBoundaryStatus(
      () =>
        evaluateLegacySseRequest(
          {
            method: "GET",
            host: "127.0.0.1:9311",
            origin: "https://attacker.example",
          },
          localConfig,
        ),
      403,
    );
  });

  it("rejects missing or mismatched Host before any transport operation", () => {
    for (const host of [undefined, "127.0.0.1:9312", "attacker.example"]) {
      expectBoundaryStatus(
        () =>
          evaluateLegacySseRequest(
            host === undefined ? { method: "POST" } : { method: "POST", host },
            localConfig,
          ),
        403,
      );
    }
  });

  it.each(["GET", "POST"] as const)(
    "requires bearer, exact Host, exact Origin, and anti-CSRF header for network %s",
    (method) => {
      const policy = parseOperatorConfig({
        targetUrl: "http://192.168.1.20",
        allowInsecureHttp: true,
        allowDangerousTargetHttp: true,
        legacySse: {
          enabled: true,
          bindHost: "0.0.0.0",
          allowNetworkExposure: true,
          hostAuthorities: ["mcp.example.com:9311"],
          allowedOrigins: ["https://operator.example.com"],
          bearerCredentialFile: "/run/secrets/mcp-bearer",
        },
      }).legacySse;
      const bearer = DisposableSecret.fromUtf8("correct-bearer");

      expectBoundaryStatus(
        () =>
          evaluateLegacySseRequest(
            {
              method,
              host: "mcp.example.com:9311",
              origin: "https://operator.example.com",
            },
            policy,
            { principalId: "operator-1", secret: bearer },
          ),
        401,
      );
      expectBoundaryStatus(
        () =>
          evaluateLegacySseRequest(
            {
              method,
              host: "mcp.example.com:9311",
              origin: "https://operator.example.com",
              authorization: "Bearer wrong-bearer",
            },
            policy,
            { principalId: "operator-1", secret: bearer },
          ),
        401,
      );
      expectBoundaryStatus(
        () =>
          evaluateLegacySseRequest(
            {
              method,
              host: "mcp.example.com:9311",
              authorization: "Bearer correct-bearer",
            },
            policy,
            { principalId: "operator-1", secret: bearer },
          ),
        403,
      );
      expectBoundaryStatus(
        () =>
          evaluateLegacySseRequest(
            {
              method,
              host: "mcp.example.com:9311",
              origin: "https://operator.example.com",
              authorization: "Bearer correct-bearer",
            },
            policy,
            { principalId: "operator-1", secret: bearer },
          ),
        403,
      );
      expect(
        evaluateLegacySseRequest(
          {
            method,
            host: "mcp.example.com:9311",
            origin: "https://operator.example.com",
            authorization: "Bearer correct-bearer",
            antiCsrf: "1",
          },
          policy,
          { principalId: "operator-1", secret: bearer },
        ),
      ).toEqual({ principalId: "operator-1" });
      bearer.dispose();
    },
  );

  it("rejects a one-byte-over bearer before parsing or hashing it", () => {
    const sentinel = "PRIVATE_OVERSIZED_REQUEST_BEARER_SENTINEL";
    const candidate = sentinel.padEnd(EXPECTED_CREDENTIAL_MAX_BYTES + 1, "x");
    const bearer = DisposableSecret.fromUtf8("correct-bearer");
    const useBytesSpy = vi.spyOn(bearer, "useBytes");
    const regexpExecSpy = vi.spyOn(RegExp.prototype, "exec");
    let regexpExecCalls = 0;
    let useBytesCalls = 0;
    let caught: unknown;

    try {
      evaluateLegacySseRequest(
        {
          method: "GET",
          host: "127.0.0.1:9311",
          authorization: `Bearer ${candidate}`,
        },
        { ...localConfig, requiresBearer: true },
        { principalId: "operator-1", secret: bearer },
      );
    } catch (error) {
      caught = error;
    } finally {
      regexpExecCalls = regexpExecSpy.mock.calls.length;
      useBytesCalls = useBytesSpy.mock.calls.length;
      regexpExecSpy.mockRestore();
      useBytesSpy.mockRestore();
      bearer.dispose();
    }

    expect(regexpExecCalls).toBe(0);
    expect(useBytesCalls).toBe(0);
    expect(caught).toBeInstanceOf(HttpBoundaryError);
    expect((caught as HttpBoundaryError).statusCode).toBe(401);
    expect((caught as Error).message).not.toContain(sentinel);
  });

  it("rejects an over-cap bearer before invoking a custom verifier", () => {
    const sentinel = "PRIVATE_OVERSIZED_CUSTOM_BEARER_SENTINEL";
    const candidate = sentinel.padEnd(EXPECTED_CREDENTIAL_MAX_BYTES + 1, "x");
    const authenticateBearer = vi.fn(() => ({ principalId: "operator-1" }));
    let caught: unknown;

    try {
      evaluateLegacySseRequest(
        {
          method: "GET",
          host: "127.0.0.1:9311",
          authorization: `Bearer ${candidate}`,
        },
        { ...localConfig, requiresBearer: true },
        undefined,
        authenticateBearer,
      );
    } catch (error) {
      caught = error;
    }

    const authenticateCalls = authenticateBearer.mock.calls.length;
    authenticateBearer.mockClear();
    expect(authenticateCalls).toBe(0);
    expect(caught).toBeInstanceOf(HttpBoundaryError);
    expect((caught as HttpBoundaryError).statusCode).toBe(401);
    expect((caught as Error).message).not.toContain(sentinel);
  });

  it("never accepts the JetKVM credential as the MCP bearer boundary", () => {
    expectBoundaryStatus(
      () =>
        evaluateLegacySseRequest(
          {
            method: "GET",
            host: "127.0.0.1:9311",
            authorization: "Bearer device-credential",
          },
          { ...localConfig, requiresBearer: true },
        ),
      401,
    );
  });
});

function expectCredentialSizeError(error: unknown, sentinel: string): void {
  expect(error).toBeInstanceOf(CredentialConfigurationError);
  expect((error as Error).message).toBe("Credential exceeds maximum size");
  expect(error).not.toHaveProperty("code");
  expect(error).not.toHaveProperty("cause");

  for (const surface of [
    (error as Error).message,
    (error as Error).stack ?? "",
    JSON.stringify(error),
  ]) {
    expect(surface).not.toContain(sentinel);
  }
}

function expectBoundaryStatus(
  action: () => unknown,
  statusCode: 401 | 403,
): void {
  try {
    action();
    throw new Error("Expected boundary rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpBoundaryError);
    expect((error as HttpBoundaryError).statusCode).toBe(statusCode);
    expect((error as Error).message).not.toMatch(
      /bearer|credential|target|url/i,
    );
  }
}

function expectProtectedCredentialFileLookupError(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected protected credential-file lookup rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialConfigurationError);
    expect((error as Error).message).toBe(
      "Credential source must be a protected regular file",
    );
    expect(error).not.toHaveProperty("code");
    expect(error).not.toHaveProperty("cause");

    for (const surface of [
      (error as Error).message,
      (error as Error).stack ?? "",
      JSON.stringify(error),
    ]) {
      expect(surface).not.toMatch(
        /PRIVATE_BEARER_SENTINEL|private-url-sentinel|PRIVATE_PASTE_SENTINEL|ENOENT|ENOTDIR/,
      );
    }
  }
}
