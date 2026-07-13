import { mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseOperatorConfig } from "../config.js";
import {
  activateIndependentLegacySseBearerCredential,
  CredentialConfigurationError,
  DisposableSecret,
  HttpBoundaryError,
  evaluateLegacySseRequest,
  loadCredentialSecret,
  selectCredentialSource,
  validateCredentialFileMetadata,
} from "./auth.js";

describe("credential source selection", () => {
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
