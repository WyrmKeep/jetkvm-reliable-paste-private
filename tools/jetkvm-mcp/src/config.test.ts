import { describe, expect, it, vi } from "vitest";
import type { LegacySseConfigInput, OperatorConfigInput } from "./config.js";
import { TOOL_INPUT_SCHEMAS, TOOL_RESULT_SCHEMAS } from "./mcp/schemas.js";
import {
  assertPublicContractContainsNoOperatorSecrets,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_PRINCIPAL,
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_SESSION,
  LEGACY_SSE_QUEUED_RESPONSE_BUDGET_BYTES,
  LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_PRINCIPAL,
  LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_STREAM,
  LEGACY_SSE_MAX_HEADER_BYTES,
  LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
  MCP_TRANSPORT_MAX_REQUEST_BYTES,
  parseOperatorConfig,
} from "./config.js";

describe("OperatorConfig", () => {
  it("fixes the v0.1 legacy SSE request-body allocation bound at 2 MiB", () => {
    expect(MCP_TRANSPORT_MAX_REQUEST_BYTES).toBe(2_097_152);
    expect(LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES).toBe(67_108_864);
    expect(LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_PRINCIPAL).toBe(16_777_216);
    expect(LEGACY_SSE_ACTIVE_REQUEST_BODY_BYTES_PER_SESSION).toBe(4_194_304);
    expect(LEGACY_SSE_QUEUED_RESPONSE_BUDGET_BYTES).toBe(67_108_864);
    expect(LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_PRINCIPAL).toBe(16_777_216);
    expect(LEGACY_SSE_QUEUED_RESPONSE_BYTES_PER_STREAM).toBe(16_777_216);
    expect(LEGACY_SSE_MAX_HEADER_BYTES).toBe(16_384);
  });

  it.each([
    ["public HTTPS", "https://kvm.example.com"],
    ["LAN hostname", "https://jetkvm.lan:8443/ui"],
    ["LAN IPv4", "https://192.168.10.24"],
    ["LAN IPv6", "https://[fd00::24]"],
    ["Tailscale DNS", "https://jetkvm.tail1234.ts.net"],
  ])(
    "accepts an explicit %s URL without rewriting its network class",
    (_label, targetUrl) => {
      const config = parseOperatorConfig({ targetUrl });

      expect(config.targetUrl).toBe(targetUrl);
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.credential)).toBe(true);
    },
  );

  it.each(["http://localhost", "http://127.0.0.1:8080", "http://[::1]"])(
    "accepts loopback %s only with the generic insecure target opt-in",
    (targetUrl) => {
      expect(() => parseOperatorConfig({ targetUrl })).toThrowError(
        "Plain HTTP target requires explicit insecure opt-in",
      );
      expect(
        parseOperatorConfig({ targetUrl, allowInsecureHttp: true }).targetUrl,
      ).toBe(targetUrl);
    },
  );

  it.each([
    "http://jetkvm.lan",
    "http://192.168.10.24:8080",
    "http://jetkvm.tail1234.ts.net",
  ])(
    "accepts non-loopback %s only with both dangerous HTTP opt-ins",
    (targetUrl) => {
      expect(() =>
        parseOperatorConfig({ targetUrl, allowInsecureHttp: true }),
      ).toThrowError(
        "Non-loopback plain HTTP target requires explicit dangerous-network opt-in",
      );
      expect(
        parseOperatorConfig({
          targetUrl,
          allowInsecureHttp: true,
          allowDangerousTargetHttp: true,
        }).targetUrl,
      ).toBe(targetUrl);
    },
  );

  it.each([
    ["malformed", "not a URL"],
    ["relative", "/device"],
    ["credentials", "https://operator:secret@jetkvm.lan"],
    ["fragment", "https://jetkvm.lan/#login"],
    ["query", "https://jetkvm.lan/?token=secret"],
    ["unsafe file", "file:///etc/passwd"],
    ["unsafe websocket", "ws://jetkvm.lan"],
    ["unsafe javascript", "javascript:alert(1)"],
    ["whitespace", " https://jetkvm.lan"],
  ])("rejects %s target URLs", (_label, targetUrl) => {
    expect(() =>
      parseOperatorConfig({ targetUrl, allowInsecureHttp: true }),
    ).toThrowError();
  });

  it("requires an explicit target URL", () => {
    expect(() => parseOperatorConfig({})).toThrowError(
      "A JetKVM target URL is required",
    );
  });

  it("applies non-secret CLI-over-environment precedence without reading credentials", () => {
    const readCredential = vi.fn();
    const config = parseOperatorConfig(
      {
        targetUrl: "https://cli.jetkvm.lan",
        credentialFile: "/cli/credential",
      },
      {
        JETKVM_TARGET_URL: "https://env.jetkvm.lan",
        JETKVM_CREDENTIAL_FILE: "/env/credential",
        JETKVM_CREDENTIAL_ENV: "DEVICE_SECRET",
      },
    );

    expect(config.targetUrl).toBe("https://cli.jetkvm.lan");
    expect(config.credential).toEqual({
      environmentVariable: "DEVICE_SECRET",
      filePath: "/cli/credential",
    });
    expect(readCredential).not.toHaveBeenCalled();
  });

  it("rejects target and bearer source identities before credential access", () => {
    for (const input of [
      {
        credentialEnvironmentVariable: "SHARED_SECRET",
        legacySse: { bearerEnvironmentVariable: "SHARED_SECRET" },
      },
      {
        credentialFile: "/run/secrets/jetkvm",
        legacySse: { bearerCredentialFile: "/run/secrets/jetkvm" },
      },
      {
        credentialFile: "/run/secrets/../secrets/jetkvm",
        legacySse: { bearerCredentialFile: "/run/secrets/jetkvm" },
      },
    ]) {
      expect(() =>
        parseOperatorConfig({
          targetUrl: "https://jetkvm.lan",
          ...input,
        }),
      ).toThrowError(
        "Target and legacy SSE credential sources must be independent",
      );
    }
  });

  it("parses the dangerous target HTTP environment opt-in with CLI precedence", () => {
    expect(() =>
      parseOperatorConfig(
        {
          targetUrl: "http://jetkvm.lan",
          allowInsecureHttp: true,
          allowDangerousTargetHttp: false,
        },
        { JETKVM_ALLOW_DANGEROUS_TARGET_HTTP: "true" },
      ),
    ).toThrowError(
      "Non-loopback plain HTTP target requires explicit dangerous-network opt-in",
    );

    const config = parseOperatorConfig(
      { targetUrl: "http://jetkvm.lan", allowInsecureHttp: true },
      { JETKVM_ALLOW_DANGEROUS_TARGET_HTTP: "true" },
    );
    expect(config.allowDangerousTargetHttp).toBe(true);
  });

  it("resolves browser launch settings with input-over-environment precedence", () => {
    expect(
      parseOperatorConfig(
        {
          targetUrl: "https://jetkvm.lan",
          headless: false,
          chromiumExecutablePath: "/operator/chromium",
        },
        {
          JETKVM_HEADLESS: "true",
          JETKVM_CHROMIUM_EXECUTABLE_PATH: "/environment/chromium",
        },
      ),
    ).toMatchObject({
      headless: false,
      chromiumExecutablePath: "/operator/chromium",
    });
    expect(
      parseOperatorConfig(
        { targetUrl: "https://jetkvm.lan" },
        {
          JETKVM_HEADLESS: "false",
          JETKVM_CHROMIUM_EXECUTABLE_PATH: "/environment/chromium",
        },
      ),
    ).toMatchObject({
      headless: false,
      chromiumExecutablePath: "/environment/chromium",
    });
    expect(
      parseOperatorConfig({ targetUrl: "https://jetkvm.lan" }),
    ).toMatchObject({
      headless: true,
      chromiumExecutablePath: undefined,
    });
  });

  it.each(["", "relative/chromium", "\u0000/chromium"])(
    "rejects unsafe Chromium executable path %o",
    (chromiumExecutablePath) => {
      expect(() =>
        parseOperatorConfig({
          targetUrl: "https://jetkvm.lan",
          chromiumExecutablePath,
        }),
      ).toThrowError("chromiumExecutablePath must be an absolute path");
    },
  );

  it("rejects malformed browser launch environment values", () => {
    expect(() =>
      parseOperatorConfig(
        { targetUrl: "https://jetkvm.lan" },
        { JETKVM_HEADLESS: "0" },
      ),
    ).toThrowError("JETKVM_HEADLESS must be true or false");
    expect(() =>
      parseOperatorConfig(
        { targetUrl: "https://jetkvm.lan" },
        { JETKVM_CHROMIUM_EXECUTABLE_PATH: "relative/chromium" },
      ),
    ).toThrowError("chromiumExecutablePath must be an absolute path");
  });

  it.each([
    ["allowInsecureHttp", "false"],
    ["allowInsecureHttp", "true"],
    ["allowInsecureHttp", 1],
    ["allowInsecureHttp", {}],
    ["allowDangerousTargetHttp", "false"],
    ["allowDangerousTargetHttp", "true"],
    ["allowDangerousTargetHttp", 1],
    ["allowDangerousTargetHttp", {}],
    ["headless", "false"],
    ["headless", "true"],
    ["headless", 1],
    ["headless", {}],
  ] as const)("rejects non-boolean operator flag %s=%o", (flag, value) => {
    const input = {
      targetUrl: "http://jetkvm.lan",
      allowInsecureHttp: true,
      allowDangerousTargetHttp: true,
      [flag]: value,
    } as unknown as OperatorConfigInput;

    expect(() => parseOperatorConfig(input)).toThrowError(
      `${flag} must be a boolean`,
    );
  });

  it.each([
    ["enabled", "false"],
    ["enabled", "true"],
    ["enabled", 1],
    ["enabled", {}],
    ["allowNetworkExposure", "false"],
    ["allowNetworkExposure", "true"],
    ["allowNetworkExposure", 1],
    ["allowNetworkExposure", {}],
    ["allowPlaintextHttp", "false"],
    ["allowPlaintextHttp", "true"],
    ["allowPlaintextHttp", 1],
    ["allowPlaintextHttp", {}],
    ["allowDangerousNetworkPlaintext", "false"],
    ["allowDangerousNetworkPlaintext", "true"],
    ["allowDangerousNetworkPlaintext", 1],
    ["allowDangerousNetworkPlaintext", {}],
  ] as const)("rejects non-boolean legacy SSE flag %s=%o", (flag, value) => {
    const legacySse = { [flag]: value } as unknown as LegacySseConfigInput;
    expect(() =>
      parseOperatorConfig({
        targetUrl: "https://jetkvm.lan",
        legacySse,
      }),
    ).toThrowError(`${flag} must be a boolean`);
  });

  it("parses and validates every option before any credential or transport effect", () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      { JETKVM_TARGET_URL: "not a URL" },
      {
        get(target, key) {
          if (key === "JETKVM_CREDENTIAL") {
            throw new Error("credential read happened");
          }
          return Reflect.get(target, key);
        },
      },
    );

    expect(() => parseOperatorConfig({}, environment)).toThrowError(
      "Invalid JetKVM target URL",
    );
  });

  it("keeps legacy SSE policy independent from the JetKVM target", () => {
    const first = parseOperatorConfig({
      targetUrl: "https://first.jetkvm.lan",
      legacySse: {
        enabled: true,
        hostAuthorities: ["127.0.0.1:9311"],
      },
    });
    const second = parseOperatorConfig({
      targetUrl: "https://second.tail1234.ts.net",
      legacySse: {
        enabled: true,
        hostAuthorities: ["127.0.0.1:9311"],
      },
    });

    expect(first.legacySse).toEqual(second.legacySse);
  });

  it("defaults legacy SSE to a disabled loopback-only policy", () => {
    expect(
      parseOperatorConfig({ targetUrl: "https://jetkvm.lan" }).legacySse,
    ).toEqual({
      enabled: false,
      scheme: "https",
      bindHost: "127.0.0.1",
      hostAuthorities: ["127.0.0.1"],
      allowedOrigins: [],
      rejectMissingOrigin: false,
      requiresBearer: false,
      requiresAntiCsrf: false,
      bearerCredential: null,
      networkExposed: false,
      routeAttemptRateLimit: 720,
      routeAttemptRateWindowMs: 60_000,
      maxConcurrentStreams: 64,
      maxConcurrentStreamsPerPrincipal: 8,
      streamOpenRateLimit: 120,
      streamOpenRateLimitPerPrincipal: 30,
      streamOpenRateWindowMs: 60_000,
      maxConcurrentPosts: 64,
      maxConcurrentPostsPerPrincipal: 16,
      maxConcurrentPostsPerSession: 4,
      postRateLimit: 600,
      postRateLimitPerPrincipal: 120,
      postRateLimitPerSession: 60,
      postRateWindowMs: 60_000,
      maxConnections: 160,
      sessionIdleTimeoutMs: 300_000,
      requestHeaderTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      requestBodyIdleTimeoutMs: 5_000,
      requestBodyTotalTimeoutMs: 30_000,
      maxResponseMessageBytes: 14_680_064,
      maxResponseBufferedBytes: 16_777_216,
      responseBackpressureTimeoutMs: 5_000,
    });
  });

  it.each([
    ["image/jpeg", 2_097_152],
    ["image/png", 8_388_608],
  ] as const)(
    "accepts a maximum legal %s result with a near-maximum request id",
    (mimeType, rawImageBytes) => {
      const requestPrefix = '{"jsonrpc":"2.0","id":"';
      const requestSuffix =
        '","method":"tools/call","params":{"name":"jetkvm_display_capture","arguments":{}}}';
      const id = "i".repeat(
        MCP_TRANSPORT_MAX_REQUEST_BYTES -
          Buffer.byteLength(requestPrefix) -
          Buffer.byteLength(requestSuffix),
      );
      expect(Buffer.byteLength(requestPrefix + id + requestSuffix)).toBe(
        MCP_TRANSPORT_MAX_REQUEST_BYTES,
      );

      const base64 = Buffer.alloc(rawImageBytes).toString("base64");
      const frame = `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ outcome: "applied" }) },
            { type: "image", data: base64, mimeType },
          ],
          structuredContent: {
            outcome: "applied",
            image: {
              content_index: 1,
              mime_type: mimeType,
              sha256: "f".repeat(64),
              byte_length: rawImageBytes,
            },
          },
        },
      })}\n\n`;
      const policy = parseOperatorConfig({
        targetUrl: "https://jetkvm.lan",
      }).legacySse;
      const serializedBytes = Buffer.byteLength(frame);

      expect(serializedBytes).toBeGreaterThan(4 * Math.ceil(rawImageBytes / 3));
      expect(serializedBytes).toBeLessThanOrEqual(
        policy.maxResponseMessageBytes,
      );
      expect(policy.maxResponseMessageBytes).toBe(
        LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
      );
      expect(policy.maxResponseMessageBytes).toBeLessThan(
        policy.maxResponseBufferedBytes,
      );
    },
  );

  it("rejects non-loopback SSE unless exposure, exact Host/Origin, and independent bearer are explicit", () => {
    const base = {
      targetUrl: "https://jetkvm.lan",
      legacySse: {
        enabled: true,
        bindHost: "0.0.0.0",
        hostAuthorities: ["mcp.example.com:9311"],
        allowedOrigins: ["https://operator.example.com"],
        bearerCredentialFile: "/run/secrets/mcp-bearer",
      },
    } as const;

    expect(() => parseOperatorConfig(base)).toThrowError(
      "Non-loopback legacy SSE requires explicit network exposure",
    );

    const config = parseOperatorConfig({
      ...base,
      legacySse: { ...base.legacySse, allowNetworkExposure: true },
    });
    expect(config.legacySse).toMatchObject({
      networkExposed: true,
      rejectMissingOrigin: true,
      requiresBearer: true,
      requiresAntiCsrf: true,
      bearerCredential: {
        environmentVariable: "JETKVM_MCP_BEARER",
        filePath: "/run/secrets/mcp-bearer",
      },
    });
  });

  it("defaults SSE to HTTPS and requires two explicit opt-ins for network plaintext", () => {
    const network = {
      enabled: true,
      bindHost: "0.0.0.0",
      scheme: "http" as const,
      allowNetworkExposure: true,
      hostAuthorities: ["mcp.example.com:9311"],
      allowedOrigins: ["https://operator.example.com"],
      bearerEnvironmentVariable: "JETKVM_MCP_BEARER",
    };

    expect(() =>
      parseOperatorConfig({
        targetUrl: "https://jetkvm.lan",
        legacySse: network,
      }),
    ).toThrowError("Plain HTTP legacy SSE requires explicit insecure opt-in");
    expect(() =>
      parseOperatorConfig({
        targetUrl: "https://jetkvm.lan",
        legacySse: { ...network, allowPlaintextHttp: true },
      }),
    ).toThrowError(
      "Non-loopback plain HTTP legacy SSE requires explicit dangerous-network opt-in",
    );

    expect(
      parseOperatorConfig({
        targetUrl: "https://jetkvm.lan",
        legacySse: {
          ...network,
          allowPlaintextHttp: true,
          allowDangerousNetworkPlaintext: true,
        },
      }).legacySse.scheme,
    ).toBe("http");
  });

  it("validates bounded SSE resource policy relationships", () => {
    for (const legacySse of [
      { routeAttemptRateLimit: 0 },
      { routeAttemptRateWindowMs: 3_600_001 },
      { maxConcurrentStreams: 0 },
      { maxConcurrentStreams: 2, maxConcurrentStreamsPerPrincipal: 3 },
      { streamOpenRateLimit: 2, streamOpenRateLimitPerPrincipal: 3 },
      { maxConcurrentPosts: 0 },
      { maxConcurrentPosts: 2, maxConcurrentPostsPerPrincipal: 3 },
      { maxConcurrentPosts: 2, maxConcurrentPostsPerSession: 3 },
      { postRateLimit: 2, postRateLimitPerPrincipal: 3 },
      { postRateLimit: 2, postRateLimitPerSession: 3 },
      { postRateWindowMs: 3_600_001 },
      { requestBodyIdleTimeoutMs: 100, requestBodyTotalTimeoutMs: 99 },
      { maxResponseMessageBytes: Number.POSITIVE_INFINITY },
      {
        maxResponseMessageBytes: LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES - 1,
      },
      {
        maxResponseMessageBytes: 2_000_000,
        maxResponseBufferedBytes: 1_999_999,
      },
      { maxConcurrentStreams: 1_025 },
      { streamOpenRateLimit: 10_001 },
      { streamOpenRateWindowMs: 3_600_001 },
      { sessionIdleTimeoutMs: 3_600_001 },
      { requestBodyIdleTimeoutMs: 60_001 },
      { requestBodyTotalTimeoutMs: 120_001 },
      { maxResponseMessageBytes: 16_777_217 },
      { maxResponseBufferedBytes: 16_777_217 },
      { responseBackpressureTimeoutMs: 60_001 },
      { requestHeaderTimeoutMs: 60_001 },
      { keepAliveTimeoutMs: 60_001 },
    ]) {
      expect(() =>
        parseOperatorConfig({
          targetUrl: "https://jetkvm.lan",
          legacySse,
        }),
      ).toThrowError();
    }
  });

  it.each([
    [
      { bindHost: "0.0.0.0", allowNetworkExposure: true },
      "exact Host authorities",
    ],
    [
      {
        bindHost: "0.0.0.0",
        allowNetworkExposure: true,
        hostAuthorities: ["mcp.example.com:9311"],
      },
      "exact Origin allowlist",
    ],
    [
      {
        bindHost: "0.0.0.0",
        allowNetworkExposure: true,
        hostAuthorities: ["mcp.example.com:9311"],
        allowedOrigins: ["https://operator.example.com"],
      },
      "independent bearer credential",
    ],
  ])(
    "rejects incomplete non-loopback SSE policy requiring %s",
    (legacySse, requirement) => {
      expect(() =>
        parseOperatorConfig({
          targetUrl: "https://jetkvm.lan",
          legacySse: { enabled: true, ...legacySse },
        }),
      ).toThrowError(requirement);
    },
  );

  it.each([
    { hostAuthorities: ["*"] },
    { hostAuthorities: ["https://mcp.example.com"] },
    { hostAuthorities: ["operator:secret@mcp.example.com"] },
    { hostAuthorities: ["mcp.example.com?route=private"] },
    { hostAuthorities: ["mcp.example.com#private"] },
    { hostAuthorities: ["MCP.EXAMPLE.COM"] },
    { hostAuthorities: ["mcp.example.com:09311"] },
    { bindHost: "mcp.example.com" },
    { scheme: "ftp" as never },
    { allowedOrigins: ["*"] },
    { allowedOrigins: ["https://operator.example.com/path"] },
  ])(
    "rejects wildcard or malformed SSE authorities and origins",
    (legacySse) => {
      expect(() =>
        parseOperatorConfig({
          targetUrl: "https://jetkvm.lan",
          legacySse: { enabled: true, ...legacySse },
        }),
      ).toThrowError();
    },
  );
});

describe("public contract secret-field guard", () => {
  it("accepts schemas/results without target or authentication fields", () => {
    expect(() =>
      assertPublicContractContainsNoOperatorSecrets({
        tools: [
          {
            name: "jetkvm_session_connect",
            inputSchema: { properties: { timeout_ms: {} } },
          },
        ],
        result: { session_id: "opaque", state: "connected" },
      }),
    ).not.toThrow();
  });

  it("accepts the complete generated public input and result contracts", () => {
    expect(() =>
      assertPublicContractContainsNoOperatorSecrets({
        inputs: TOOL_INPUT_SCHEMAS,
        results: TOOL_RESULT_SCHEMAS,
      }),
    ).not.toThrow();
  });

  it.each([
    "url",
    "target_url",
    "credential",
    "password",
    "authorization",
    "cookie",
    "bearer_token",
  ])("rejects the forbidden public field %s recursively", (field) => {
    expect(() =>
      assertPublicContractContainsNoOperatorSecrets({
        result: { nested: { [field]: { type: "string" } } },
      }),
    ).toThrowError("Public MCP contract contains an operator-only field");
  });
});
