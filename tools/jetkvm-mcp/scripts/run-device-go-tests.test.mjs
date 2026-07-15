import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEVICE_LEASE_PROOF_REFERENCE_ENV,
  DEVICE_TEST_TARGET_ENV,
  parseDeviceIdentity,
  runDeviceGoTests,
  validateDeviceGoTestEvidence,
  runDeviceGoTestsCli,
} from "./run-device-go-tests.mjs";

const FIXTURE_TARGET = "192.0.2.110";
const FIXTURE_PROOF_REFERENCE = "/private/device-lease-proof.json";
const FIXTURE_DEVICE_TESTS = "/private/device-tests.tar.gz";
const FIXTURE_DEVICE_TEST_SHA256 = "f".repeat(64);

const metrics = ({
  revision = "abc123",
  version = "0.3.2",
  started = "1000.25",
} = {}) => `
# HELP jetkvm_build_info Build information
jetkvm_build_info{branch="main",goversion="go1.24.4",revision="${revision}",version="${version}"} 1
# HELP process_start_time_seconds Start time
process_start_time_seconds ${started}
`;

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => body,
});

function harness({
  before = metrics(),
  after = before,
  fetchSteps = [response(before), response(after)],
  spawnResult = { code: 0, signal: null },
  spawnError,
  flushError,
} = {}) {
  const events = [];
  const fetchCalls = [];
  const spawnCalls = [];
  let fetchCount = 0;
  const fetchImpl = async (url, options) => {
    const phase = fetchCount === 0 ? "before" : "after";
    events.push(`fetch:${phase}:${url}`);
    fetchCalls.push({ url, options });
    const step = fetchSteps[fetchCount++];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  };
  const spawnImpl = async (command, args, options) => {
    events.push(`spawn:${command}:${args.join(" ")}:${options.cwd}`);
    spawnCalls.push({ command, args, options });
    if (spawnError !== undefined) throw spawnError;
    return spawnResult;
  };
  const artifactWriter = {
    async writeAndFlush(artifactPath, artifact) {
      events.push(`artifact:start:${artifactPath}`);
      this.artifact = artifact;
      if (flushError !== undefined) throw flushError;
      await Promise.resolve();
      events.push("artifact:flushed");
    },
  };
  return {
    events,
    fetchCalls,
    spawnCalls,
    fetchImpl,
    spawnImpl,
    artifactWriter,
  };
}

function runHarness(h, overrides = {}) {
  return runDeviceGoTests({
    target: FIXTURE_TARGET,
    deviceTestArchive: FIXTURE_DEVICE_TESTS,
    deviceTestSha256: FIXTURE_DEVICE_TEST_SHA256,
    environment: {
      [DEVICE_LEASE_PROOF_REFERENCE_ENV]: FIXTURE_PROOF_REFERENCE,
    },
    fetchImpl: h.fetchImpl,
    spawnImpl: h.spawnImpl,
    artifactWriter: h.artifactWriter,
    repoRoot: "/repo",
    artifactPath: "/artifact.json",
    ...overrides,
  });
}

test("reads identity, runs only the test-only command, rechecks, and flushes in exact order", async () => {
  const h = harness();
  const result = await runHarness(h);

  assert.deepEqual(result.before, result.after);
  assert.deepEqual(result.command, {
    executable: "./dev_deploy.sh",
    args: [
      "-r",
      "<configured-target>",
      "--run-go-tests-only",
      "--device-tests-archive",
      "<reviewed-device-tests>",
      "--device-tests-sha256",
      FIXTURE_DEVICE_TEST_SHA256,
    ],
  });
  assert.deepEqual(h.events, [
    `fetch:before:http://${FIXTURE_TARGET}/metrics`,
    `spawn:./dev_deploy.sh:-r ${FIXTURE_TARGET} --run-go-tests-only --device-tests-archive ${FIXTURE_DEVICE_TESTS} --device-tests-sha256 ${FIXTURE_DEVICE_TEST_SHA256}:/repo`,
    `fetch:after:http://${FIXTURE_TARGET}/metrics`,
    "artifact:start:/artifact.json",
    "artifact:flushed",
  ]);
  assert.equal(h.artifactWriter.artifact.ok, true);
  const persistedEvidence = JSON.stringify(h.artifactWriter.artifact);
  assert.equal(persistedEvidence.includes(FIXTURE_TARGET), false);
  assert.equal(persistedEvidence.includes(FIXTURE_PROOF_REFERENCE), false);
  assert.equal(persistedEvidence.includes(FIXTURE_DEVICE_TESTS), false);
  assert.equal(h.fetchCalls[0].options.method, "GET");
  assert.deepEqual(h.fetchCalls[0].options.headers, { accept: "text/plain" });
  assert.ok(h.fetchCalls[0].options.signal instanceof AbortSignal);
});

