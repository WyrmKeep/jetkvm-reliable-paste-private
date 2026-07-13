import { describe, expect, it } from "vitest";
import { createStructuredLogger, redactStructuredData } from "./logger.js";

function requireRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a record");
  }
}

describe("structured redacting logger", () => {
  it("writes deterministic one-line structured records to the injected sink", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });

    logger.info("session.connected", { sessionId: "opaque", generation: 2 });

    expect(lines).toEqual([
      '{"timestamp":"2026-07-13T12:00:00.000Z","level":"info","event":"session.connected","fields":{"sessionId":"opaque","generation":2}}\n',
    ]);
  });

  it.each([
    ["URL", { targetUrl: "https://operator:secret@jetkvm.lan/ui?token=x" }],
    ["bearer", { authorization: "Bearer abc.def.ghi" }],
    ["cookie", { headers: { cookie: "session=private" } }],
    ["credential", { password: "device-password", apiToken: "token-value" }],
    ["proof", { leaseProof: "proof-value" }],
    ["SDP", { answerSdp: "v=0\r\na=fingerprint:secret" }],
    ["ICE", { iceCandidate: "candidate:1 1 UDP 1 192.0.2.1 123 typ host" }],
    ["frame", { frameBytes: Buffer.from("private-frame") }],
    ["image", { screenshotBase64: "cHJpdmF0ZS1pbWFnZQ==" }],
    ["paste", { pastePayload: "private pasted text" }],
  ])("never emits %s material", (_label, fields) => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
      now: () => new Date(0),
    });

    logger.warn("operation.failed", fields);

    const output = lines.join("");
    expect(output).toContain("[REDACTED]");
    for (const forbidden of [
      "jetkvm.lan",
      "operator:secret",
      "abc.def.ghi",
      "session=private",
      "device-password",
      "token-value",
      "proof-value",
      "fingerprint:secret",
      "192.0.2.1",
      "private-frame",
      "cHJpdmF0ZS1pbWFnZQ==",
      "private pasted text",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("redacts exact typed-key fields recursively without hiding safe siblings", () => {
    const redacted = redactStructuredData({
      actions: [
        {
          type: "key",
          key: "S",
          code: "KEY_DOWN",
          sequence: 1,
        },
        {
          type: "shortcut",
          keys: ["ControlLeft", "V"],
          code: "SHORTCUT",
          sequence: 2,
        },
        {
          nested: {
            KEY: "Enter",
            KeYs: ["ShiftLeft", "A"],
            monkey: "capuchin",
            keyCount: 2,
            code: "SAFE_CODE",
          },
        },
        {
          composites: {
            typed_keys: ["typed-key-secret"],
            PressedKeys: ["pressed-key-secret"],
            "held.keys": ["held-key-secret"],
            KEY_SEQUENCE: ["sequence-key-secret"],
            keyCount: 4,
            monkey: "macaque",
            keyboardLayout: "ansi",
          },
        },
      ],
      error: {
        code: "E_KEYBOARD",
        status: "failed",
      },
    });

    expect(redacted).toEqual({
      actions: [
        {
          type: "key",
          redacted: "[REDACTED]",
          code: "KEY_DOWN",
          sequence: 1,
        },
        {
          type: "shortcut",
          redacted: "[REDACTED]",
          code: "SHORTCUT",
          sequence: 2,
        },
        {
          nested: {
            redacted: "[REDACTED]",
            redacted_2: "[REDACTED]",
            monkey: "capuchin",
            keyCount: 2,
            code: "SAFE_CODE",
          },
        },
        {
          composites: {
            redacted: "[REDACTED]",
            redacted_2: "[REDACTED]",
            redacted_3: "[REDACTED]",
            redacted_4: "[REDACTED]",
            keyCount: 4,
            monkey: "macaque",
            keyboardLayout: "ansi",
          },
        },
      ],
      error: {
        code: "E_KEYBOARD",
        status: "failed",
      },
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /ControlLeft|ShiftLeft|Enter|typed-key-secret|pressed-key-secret|held-key-secret|sequence-key-secret/,
    );
  });

  it("redacts EDID fingerprints without matching unrelated field substrings", () => {
    const redacted = redactStructuredData({
      display: {
        EDID: {
          manufacturer_id: "edid-manufacturer-secret",
          product_code: "edid-product-secret",
          serial_number: "edid-serial-secret",
          display_name: "edid-name-secret",
        },
        fingerprints: [
          {
            Manufacturer_ID: "standalone-manufacturer-secret",
            "PRODUCT-CODE": "standalone-product-secret",
          },
          {
            nested: {
              "Serial Number": "standalone-serial-secret",
              "Display.Name": "standalone-name-secret",
            },
          },
        ],
        serial_sequence_completed: true,
        serialNumberFormat: "numeric",
        productCodeCount: 2,
        displayNameAvailable: true,
        code: "EDID_READY",
        status: "ready",
      },
    });

    expect(redacted).toEqual({
      display: {
        redacted: "[REDACTED]",
        fingerprints: [
          {
            redacted: "[REDACTED]",
            redacted_2: "[REDACTED]",
          },
          {
            nested: {
              redacted: "[REDACTED]",
              redacted_2: "[REDACTED]",
            },
          },
        ],
        serial_sequence_completed: true,
        serialNumberFormat: "numeric",
        productCodeCount: 2,
        displayNameAvailable: true,
        code: "EDID_READY",
        status: "ready",
      },
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /edid-(?:manufacturer|product|serial|name)-secret|standalone-(?:manufacturer|product|serial|name)-secret/,
    );
  });

  it("uses intrinsic indexed traversal for attacker-controlled arrays", () => {
    const actions: Array<Record<string, unknown>> = [
      { key: "array-key-secret", code: "KEY_DOWN" },
      { keys: ["array-shortcut-secret"], count: 1 },
    ];
    Object.setPrototypeOf(actions, {
      inheritedSecret: "array-prototype-secret",
      map(): never {
        throw new Error("attacker map called");
      },
    });
    let redacted: unknown;

    expect(() => {
      redacted = redactStructuredData({
        actions,
        code: "ARRAY_READY",
      });
    }).not.toThrow();
    expect(redacted).toEqual({
      actions: [
        { redacted: "[REDACTED]", code: "KEY_DOWN" },
        { redacted: "[REDACTED]", count: 1 },
      ],
      code: "ARRAY_READY",
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /array-key-secret|array-shortcut-secret|array-prototype-secret/,
    );
  });

  it("rejects oversized proxied arrays before own-key materialization", () => {
    let ownKeysCalls = 0;
    let indexedDescriptorCalls = 0;
    let accessorCalls = 0;
    const target = new Array<unknown>(10_001).fill(
      "oversized-array-dense-secret",
    );
    Object.defineProperty(target, 0, {
      configurable: true,
      enumerable: true,
      get(): string {
        accessorCalls += 1;
        return "oversized-array-accessor-secret";
      },
    });
    const oversizedProxy = new Proxy(target, {
      ownKeys(): never {
        ownKeysCalls += 1;
        throw new Error("ownKeys must not run");
      },
      getOwnPropertyDescriptor(
        arrayTarget,
        key,
      ): PropertyDescriptor | undefined {
        if (key !== "length") {
          indexedDescriptorCalls += 1;
        }
        return Reflect.getOwnPropertyDescriptor(arrayTarget, key);
      },
    });

    expect(redactStructuredData({ oversizedProxy, status: "ready" })).toEqual({
      oversizedProxy: "[REDACTED]",
      status: "ready",
    });
    expect(ownKeysCalls).toBe(0);
    expect(indexedDescriptorCalls).toBe(0);
    expect(accessorCalls).toBe(0);
  });

  it("unboxes primitives intrinsically and rejects unsupported objects", () => {
    let getterCalls = 0;
    const unsupportedValue = Object.create({
      inheritedSecret: "hostile-prototype-secret",
      toJSON(): string {
        return "hostile-to-json-secret";
      },
    }) as Record<string, unknown>;
    Object.defineProperty(unsupportedValue, "memo", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "hostile-getter-secret";
      },
    });
    const boxedValue = new String("Bearer boxed-string-secret");
    Object.defineProperty(boxedValue, "valueOf", {
      value: () => "boxed-value-of-bypass",
    });
    Object.defineProperty(boxedValue, "toJSON", {
      value: () => "boxed-to-json-secret",
    });

    const redacted = redactStructuredData({
      boxedValue,
      boxedSafe: new String("boxed-safe-sibling"),
      boxedNumber: new Number(7),
      boxedBoolean: new Boolean(true),
      boxedBigInt: Object(9n),
      unsupportedValue,
      code: "OBJECT_READY",
    });

    expect(getterCalls).toBe(0);
    expect(redacted).toEqual({
      boxedValue: "[REDACTED]",
      boxedSafe: "boxed-safe-sibling",
      boxedNumber: 7,
      boxedBoolean: true,
      boxedBigInt: "9",
      unsupportedValue: "[REDACTED]",
      code: "OBJECT_READY",
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /boxed-string-secret|boxed-value-of-bypass|boxed-to-json-secret|hostile-prototype-secret|hostile-to-json-secret|hostile-getter-secret/,
    );
  });

  it("redacts plain-object accessors without invoking getters", () => {
    let getterCalls = 0;
    const throwOnRead = (): never => {
      getterCalls += 1;
      throw new Error("attacker getter called");
    };
    const nested: Record<string, unknown> = {
      code: "NESTED_READY",
    };
    Object.defineProperty(nested, "data", {
      enumerable: true,
      get: throwOnRead,
    });
    const typeProbe: Record<string, unknown> = {
      data: "type-probe-data-secret",
      code: "TYPE_PROBE",
    };
    Object.defineProperty(typeProbe, "type", {
      enumerable: true,
      get: throwOnRead,
    });
    const mimeProbe: Record<string, unknown> = {
      data: "mime-probe-data-secret",
      status: "ready",
    };
    Object.defineProperty(mimeProbe, "mimeType", {
      enumerable: true,
      get: throwOnRead,
    });
    const fields: Record<string, unknown> = {
      status: "ready",
      nested,
      typeProbe,
      mimeProbe,
    };
    Object.defineProperties(fields, {
      authorization: {
        enumerable: true,
        get: throwOnRead,
      },
      safeMemo: {
        enumerable: true,
        get: throwOnRead,
      },
    });
    const lines: string[] = [];

    expect(() =>
      createStructuredLogger({ write: (line) => lines.push(line) }).info(
        "accessor.received",
        fields,
      ),
    ).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? "");
    requireRecord(record);
    requireRecord(record.fields);
    expect(record.fields).toEqual({
      status: "ready",
      nested: {
        code: "NESTED_READY",
        data: "[REDACTED]",
      },
      typeProbe: {
        data: "[REDACTED]",
        code: "TYPE_PROBE",
        type: "[REDACTED]",
      },
      mimeProbe: {
        data: "[REDACTED]",
        status: "ready",
        mimeType: "[REDACTED]",
      },
      redacted: "[REDACTED]",
      safeMemo: "[REDACTED]",
    });
    expect(lines.join("")).not.toMatch(
      /type-probe-data-secret|mime-probe-data-secret|attacker getter called/,
    );
  });

  it("fails closed for nested throwing and revoked object and array proxies", () => {
    let accessorCalls = 0;
    const objectTarget: Record<string, unknown> = {};
    Object.defineProperty(objectTarget, "memo", {
      enumerable: true,
      get(): string {
        accessorCalls += 1;
        return "object-accessor-secret";
      },
    });
    const throwingObject = new Proxy(objectTarget, {
      getPrototypeOf(): never {
        throw new Error("object prototype trap");
      },
    });
    const descriptorObject = new Proxy(objectTarget, {
      ownKeys(): never {
        throw new Error("object descriptor trap");
      },
    });

    const arrayTarget: unknown[] = [];
    Object.defineProperty(arrayTarget, 0, {
      configurable: true,
      enumerable: true,
      get(): string {
        accessorCalls += 1;
        return "array-accessor-secret";
      },
    });
    const throwingLengthArray = new Proxy(arrayTarget, {
      get(target, key, receiver): unknown {
        if (key === "length") {
          throw new Error("array length trap");
        }
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        if (key === "length") {
          throw new Error("array length descriptor trap");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const throwingDescriptorArray = new Proxy(arrayTarget, {
      getOwnPropertyDescriptor(): never {
        throw new Error("array descriptor trap");
      },
    });

    const revokedObjectHandle = Proxy.revocable({ status: "private" }, {});
    const revokedArrayHandle = Proxy.revocable(["private"], {});
    revokedObjectHandle.revoke();
    revokedArrayHandle.revoke();

    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });

    expect(() =>
      logger.info("proxy.received", {
        throwingObject,
        descriptorObject,
        throwingLengthArray,
        throwingDescriptorArray,
        revokedObject: revokedObjectHandle.proxy,
        revokedArray: revokedArrayHandle.proxy,
        oversizedArray: new Array(10_001),
        status: "ready",
      }),
    ).not.toThrow();
    expect(accessorCalls).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "");
    requireRecord(parsed);
    requireRecord(parsed.fields);
    expect(parsed.fields).toEqual({
      throwingObject: "[REDACTED]",
      descriptorObject: "[REDACTED]",
      throwingLengthArray: "[REDACTED]",
      throwingDescriptorArray: "[REDACTED]",
      revokedObject: "[REDACTED]",
      revokedArray: "[REDACTED]",
      oversizedArray: "[REDACTED]",
      status: "ready",
    });
    expect(lines.join("")).not.toMatch(
      /object-accessor-secret|array-accessor-secret|private/,
    );
  });

  it("escapes every physical and Unicode line separator before sink output", () => {
    const lines: string[] = [];
    const note = "safe\u2028logical\u2029record\ncarriage\rreturn";
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "record.safe",
      { note },
    );

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line.split("\n")).toHaveLength(2);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("\r");
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(line).toContain("\\n");
    expect(line).toContain("\\r");
    expect(line).toContain("\\u2028");
    expect(line).toContain("\\u2029");

    const parsed: unknown = JSON.parse(line);
    requireRecord(parsed);
    requireRecord(parsed.fields);
    expect(parsed.fields.note).toBe(note);
  });

  it("redacts sensitive strings even under innocent field names and inside errors", () => {
    const redacted = redactStructuredData({
      note: "request failed for https://jetkvm.lan/private",
      reason: new Error("authorization Bearer super-secret failed"),
      network: "candidate:7 1 udp 1 10.0.0.2 5000 typ host",
      offer: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-",
      content: "data:image/jpeg;base64,cHJpdmF0ZQ==",
    });
    const output = JSON.stringify(redacted);

    expect(output).not.toMatch(
      /jetkvm|super-secret|10\.0\.0\.2|127\.0\.0\.1|cHJpdmF0ZQ/,
    );
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("at ");
  });

  it("redacts credential assignments and every Error message to stable diagnostics", () => {
    const redacted = redactStructuredData({
      note: "JETKVM_CREDENTIAL=super-secret",
      detail: "password: hunter2",
      reason: new Error("apparently harmless but unclassified downstream text"),
    });

    expect(redacted).toEqual({
      note: "[REDACTED]",
      detail: "[REDACTED]",
      reason: { name: "Error", message: "[REDACTED]" },
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /super-secret|hunter2|downstream/,
    );
  });

  it("recursively sanitizes serialized JSON and malformed quoted sensitive keys", () => {
    const serialized = JSON.stringify({
      status: "still-useful",
      nested: JSON.stringify({
        password: "json-password",
        authorization: "json-authorization",
        cookie: "json-cookie",
        refreshToken: "json-token",
        callbackURL: "https://json-url.invalid/private",
        values: [JSON.stringify({ password: "array-password" })],
      }),
    });
    const malformed = String.raw`{\"password\":\"broken-password\",\"authorization\":\"broken-authorization\",\"cookie\":\"broken-cookie\",\"token\":\"broken-token\",\"URL\":\"https://broken-url.invalid`;
    const fields = { serialized, malformed };
    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    if (
      typeof redacted.serialized !== "string" ||
      typeof redacted.malformed !== "string"
    ) {
      throw new TypeError("Expected redacted strings");
    }
    const outer: unknown = JSON.parse(redacted.serialized);
    requireRecord(outer);
    if (typeof outer.status !== "string" || typeof outer.nested !== "string") {
      throw new TypeError("Expected serialized outer fields");
    }
    const nested: unknown = JSON.parse(outer.nested);
    requireRecord(nested);
    if (!Array.isArray(nested.values) || typeof nested.values[0] !== "string") {
      throw new TypeError("Expected a nested serialized array value");
    }

    expect(outer.status).toBe("still-useful");
    expect(nested).toMatchObject({
      redacted: "[REDACTED]",
      redacted_2: "[REDACTED]",
      redacted_3: "[REDACTED]",
      redacted_4: "[REDACTED]",
      redacted_5: "[REDACTED]",
    });
    expect(JSON.parse(nested.values[0])).toEqual({
      redacted: "[REDACTED]",
    });
    expect(redacted.malformed).toBe("[REDACTED]");

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "serialized.received",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toMatch(
        /json-password|json-authorization|json-cookie|json-token|json-url|array-password|broken-password|broken-authorization|broken-cookie|broken-token|broken-url/,
      );
    }
  });

  it("redacts every sensitive field family from malformed JSON-like strings", () => {
    const sensitiveKeys = [
      "address",
      "authorization",
      "authority",
      "base64",
      "bearer",
      "bytes",
      "clipboard",
      "cookie",
      "credential",
      "endpoint",
      "frame",
      "host",
      "iceCandidate",
      "image",
      "origin",
      "password",
      "pastePayload",
      "payload",
      "proof",
      "screenshot",
      "sdp",
      "secret",
      "text",
      "token",
      "uri",
      "url",
    ] as const;
    const malformed = sensitiveKeys.map((key, index) =>
      index % 2 === 0
        ? `{"${key}": "private-${key}"`
        : String.raw`{\"${key}\" : \"private-${key}\"`,
    );

    expect(
      redactStructuredData({
        malformed,
        safeMalformed: '{"status":"still-useful"',
      }),
    ).toEqual({
      malformed: sensitiveKeys.map(() => "[REDACTED]"),
      safeMalformed: '{"status":"still-useful"',
    });
  });

  it("redacts malformed JSON-like strings with escaped key material", () => {
    const malformedEscapedKeys = [
      String.raw`{"im\u0061ge":"unicode-image-secret"`,
      String.raw`{"p\x61stePayload":"hex-paste-secret"`,
      String.raw`{"pro\of":"backslash-proof-secret"`,
      String.raw`{"\u0073dp":"unicode-sdp-secret"`,
      String.raw`{\"creden\u0074ial\":\"unicode-credential-secret\"`,
    ];
    const prefixedEscapedKeys = [
      String.raw`downstream failed: {\"im\u0061ge\":\"prefixed-image-secret\"`,
      String.raw`paste failed: [{\"p\x61stePayload\":\"prefixed-paste-secret\"`,
      String.raw`proof failed: {\"pro\of\":\"prefixed-proof-secret\"`,
      String.raw`SDP failed: {\"\u0073dp\":\"prefixed-sdp-secret\"`,
      String.raw`credential failed: {\"creden\u0074ial\":\"prefixed-credential-secret\"`,
    ];
    const safeEscapedProse = String.raw`quoted label \"im\u0061ge\": remains prose`;
    const validEscapedJson = String.raw`{"im\u0061ge":"valid-image-secret","status":"valid-safe-sibling"}`;
    const safeNonJson = String.raw`diagnostic path C:\temp\proof\trace`;

    const redacted = redactStructuredData({
      malformedEscapedKeys,
      prefixedEscapedKeys,
      validEscapedJson,
      safeNonJson,
      safeEscapedProse,
    });
    requireRecord(redacted);
    if (typeof redacted.validEscapedJson !== "string") {
      throw new TypeError("Expected valid serialized JSON");
    }

    expect(redacted).toMatchObject({
      malformedEscapedKeys: malformedEscapedKeys.map(() => "[REDACTED]"),
      prefixedEscapedKeys: prefixedEscapedKeys.map(() => "[REDACTED]"),
      safeNonJson,
      safeEscapedProse,
    });
    expect(JSON.parse(redacted.validEscapedJson)).toEqual({
      redacted: "[REDACTED]",
      status: "valid-safe-sibling",
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /(?:unicode|prefixed)-(?:image|paste|proof|sdp|credential)-secret|hex-paste-secret|backslash-proof-secret|valid-image-secret/,
    );
  });

  it("redacts unquoted sensitive assignments without matching safe prose", () => {
    const malformedAssignments = [
      "HTTP 500: {pastePayload: 'inspect-paste-secret'",
      "image=inspect-image-secret",
      "proof : inspect-proof-secret",
      "text: inspect-text-secret",
      "SDP = inspect-sdp-secret",
      "credential: inspect-credential-secret",
    ];
    const safeDiagnostics = [
      "HTTP 500: {status: 'still-useful'",
      "proof of completion: recorded",
      "image rendering completed: ok",
      "custom://image=public",
      "ratio=16:9",
    ];

    expect(
      redactStructuredData({ malformedAssignments, safeDiagnostics }),
    ).toEqual({
      malformedAssignments: malformedAssignments.map(() => "[REDACTED]"),
      safeDiagnostics,
    });
  });

  it("fails closed for non-JSON strings in recursive error contexts", () => {
    const fields = {
      status: "top-level-safe-sibling",
      error: "simple-error-secret",
      nested: {
        status: "nested-safe-sibling",
        err: "nested-err-secret",
        deeper: {
          note: "deep-safe-sibling",
          exception: "nested-exception-secret",
        },
      },
      errorObject: {
        error: {
          detail: "nested-detail-secret",
          child: {
            detail: "deep-detail-secret",
          },
          values: ["array-error-secret"],
          code: "E_DETAIL",
          status: "failed",
          observedAt: "2026-07-13T12:00:02.000Z",
        },
      },
      exception: JSON.stringify({
        message: "json-error-message-secret",
        code: "E_JSON_ERROR",
        status: "json-safe-sibling",
      }),
    };

    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    if (typeof redacted.exception !== "string") {
      throw new TypeError("Expected a serialized exception");
    }

    expect(redacted).toMatchObject({
      status: "top-level-safe-sibling",
      error: "[REDACTED]",
      nested: {
        status: "nested-safe-sibling",
        err: "[REDACTED]",
        deeper: {
          note: "deep-safe-sibling",
          exception: "[REDACTED]",
        },
      },
      errorObject: {
        error: {
          detail: "[REDACTED]",
          child: {
            detail: "[REDACTED]",
          },
          values: ["[REDACTED]"],
          code: "E_DETAIL",
          status: "failed",
          observedAt: "2026-07-13T12:00:02.000Z",
        },
      },
    });
    expect(JSON.parse(redacted.exception)).toEqual({
      message: "[REDACTED]",
      code: "E_JSON_ERROR",
      status: "json-safe-sibling",
    });

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).error(
      "downstream.failed",
      fields,
    );
    expect(lines.join("")).not.toMatch(
      /simple-error-secret|nested-err-secret|nested-exception-secret|json-error-message-secret|nested-detail-secret|deep-detail-secret|array-error-secret|deep-safe-sibling/,
    );
    expect(lines.join("")).toMatch(
      /top-level-safe-sibling|nested-safe-sibling|json-safe-sibling/,
    );
  });

  it("seeds recursive error context only for error-level log records", () => {
    const errorLines: string[] = [];
    const infoLines: string[] = [];
    createStructuredLogger({ write: (line) => errorLines.push(line) }).error(
      "downstream.failed",
      {
        message: "root-error-message-secret",
        detail: "root-error-detail-secret",
        code: "E_ROOT",
        observedAt: "2026-07-13T12:00:00.000Z",
        nested: {
          message: "nested-error-message-secret",
          detail: "nested-error-detail-secret",
          code: "E_NESTED",
          observedAt: "2026-07-13T12:00:01.000Z",
        },
        attempts: [
          {
            message: "array-error-message-secret",
            detail: "array-error-detail-secret",
            code: "E_ARRAY",
          },
        ],
      },
    );
    createStructuredLogger({ write: (line) => infoLines.push(line) }).info(
      "downstream.status",
      {
        message: "informational-safe-message",
        code: "I_READY",
      },
    );

    const errorRecord: unknown = JSON.parse(errorLines[0] ?? "");
    const infoRecord: unknown = JSON.parse(infoLines[0] ?? "");
    requireRecord(errorRecord);
    requireRecord(errorRecord.fields);
    requireRecord(infoRecord);
    requireRecord(infoRecord.fields);

    expect(errorRecord.fields).toEqual({
      message: "[REDACTED]",
      detail: "[REDACTED]",
      code: "E_ROOT",
      observedAt: "2026-07-13T12:00:00.000Z",
      nested: {
        message: "[REDACTED]",
        detail: "[REDACTED]",
        code: "E_NESTED",
        observedAt: "2026-07-13T12:00:01.000Z",
      },
      attempts: [
        {
          message: "[REDACTED]",
          detail: "[REDACTED]",
          code: "E_ARRAY",
        },
      ],
    });
    expect(infoRecord.fields).toEqual({
      message: "informational-safe-message",
      code: "I_READY",
    });
    expect(errorLines.join("")).not.toMatch(
      /root-error-(?:message|detail)-secret|nested-error-(?:message|detail)-secret|array-error-(?:message|detail)-secret/,
    );
  });

  it("keeps prototype-shaped attacker keys as own sanitized data", () => {
    const fields: unknown = JSON.parse(
      '{"error":{"__proto__":{"detail":"proto-detail-secret","polluted":"proto-inherited-secret","status":"blocked"},"constructor":{"detail":"constructor-detail-secret","code":"E_CONSTRUCTOR"},"prototype":{"detail":"prototype-detail-secret","observedAt":"2026-07-13T12:00:03.000Z"},"status":"contained"}}',
    );
    requireRecord(fields);

    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    const errorRecord = redacted.error;
    requireRecord(errorRecord);
    const protoField = errorRecord.__proto__;
    requireRecord(protoField);

    expect(Object.getPrototypeOf(redacted)).toBeNull();
    expect(Object.getPrototypeOf(errorRecord)).toBeNull();
    expect(Object.getPrototypeOf(protoField)).toBeNull();
    expect(Object.hasOwn(errorRecord, "__proto__")).toBe(true);
    expect(Object.hasOwn(errorRecord, "constructor")).toBe(true);
    expect(Object.hasOwn(errorRecord, "prototype")).toBe(true);
    expect("polluted" in errorRecord).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(errorRecord).toEqual({
      ["__proto__"]: {
        detail: "[REDACTED]",
        polluted: "[REDACTED]",
        status: "blocked",
      },
      constructor: {
        detail: "[REDACTED]",
        code: "E_CONSTRUCTOR",
      },
      prototype: {
        detail: "[REDACTED]",
        observedAt: "2026-07-13T12:00:03.000Z",
      },
      status: "contained",
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain('"__proto__"');
    expect(serialized).not.toMatch(
      /proto-detail-secret|proto-inherited-secret|constructor-detail-secret|prototype-detail-secret/,
    );
    const reparsed: unknown = JSON.parse(serialized);
    requireRecord(reparsed);
    requireRecord(reparsed.error);
    expect(Object.hasOwn(reparsed.error, "__proto__")).toBe(true);
    expect(Object.hasOwn(reparsed.error, "constructor")).toBe(true);
    expect(Object.hasOwn(reparsed.error, "prototype")).toBe(true);
  });

  it("replaces sensitive property names with deterministic collision-safe keys", () => {
    const fields = {
      authToken: "outer-token-secret",
      redacted: "safe-redacted-value",
      credential: "outer-credential-secret",
      redacted_2: "safe-redacted-two-value",
      nested: {
        bearer: "nested-bearer-secret",
        URL: "https://operator:secret@jetkvm.invalid/private",
        token: "nested-token-secret",
        paste: "nested-paste-secret",
        credential: "nested-credential-secret",
        ICE: "candidate:1 nested-ice-secret",
        status: "ready",
      },
    };
    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    requireRecord(redacted.nested);

    expect(Object.getPrototypeOf(redacted)).toBeNull();
    expect(Object.getPrototypeOf(redacted.nested)).toBeNull();
    expect(redacted).toEqual({
      redacted_3: "[REDACTED]",
      redacted: "safe-redacted-value",
      redacted_4: "[REDACTED]",
      redacted_2: "safe-redacted-two-value",
      nested: {
        redacted: "[REDACTED]",
        redacted_2: "[REDACTED]",
        redacted_3: "[REDACTED]",
        redacted_4: "[REDACTED]",
        redacted_5: "[REDACTED]",
        redacted_6: "[REDACTED]",
        status: "ready",
      },
    });

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "sensitive-keys.received",
      fields,
    );
    const serialized = `${JSON.stringify(redacted)}${lines.join("")}`;
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
    expect(serialized).not.toMatch(
      /authToken|credential|bearer|URL|token|paste|ICE|outer-(?:token|credential)-secret|nested-(?:bearer|token|paste|credential|ice)-secret|jetkvm\.invalid/,
    );
  });

  it("redacts recursive error records without hiding safe siblings or losing cycle safety", () => {
    const cyclicError: Record<string, unknown> = {
      name: "RangeError",
      message: "cyclic-message-secret",
      stack: "cyclic-stack-secret",
      cause: "cyclic-cause-secret",
      reason: "cyclic-reason-secret",
      code: "E_CYCLIC",
      attempts: 2,
    };
    cyclicError.self = cyclicError;
    const serialized = JSON.stringify({
      wrapper: {
        error: {
          name: "Bearer malicious-name-secret",
          message: "serialized-message-secret",
          stack: "serialized-stack-secret",
          cause: "serialized-cause-secret",
          reason: "serialized-reason-secret",
          code: "E_SERIALIZED",
          retryable: true,
        },
        status: "serialized-safe-sibling",
      },
    });
    const fields = {
      status: "top-level-safe-sibling",
      ordinaryRecord: {
        message: "ordinary safe status",
        phase: "ready",
      },
      nested: [
        {
          error: {
            message: "nested-message-secret",
            stack: "nested-stack-secret",
            cause: "nested-cause-secret",
            reason: "nested-reason-secret",
            code: "E_NESTED",
            stage: "dispatch",
          },
        },
        cyclicError,
      ],
      serialized,
    };

    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    if (typeof redacted.serialized !== "string") {
      throw new TypeError("Expected a serialized error record");
    }
    const redactedSerialized: unknown = JSON.parse(redacted.serialized);

    expect(redacted).toMatchObject({
      status: "top-level-safe-sibling",
      ordinaryRecord: {
        message: "ordinary safe status",
        phase: "ready",
      },
      nested: [
        {
          error: {
            message: "[REDACTED]",
            stack: "[REDACTED]",
            cause: "[REDACTED]",
            reason: "[REDACTED]",
            code: "E_NESTED",
            stage: "dispatch",
          },
        },
        {
          name: "RangeError",
          message: "[REDACTED]",
          stack: "[REDACTED]",
          cause: "[REDACTED]",
          reason: "[REDACTED]",
          code: "E_CYCLIC",
          attempts: 2,
          self: "[REDACTED]",
        },
      ],
    });
    expect(redactedSerialized).toEqual({
      wrapper: {
        error: {
          name: "Error",
          message: "[REDACTED]",
          stack: "[REDACTED]",
          cause: "[REDACTED]",
          reason: "[REDACTED]",
          code: "E_SERIALIZED",
          retryable: true,
        },
        status: "serialized-safe-sibling",
      },
    });

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).error(
      "downstream.failed",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toMatch(
        /cyclic-(?:message|stack|cause|reason)-secret|nested-(?:message|stack|cause|reason)-secret|serialized-(?:message|stack|cause|reason)-secret|malicious-name-secret/,
      );
      expect(output).toContain("top-level-safe-sibling");
      expect(output).toContain("E_NESTED");
      expect(output).toContain("E_SERIALIZED");
    }
  });

  it("allowlists Error names while keeping every message stably redacted", () => {
    const malicious = new Error("message-secret");
    malicious.name = "Bearer name-secret";

    const fields = {
      malicious,
      standard: new TypeError("type-message-secret"),
    };
    const redacted = redactStructuredData(fields);

    expect(redacted).toEqual({
      malicious: { name: "Error", message: "[REDACTED]" },
      standard: { name: "TypeError", message: "[REDACTED]" },
    });
    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).error(
      "operation.failed",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toMatch(
        /name-secret|message-secret|type-message-secret/,
      );
    }
  });

  it("redacts nested MCP images and binary data containers by shape", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
    ]).toString("base64");
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0xca, 0xfe, 0xba, 0xbe,
    ]).toString("base64");
    const circular: Record<string, unknown> = { data: "business-data" };
    circular.items = [[circular]];
    const fields = {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        [{ type: "image", data: jpeg, mimeType: "image/jpeg" }],
      ],
      binary: {
        data: Buffer.from("binary-secret"),
        encoding: "raw",
      },
      business: {
        data: "quarterly-report",
        content: "status-ready",
      },
      circular,
    };

    const redacted = redactStructuredData(fields);

    expect(redacted).toEqual({
      content: [
        {
          type: "image",
          data: "[REDACTED]",
          mimeType: "image/png",
        },
        [
          {
            type: "image",
            data: "[REDACTED]",
            mimeType: "image/jpeg",
          },
        ],
      ],
      binary: {
        data: "[REDACTED]",
        encoding: "raw",
      },
      business: {
        data: "quarterly-report",
        content: "status-ready",
      },
      circular: {
        data: "business-data",
        items: [["[REDACTED]"]],
      },
    });

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "capture.complete",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toContain(png);
      expect(output).not.toContain(jpeg);
      expect(output).not.toContain("binary-secret");
    }
  });

  it("recognizes normalized own MIME descriptors without invoking accessors", () => {
    let accessorCalls = 0;
    const accessorImage: Record<string, unknown> = {
      data: "accessor-snake-image-secret",
      status: "ready",
    };
    Object.defineProperty(accessorImage, "mime_type", {
      enumerable: true,
      get(): string {
        accessorCalls += 1;
        return "image/png";
      },
    });
    const fields = {
      content: [
        {
          data: "snake-image-secret",
          mime_type: "image/png",
        },
        {
          data: "normalized-image-secret",
          mimetype: "IMAGE/JPEG",
        },
        accessorImage,
      ],
    };

    const redacted = redactStructuredData(fields);

    expect(accessorCalls).toBe(0);
    expect(redacted).toEqual({
      content: [
        {
          data: "[REDACTED]",
          mime_type: "image/png",
        },
        {
          data: "[REDACTED]",
          mimetype: "IMAGE/JPEG",
        },
        {
          data: "[REDACTED]",
          status: "ready",
          mime_type: "[REDACTED]",
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /snake-image-secret|normalized-image-secret|accessor-snake-image-secret/,
    );
  });

  it("redacts own data for encoded-binary encoding descriptors", () => {
    let encodingAccessorCalls = 0;
    const accessorMarker: Record<string, unknown> = {
      data: "accessor-marker-data-secret",
      status: "ready",
    };
    Object.defineProperty(accessorMarker, "encoding", {
      enumerable: true,
      get(): string {
        encodingAccessorCalls += 1;
        return "base64";
      },
    });
    const fields = {
      nested: [
        { data: "base64-data-secret", encoding: "BaSe64" },
        [{ data: "base64url-data-secret", encoding: "BASE64_URL" }],
        { data: "binary-data-secret", encoding: "Binary" },
      ],
      accessorMarker,
      business: {
        data: "quarterly-business-data",
        status: "ready",
      },
    };

    const redacted = redactStructuredData(fields);

    expect(encodingAccessorCalls).toBe(0);
    expect(redacted).toEqual({
      nested: [
        { data: "[REDACTED]", encoding: "BaSe64" },
        [{ data: "[REDACTED]", encoding: "BASE64_URL" }],
        { data: "[REDACTED]", encoding: "Binary" },
      ],
      accessorMarker: {
        data: "[REDACTED]",
        status: "ready",
        encoding: "[REDACTED]",
      },
      business: {
        data: "quarterly-business-data",
        status: "ready",
      },
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /base64-data-secret|base64url-data-secret|binary-data-secret|accessor-marker-data-secret/,
    );
  });

  it("preserves allowlisted operational metadata without mutating the input", () => {
    const input = Object.freeze({
      operationId: "op-123",
      sessionGeneration: 4,
      outcome: "not_sent",
      counts: Object.freeze({ dispatched: 0, queued: 2 }),
      safeToRetry: true,
      detail: null,
    });

    expect(redactStructuredData(input)).toEqual(input);
  });

  it("redacts circular references, binary values, and unsafe event names", () => {
    const cyclic: Record<string, unknown> = { operationId: "op-1" };
    cyclic.self = cyclic;
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
    });

    logger.error("https://jetkvm.lan", {
      cyclic,
      bytes: new Uint8Array([115, 101, 99, 114, 101, 116]),
    });

    expect(lines.join("")).not.toContain("jetkvm.lan");
    expect(lines.join("")).not.toContain("secret");
    expect(lines.join("")).toContain("[REDACTED]");
  });

  it("contains no helper capable of bypassing redaction with raw text", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
    });

    expect(Object.keys(logger).sort()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(() =>
      logger.info(
        "event",
        "raw https://jetkvm.lan" as unknown as Record<string, unknown>,
      ),
    ).toThrowError("Structured log fields must be a plain object");
    expect(lines).toEqual([]);
  });
});