test("validates only a complete passing device-test artifact", async () => {
  const result = await runHarness(harness());
  assert.doesNotThrow(() => validateDeviceGoTestEvidence(result));
  for (const mutate of [
    (value) => {
      value.ok = false;
    },
    (value) => {
      value.child.code = 1;
    },
    (value) => {
      value.after.revision = "changed";
    },
    (value) => {
      value.extra = true;
    },
  ]) {
    const changed = structuredClone(result);
    mutate(changed);
    assert.throws(
      () => validateDeviceGoTestEvidence(changed),
      /device Go test evidence/u,
    );
  }
});

test("uses the configured target for both metrics and the sole allowed argv", async () => {
  const h = harness();
  await runHarness(h, { target: "fixture-device.invalid" });

  assert.deepEqual(
    h.fetchCalls.map(({ url }) => url),
    [
      "http://fixture-device.invalid/metrics",
      "http://fixture-device.invalid/metrics",
    ],
  );
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].command, "./dev_deploy.sh");
  assert.deepEqual(h.spawnCalls[0].args, [
    "-r",
    "fixture-device.invalid",
    "--run-go-tests-only",
    "--device-tests-archive",
    FIXTURE_DEVICE_TESTS,
    "--device-tests-sha256",
    FIXTURE_DEVICE_TEST_SHA256,
  ]);
  assert.equal(
    h.spawnCalls[0].args.some((argument) =>
      ["--install", "--run-go-tests", "--native-binary"].includes(argument),
    ),
    false,
  );
});

test("accepts target configuration from the injected environment", async () => {
  const h = harness();
  await runHarness(h, {
    target: undefined,
    environment: {
      [DEVICE_LEASE_PROOF_REFERENCE_ENV]: FIXTURE_PROOF_REFERENCE,
      [DEVICE_TEST_TARGET_ENV]: "configured-device.invalid",
    },
  });

  assert.deepEqual(h.spawnCalls[0].args, [
    "-r",
    "configured-device.invalid",
    "--run-go-tests-only",
    "--device-tests-archive",
    FIXTURE_DEVICE_TESTS,
    "--device-tests-sha256",
    FIXTURE_DEVICE_TEST_SHA256,
  ]);
});

test("requires an inherited lease proof reference before device access", async () => {
  for (const environment of [
    {},
    { [DEVICE_LEASE_PROOF_REFERENCE_ENV]: "" },
    { [DEVICE_LEASE_PROOF_REFERENCE_ENV]: "relative/proof.json" },
  ]) {
    const h = harness();
    await assert.rejects(
      runHarness(h, { environment }),
      /inherited device lease proof reference is required/,
    );
    assert.deepEqual(h.events, [
      "artifact:start:/artifact.json",
      "artifact:flushed",
    ]);
    assert.equal(h.artifactWriter.artifact.ok, false);
  }
});

test("requires a safe configured target before device access", async () => {
  for (const target of [
    undefined,
    "",
    "  ",
    "--install",
    "host.invalid/path",
    "host name",
  ]) {
    const h = harness();
    await assert.rejects(
      runHarness(h, {
        target,
        environment: {
          [DEVICE_LEASE_PROOF_REFERENCE_ENV]: FIXTURE_PROOF_REFERENCE,
          [DEVICE_TEST_TARGET_ENV]: "",
        },
      }),
      /device test target/,
    );
    assert.deepEqual(h.events, [
      "artifact:start:/artifact.json",
      "artifact:flushed",
    ]);
  }
});

test("scrubs raw lease material from the spawned child environment", async () => {
  const h = harness();
  await runHarness(h, {
    environment: {
      SAFE_VALUE: "kept",
      [DEVICE_LEASE_PROOF_REFERENCE_ENV]: FIXTURE_PROOF_REFERENCE,
      JETKVM_DEVICE_LEASE_OWNER: "raw-owner",
      JETKVM_DEVICE_LEASE_TOKEN: "raw-token",
    },
  });

  assert.deepEqual(h.spawnCalls[0].options.environment, {
    SAFE_VALUE: "kept",
    [DEVICE_LEASE_PROOF_REFERENCE_ENV]: FIXTURE_PROOF_REFERENCE,
  });
});

test("parses the complete production identity and rejects incomplete or ambiguous metrics", () => {
  assert.deepEqual(parseDeviceIdentity(metrics()), {
    revision: "abc123",
    appVersion: "0.3.2",
    processStartTime: "1000.25",
  });

  const invalidMetrics = [
    ["", /build identity/],
    [
      'jetkvm_build_info{version="0.3.2"} 1\nprocess_start_time_seconds 1\n',
      /revision or version/,
    ],
    [
      'jetkvm_build_info{revision="abc123"} 1\nprocess_start_time_seconds 1\n',
      /revision or version/,
    ],
    [
      metrics().replace("process_start_time_seconds 1000.25", ""),
      /running-binary/,
    ],
    [metrics({ started: "not-a-number" }), /running-binary/],
    [`${metrics()}${metrics()}`, /ambiguous build identity/],
    [
      `${metrics()}process_start_time_seconds 1001\n`,
      /ambiguous running-binary process identity/,
    ],
  ];
  for (const [body, expected] of invalidMetrics) {
    assert.throws(() => parseDeviceIdentity(body), expected);
  }
});

test("fails closed on each exact production identity mismatch after flushing", async (t) => {
  const mismatches = [
    ["revision", metrics({ revision: "different" })],
    ["app version", metrics({ version: "0.3.3" })],
    ["running binary", metrics({ started: "1001.00" })],
  ];
  for (const [name, after] of mismatches) {
    await t.test(name, async () => {
      const h = harness({ after });
      await assert.rejects(runHarness(h), /production identity changed/);
      assert.equal(h.events.at(-1), "artifact:flushed");
      assert.equal(h.artifactWriter.artifact.ok, false);
      assert.notDeepEqual(
        h.artifactWriter.artifact.before,
        h.artifactWriter.artifact.after,
      );
    });
  }
});

test("reports a production replacement before a simultaneous child failure", async () => {
  const h = harness({
    after: metrics({ revision: "replaced" }),
    spawnResult: { code: 7, signal: null },
  });
  await assert.rejects(runHarness(h), /production identity changed/);
  assert.equal(
    h.artifactWriter.artifact.error.includes("exited with code"),
    false,
  );
  assert.equal(h.events.at(-1), "artifact:flushed");
});

test("preflight fetch, response, and parse failures never spawn and always flush", async (t) => {
  const failures = [
    ["fetch rejection", [new Error("fetch unavailable")], /fetch unavailable/],
    [
      "HTTP rejection",
      [response("unavailable", { ok: false, status: 503 })],
      /503/,
    ],
    [
      "missing body reader",
      [{ ok: true, status: 200 }],
      /did not provide a text body/,
    ],
    [
      "body rejection",
      [
        {
          ok: true,
          status: 200,
          text: async () => Promise.reject(new Error("body unavailable")),
        },
      ],
      /body unavailable/,
    ],
    [
      "parse rejection",
      [response("process_start_time_seconds 1000\n")],
      /build identity/,
    ],
  ];
  for (const [name, fetchSteps, expected] of failures) {
    await t.test(name, async () => {
      const h = harness({ fetchSteps });
      await assert.rejects(runHarness(h), expected);
      assert.equal(h.spawnCalls.length, 0);
      assert.equal(h.events.at(-1), "artifact:flushed");
      assert.equal(h.artifactWriter.artifact.ok, false);
    });
  }
});

test("spawn rejection fails closed without a postflight probe and flushes", async () => {
  const h = harness({ spawnError: new Error("spawn unavailable") });
  await assert.rejects(runHarness(h), /spawn unavailable/);
  assert.deepEqual(h.events, [
    `fetch:before:http://${FIXTURE_TARGET}/metrics`,
    `spawn:./dev_deploy.sh:-r ${FIXTURE_TARGET} --run-go-tests-only --device-tests-archive ${FIXTURE_DEVICE_TESTS} --device-tests-sha256 ${FIXTURE_DEVICE_TEST_SHA256}:/repo`,
    "artifact:start:/artifact.json",
    "artifact:flushed",
  ]);
});

test("postflight fetch and parse failures fail after spawn and flush", async (t) => {
  const failures = [
    [
      "fetch rejection",
      [response(metrics()), new Error("postflight unavailable")],
      /postflight unavailable/,
    ],
    [
      "HTTP rejection",
      [
        response(metrics()),
        response("unavailable", { ok: false, status: 502 }),
      ],
      /502/,
    ],
    [
      "body rejection",
      [
        response(metrics()),
        {
          ok: true,
          status: 200,
          text: async () => Promise.reject(new Error("post body unavailable")),
        },
      ],
      /post body unavailable/,
    ],
    [
      "parse rejection",
      [response(metrics()), response("invalid")],
      /build identity/,
    ],
  ];
  for (const [name, fetchSteps, expected] of failures) {
    await t.test(name, async () => {
      const h = harness({ fetchSteps });
      await assert.rejects(runHarness(h), expected);
      assert.equal(h.spawnCalls.length, 1);
      assert.equal(h.events.at(-1), "artifact:flushed");
      assert.equal(h.artifactWriter.artifact.ok, false);
    });
  }
});

test("rechecks unchanged identity before reporting every child failure", async (t) => {
  for (const [name, spawnResult, expected] of [
    ["exit code", { code: 7, signal: null }, /exited with code 7/],
    [
      "signal",
      { code: null, signal: "SIGTERM" },
      /terminated by signal SIGTERM/,
    ],
    ["null result", null, /invalid child result/],
    ["missing fields", {}, /invalid child result/],
    ["invalid exit code", { code: "0", signal: null }, /invalid child result/],
    ["invalid signal", { code: null, signal: 9 }, /invalid child result/],
    ["empty result", { code: null, signal: null }, /invalid child result/],
  ]) {
    await t.test(name, async () => {
      const h = harness({ spawnResult });
      await assert.rejects(runHarness(h), expected);
      assert.ok(h.events.some((event) => event.startsWith("fetch:after:")));
      assert.equal(h.events.at(-1), "artifact:flushed");
    });
  }
});

test("does not settle until artifact flush completes", async () => {
  let releaseFlush;
  let announceFlush;
  const flushStarted = new Promise((resolve) => {
    announceFlush = resolve;
  });
  const flushGate = new Promise((resolve) => {
    releaseFlush = resolve;
  });
  const h = harness();
  h.artifactWriter.writeAndFlush = async (artifactPath, artifact) => {
    h.events.push(`artifact:start:${artifactPath}`);
    h.artifactWriter.artifact = artifact;
    announceFlush();
    await flushGate;
    h.events.push("artifact:flushed");
  };

  let settled = false;
  const pending = runHarness(h).finally(() => {
    settled = true;
  });
  await flushStarted;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.events.at(-1), "artifact:start:/artifact.json");
  releaseFlush();
  await pending;
  assert.equal(settled, true);
  assert.equal(h.events.at(-1), "artifact:flushed");
});

test("artifact flush failure rejects an otherwise successful run", async () => {
  const h = harness({ flushError: new Error("flush unavailable") });
  await assert.rejects(runHarness(h), /flush unavailable/);
  assert.equal(h.events.at(-1), "artifact:start:/artifact.json");
});

test("redacts target, proof, and credential sentinels from persisted failures", async () => {
  const target = "sentinel-device.invalid";
  const proof = "/private/sentinel-proof.json";
  const credential = "sentinel-credential";
  const h = harness({
    spawnError: new Error(
      `spawn failed for ${target} using ${proof} and ${credential}`,
    ),
  });
  await assert.rejects(
    runHarness(h, {
      target,
      environment: {
        [DEVICE_LEASE_PROOF_REFERENCE_ENV]: proof,
        DEVICE_API_TOKEN: credential,
      },
    }),
    /spawn failed/,
  );

  const persistedEvidence = JSON.stringify(h.artifactWriter.artifact);
  assert.equal(persistedEvidence.includes(target), false);
  assert.equal(persistedEvidence.includes(proof), false);
  assert.equal(persistedEvidence.includes(credential), false);
  assert.deepEqual(h.artifactWriter.artifact.command, {
    executable: "./dev_deploy.sh",
    args: [
      "-r",
      "<configured-target>",
      "--run-go-tests-only",
      "--device-tests-archive",
      "<reviewed-device-tests>",
      "--device-tests-sha256",
      FIXTURE_DEVICE_TEST_SHA256,
    ],
  });
});

test("CLI output is status-only on success and failure", async () => {
  const sentinels = [
    "sentinel-device.invalid",
    "/private/sentinel-proof.json",
    "sentinel-credential",
  ];
  const secretText = sentinels.join(" ");
  const stdout = [];
  const stderr = [];
  const streams = {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  };

  assert.equal(
    await runDeviceGoTestsCli({
      ...streams,
      run: async () => ({ details: secretText }),
    }),
    0,
  );
  assert.deepEqual(stdout, [
    "Device Go tests passed; evidence artifact flushed.\n",
  ]);
  for (const sentinel of sentinels) {
    assert.equal(stdout.join("").includes(sentinel), false);
  }

  assert.equal(
    await runDeviceGoTestsCli({
      ...streams,
      run: async () => {
        throw new Error(secretText);
      },
    }),
    1,
  );
  assert.deepEqual(stderr, [
    "Device Go tests failed; evidence artifact flush attempted.\n",
  ]);
  for (const sentinel of sentinels) {
    assert.equal(
      `${stdout.join("")}${stderr.join("")}`.includes(sentinel),
      false,
    );
  }
});

test("preserves both the operation and artifact failures when flush also fails", async () => {
  const h = harness({
    fetchSteps: [new Error("metrics unavailable")],
    flushError: new Error("flush unavailable"),
  });
  await assert.rejects(runHarness(h), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(
      error.message,
      /device tests failed and artifact flush failed/,
    );
    assert.deepEqual(
      error.errors.map((entry) => entry.message),
      ["metrics unavailable", "flush unavailable"],
    );
    return true;
  });
});
