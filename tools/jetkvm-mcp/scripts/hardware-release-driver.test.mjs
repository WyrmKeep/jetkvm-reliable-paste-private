import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  InstalledMcpClient,
  LiveStepBindings,
  assertPrivateEnvironmentFile,
  assertHardwareCallExpectation,
  compareSafeBaselines,
  createLiveHardwareDriver,
  finalizeLiveHardwareResources,
  powerActionRequiresOfflineWait,
  sanitizeToolEvidence,
  verifyInstalledPackageIdentity,
} from "./hardware-release-driver.mjs";
import {
  buildDirectoryManifest,
  buildReleaseCandidateManifest,
  isGeneratedInstalledBinLink,
  sha256Canonical,
  sha256File,
} from "./release-evidence.mjs";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function successResult(overrides = {}) {
  return {
    content: [{ type: "text", text: "not persisted" }],
    structuredContent: {
      ok: true,
      tool: "jetkvm_input_keyboard",
      operation_id: "secret-operation-id",
      session_id: "secret-session-id",
      session_generation: 9,
      duration_ms: 4,
      result: {
        request_id: "secret-request-id",
        outcome: "applied",
        verification: "device_ack_only",
        required_next_step: "none",
        dispatched_action_count: 2,
        completed_action_count: 2,
      },
      ...overrides,
    },
  };
}

test("sanitizes MCP results to hashes, bounded facts, and image digests", () => {
  const imageBytes = Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from("private-image"),
  ]);
  const result = successResult();
  result.content.push({
    type: "image",
    mimeType: "image/png",
    data: imageBytes.toString("base64"),
  });
  const evidence = sanitizeToolEvidence(result);
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.dispatched_action_count, 2);
  assert.equal(evidence.images[0].byte_length, imageBytes.byteLength);
  assert.match(evidence.images[0].sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(serialized, /secret|not persisted|private-image/u);
});

test("requires the exact nonempty image declared by display capture", () => {
  const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("real-screenshot")]);
  const data = bytes.toString("base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const structuredContent = {
    ok: true,
    tool: "jetkvm_display_capture",
    session_generation: 1,
    result: {
      image: {
        content_index: 1,
        mime_type: "image/png",
        byte_length: bytes.byteLength,
        sha256,
      },
    },
  };
  assert.throws(
    () =>
      sanitizeToolEvidence({
        content: [{ type: "text", text: "{}" }],
        structuredContent,
      }),
    /omitted its exact declared screenshot/u,
  );
  const evidence = sanitizeToolEvidence({
    content: [
      { type: "text", text: "{}" },
      { type: "image", mimeType: "image/png", data },
    ],
    structuredContent,
  });
  assert.equal(evidence.images[0].content_index, 1);
  assert.equal(evidence.images[0].sha256, sha256);
  assert.equal(
    evidence.structured_sha256,
    sha256Canonical(evidence.structured),
  );
  assert.throws(
    () =>
      sanitizeToolEvidence({
        content: [
          { type: "text", text: "{}" },
          { type: "image", mimeType: "image/png", data: "not-base64" },
        ],
        structuredContent,
      }),
    /strict nonempty base64/u,
  );
});

test("refuses an ATX power pulse when host reachability is unknown", async () => {
  const calls = [];
  const driver = createLiveHardwareDriver({
    mcp: {
      call: async (...args) => {
        calls.push(args);
        throw new Error("must not call MCP");
      },
    },
    rig: {
      hostPowerState: async () => "unknown",
    },
    candidate: {
      source: { commit_sha: "a".repeat(40) },
      runtime: { browser: {} },
    },
    runId: "unknown-power",
    executionResolver: () => [],
    controlledExecution: {},
  });
  await assert.rejects(
    driver.captureBaseline({}, "before"),
    /power state is unknown; refusing to pulse/u,
  );
  assert.deepEqual(calls, []);
});

test("closes a partially started MCP child when tool listing fails", async () => {
  const stderr = new EventEmitter();
  let transportCloseCount = 0;
  let clientCloseCount = 0;
  let transportCreateCount = 0;
  const client = new InstalledMcpClient({
    command: "unused",
    transportFactory: () => {
      transportCreateCount += 1;
      return {
        stderr,
        close: async () => {
          transportCloseCount += 1;
        },
      };
    },
    clientFactory: () => ({
      connect: async () => undefined,
      listTools: async () => {
        throw new Error("listing failed");
      },
      close: async () => {
        clientCloseCount += 1;
      },
    }),
  });

  await assert.rejects(client.start(), /listing failed/u);
  assert.equal(clientCloseCount, 1);
  assert.equal(transportCloseCount, 1);
  await assert.rejects(client.call("unused", {}), /not running/u);
  await assert.rejects(client.start(), /listing failed/u);
  assert.equal(transportCreateCount, 2);
});

test("verifies the shipped consumer lock and complete installed tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-installed-closure-"));
  const installationRoot = join(root, "installation");
  const packagePath = join(
    installationRoot,
    "node_modules",
    "@wyrmkeep",
    "jetkvm-mcp",
  );
  const candidateDirectory = join(root, "candidate");
  try {
    await mkdir(join(packagePath, "dist", "stories"), { recursive: true });
    await mkdir(join(packagePath, "schemas"), { recursive: true });
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(
      join(packagePath, "package.json"),
      `${JSON.stringify({
        name: "@wyrmkeep/jetkvm-mcp",
        version: "0.1.0",
      })}\n`,
    );
    for (let index = 1; index <= 24; index += 1) {
      await writeFile(
        join(
          packagePath,
          "dist",
          "stories",
          `${String(index).padStart(2, "0")}.json`,
        ),
        `${JSON.stringify({ index })}\n`,
      );
    }
    for (let index = 1; index <= 21; index += 1) {
      await writeFile(
        join(packagePath, "schemas", `${index}.json`),
        `${JSON.stringify({ index })}\n`,
      );
    }
    const consumerPackage = {
      name: "jetkvm-mcp-release-consumer",
      version: "1.0.0",
      private: true,
      dependencies: {
        "@wyrmkeep/jetkvm-mcp": "file:./candidate.tgz",
      },
    };
    const consumerLock = {
      name: consumerPackage.name,
      version: consumerPackage.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": consumerPackage,
        "node_modules/@wyrmkeep/jetkvm-mcp": {
          version: "0.1.0",
          resolved: "file:candidate.tgz",
        },
      },
    };
    const consumerPackageText = `${JSON.stringify(consumerPackage, null, 2)}\n`;
    const consumerLockText = `${JSON.stringify(consumerLock, null, 2)}\n`;
    await Promise.all([
      writeFile(join(installationRoot, "package.json"), consumerPackageText),
      writeFile(join(installationRoot, "package-lock.json"), consumerLockText),
      writeFile(
        join(candidateDirectory, "consumer-package.json"),
        consumerPackageText,
      ),
      writeFile(
        join(candidateDirectory, "consumer-package-lock.json"),
        consumerLockText,
      ),
    ]);
    const [packageTree, installationTree, stories, schemas] = await Promise.all(
      [
        buildDirectoryManifest(packagePath),
        buildDirectoryManifest(join(installationRoot, "node_modules"), {
          excludeSymlink: isGeneratedInstalledBinLink,
        }),
        buildDirectoryManifest(join(packagePath, "dist", "stories")),
        buildDirectoryManifest(join(packagePath, "schemas")),
      ],
    );
    const candidate = buildReleaseCandidateManifest({
      packageName: "@wyrmkeep/jetkvm-mcp",
      packageVersion: "0.1.0",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      packageLockSha256: "c".repeat(64),
      storyManifestSha256: stories.sha256,
      storyCount: 24,
      schemasSha256: schemas.sha256,
      schemaCount: 21,
      pasteHarnessSha256: "c".repeat(64),
      branchMatrixSha256: "d".repeat(64),
      storyE2eSha256: "e".repeat(64),
      controlledEvidenceSha256: "f".repeat(64),
      nodeVersion: "v22.23.1",
      nodeExecutableName: "node",
      nodeExecutableSha256: "1".repeat(64),
      platform: "darwin",
      architecture: "arm64",
      browserExecutableName: "Google Chrome",
      browserExecutableSha256: "2".repeat(64),
      browserHeadless: false,
      browserChromiumSandbox: true,
      browserLaunchArgs: [],
      browserTargetUrlSha256: "3".repeat(64),
      browserCredentialSource: "environment",
      browserManagedProfile: "ephemeral",
      artifactFilename: "candidate.tgz",
      artifactSizeBytes: 1,
      artifactSha256: "4".repeat(64),
      packageFiles: packageTree.files,
      consumerPackageJsonSha256: await sha256File(
        join(installationRoot, "package.json"),
      ),
      consumerPackageLockSha256: await sha256File(
        join(installationRoot, "package-lock.json"),
      ),
      productionResolutionSha256: sha256Canonical([]),
      installationFiles: installationTree.files,
    });

    const identity = await verifyInstalledPackageIdentity(
      candidate,
      packagePath,
      { installationRoot, candidateDirectory },
    );
    assert.equal(
      identity.node_modules_tree_sha256,
      candidate.installation.node_modules_tree_sha256,
    );
    await writeFile(join(installationRoot, "node_modules", "drift.txt"), "x");
    await assert.rejects(
      verifyInstalledPackageIdentity(candidate, packagePath, {
        installationRoot,
        candidateDirectory,
      }),
      /node_modules tree/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds duplicate request IDs to their first session and observation", () => {
  const bindings = new LiveStepBindings("run-1");
  const firstState = {
    session: { id: "session-a", generation: 7 },
    observation: { id: "observation-a" },
  };
  const step = {
    id: "duplicate-initial",
    input: {
      request_id: "opaque-request",
      session_id: "opaque-session",
      session_generation: 1,
      observation_id: "opaque-observation",
      timeout_ms: 1000,
    },
  };
  const first = bindings.adapt(step, firstState);
  const second = bindings.adapt(
    {
      ...step,
      id: "duplicate-same",
      input: { ...step.input, timeout_ms: 1000 },
    },
    {
      session: { id: "session-b", generation: 8 },
      observation: { id: "observation-b" },
    },
  );
  assert.equal(second.request_id, first.request_id);
  assert.equal(second.session_id, "session-a");
  assert.equal(second.session_generation, 7);
  assert.equal(second.observation_id, "observation-a");
  assert.equal(first.timeout_ms, 30_000);
  const changed = bindings.adapt(
    {
      ...step,
      id: "duplicate-changed",
      input: { ...step.input, timeout_ms: 2000 },
    },
    firstState,
  );
  assert.equal(changed.timeout_ms, 30_001);
});

test("binds every canonical stale story step to the intended session", async () => {
  const staleGenerationIds = new Set([
    "inspect-old-generation",
    "input-with-stale-generation",
    "stale-keyboard-generation",
    "stale-power-generation",
    "stale-keyboard-generation-jetkvm-display-capture",
    "stale-keyboard-generation-jetkvm-display-status",
    "stale-keyboard-generation-jetkvm-input-keyboard",
    "stale-keyboard-generation-jetkvm-input-mouse",
    "stale-keyboard-generation-jetkvm-input-paste",
    "stale-keyboard-generation-jetkvm-input-release",
    "stale-keyboard-generation-jetkvm-power-control",
    "stale-keyboard-generation-jetkvm-session-reconnect",
    "stale-keyboard-generation-jetkvm-session-status",
  ]);
  const staleAgeIds = new Set([
    "capture-stale-age-observation",
    "reject-stale-age-observation",
  ]);
  const storyDirectory = join(packageRoot, "src", "stories");
  const stories = await Promise.all(
    (await readdir(storyDirectory))
      .filter((name) => /^\d{2}-.*\.json$/u.test(name))
      .map((name) =>
        readFile(join(storyDirectory, name), "utf8").then(JSON.parse),
      ),
  );
  const relevantSteps = stories
    .flatMap((story) => story.steps)
    .filter(
      (step) => staleGenerationIds.has(step.id) || staleAgeIds.has(step.id),
    );
  assert.deepEqual(
    new Set(relevantSteps.map((step) => step.id)),
    new Set([...staleGenerationIds, ...staleAgeIds]),
  );
  const state = {
    session: { id: "session-current", generation: 9 },
    previousSession: { id: "session-previous", generation: 8 },
    observation: { id: "observation-current" },
    previousObservation: { id: "observation-previous" },
  };
  for (const step of relevantSteps) {
    const adapted = new LiveStepBindings(`run-${step.id}`).adapt(step, state);
    if (staleGenerationIds.has(step.id)) {
      assert.equal(adapted.session_id, "session-previous", step.id);
      assert.equal(adapted.session_generation, 8, step.id);
    } else {
      assert.equal(adapted.session_id, "session-current", step.id);
      assert.equal(adapted.session_generation, 9, step.id);
    }
    if (Object.hasOwn(adapted, "observation_id")) {
      assert.equal(adapted.observation_id, "observation-current", step.id);
    }
  }
});

test("accepts protocol schema rejection and named public errors only", () => {
  assert.doesNotThrow(() =>
    assertHardwareCallExpectation(
      {
        id: "reject-zero-scroll",
        expect: "The whole request is schema-rejected.",
      },
      undefined,
      Object.assign(new Error("Invalid params"), { code: -32602 }),
    ),
  );
  assert.doesNotThrow(() =>
    assertHardwareCallExpectation(
      {
        id: "inspect-old-generation",
        expect: "The old generation is taken_over.",
      },
      { ok: false, error: { code: "SESSION_TAKEN_OVER" } },
      undefined,
    ),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(
      { id: "unexpected", expect: "success" },
      { ok: false, error: { code: "CONTROL_BUSY" } },
      undefined,
    ),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(
      {
        id: "reject-zero-scroll",
        expect: "The whole request is schema-rejected.",
      },
      undefined,
      new Error("Timed out"),
    ),
  );
});

test("requires fresh mutations to return correlated applied verification", () => {
  const step = {
    id: "fresh-keyboard",
    tool: "jetkvm_input_keyboard",
    input: { request_id: "request-current" },
    expect: "applied",
  };
  assert.throws(() =>
    assertHardwareCallExpectation(step, {
      ok: true,
      result: {
        request_id: "request-current",

        outcome: "already_applied",
        verification: "device_ack_only",
      },
    }),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(step, {
      ok: true,
      result: {
        request_id: "request-other",
        outcome: "applied",
        verification: "device_ack_only",
      },
    }),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(step, {
      ok: true,
      result: {
        request_id: "request-current",
        outcome: "applied",
        verification: "none",
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertHardwareCallExpectation(step, {
      ok: true,
      result: {
        request_id: "request-current",
        outcome: "applied",
        verification: "device_ack_only",
      },
    }),
  );
});

test("waits for both semantic power-off actions", () => {
  assert.equal(powerActionRequiresOfflineWait("press_power"), true);
  assert.equal(powerActionRequiresOfflineWait("hold_power"), true);
  assert.equal(powerActionRequiresOfflineWait("press_reset"), false);
});
test("races release against keyboard, pointer, wheel, and paste producers", async () => {
  const calls = [];
  const producers = [];
  let observation = 0;
  const mcp = {
    async call(name, input) {
      calls.push(name);
      if (name === "jetkvm_display_capture") {
        observation += 1;
        return {
          raw: {
            ok: true,
            result: { observation_id: `observation-${observation}` },
          },
          evidence: { capture: observation },
        };
      }
      if (
        name === "jetkvm_input_keyboard" &&
        input.actions.length === 1 &&
        input.actions[0].type === "key_down"
      ) {
        return { raw: { ok: true }, evidence: { held: true } };
      }
      if (
        name === "jetkvm_input_keyboard" ||
        name === "jetkvm_input_mouse" ||
        name === "jetkvm_input_paste"
      ) {
        const deferred = Promise.withResolvers();
        producers.push({ name, deferred });
        return deferred.promise;
      }
      assert.equal(name, "jetkvm_input_release");
      for (const producer of producers) {
        producer.deferred.resolve({
          raw:
            producer.name === "jetkvm_input_paste"
              ? { ok: false, error: { code: "PASTE_CANCELLED" } }
              : { ok: false, error: { code: "SESSION_DRAINED" } },
          evidence: { producer: producer.name },
        });
      }
      return {
        raw: {
          ok: true,
          result: {
            request_id: input.request_id,
            outcome: "applied",
            verification: "device_ack_only",
            mutation_gate_closed: true,
            deferred_producers_joined: true,
            paste_terminal: "cancelled",
            ordinary_leases_zero: true,
            keyboard_zero: true,
            pointer_zero: true,
            generation_drained: true,
          },
        },
        evidence: { release: true },
      };
    },
  };
  const rig = {
    pinUkLayout: async () => undefined,
    resetNotepad: async () => undefined,
  };
  const driver = createLiveHardwareDriver({
    mcp,
    rig,
    candidate: {
      source: { commit_sha: "a".repeat(40) },
      runtime: { browser: { executable_sha256: "b".repeat(64) } },
    },
    runId: "run-release-race",
    executionResolver: () => [],
    controlledExecution: {},
  });
  driver.state.session = { id: "session-race", generation: 7 };
  const result = await driver.executeHardwareStep(
    { id: "emergency-release-races-every-writer" },
    {
      id: "release-all-input",
      tool: "jetkvm_input_release",
      input: {
        session_id: "placeholder",
        session_generation: 0,
        request_id: "release-race-request",
        timeout_ms: 30_000,
      },
      timeout_ms: 30_000,
      expect: "applied",
    },
  );

  assert.equal(result.result, "pass");
  assert.deepEqual(
    producers.map(({ name }) => name),
    [
      "jetkvm_input_keyboard",
      "jetkvm_input_mouse",
      "jetkvm_input_mouse",
      "jetkvm_input_paste",
    ],
  );
  assert.equal(driver.state.emergencyProducers, undefined);
  assert.equal(
    calls.filter((name) => name === "jetkvm_display_capture").length,
    5,
  );
});

test("finalizes with producer-zero release and the original safe baseline", async () => {
  const releaseResult = {
    mutation_gate_closed: true,
    deferred_producers_joined: true,
    paste_terminal: "inactive",
    ordinary_leases_zero: true,
    keyboard_zero: true,
    pointer_zero: true,
    generation_drained: true,
  };
  const calls = [];
  const mcp = {
    async call(name) {
      calls.push(name);
      if (name === "jetkvm_session_connect") {
        return {
          raw: {
            ok: true,
            session_id: "session-final",
            session_generation: 2,
          },
          evidence: { connect: true },
        };
      }
      if (name === "jetkvm_session_reconnect") {
        return {
          raw: {
            ok: true,
            session_id: "session-final",
            session_generation: 3,
            result: {
              outcome: "applied",
              new_session_generation: 3,
              fresh_capture_required: true,
            },
          },
          evidence: { reconnect: true },
        };
      }
      if (name === "jetkvm_session_status") {
        return {
          raw: {
            ok: true,
            result: {
              native_capture_facts: {
                signal: { value: "present" },
                resolution: { value: "1920x1080" },
              },
              hid: "ready",
              decoded_video: "ready",
              web_rtc: "ready",
              rpc_reachability: "ready",
            },
          },
          evidence: { status: true },
        };
      }
      if (name === "jetkvm_display_capture") {
        return {
          raw: {
            ok: true,
            result: {
              observation_id: "observation-final",
              source_width: 1920,
              source_height: 1080,
              image_width: 1920,
              image_height: 1080,
              rotation: 0,
            },
          },
          evidence: { capture: true },
        };
      }
      assert.equal(name, "jetkvm_input_release");
      return {
        raw: { ok: true, result: releaseResult },
        evidence: { release: true },
      };
    },
  };
  const windows = {
    layout: { klid: "00000809" },
    lock_keys: { caps: false, num: true, scroll: false },
    fixture: { sha256: "c".repeat(64) },
    host_online: true,
  };
  const rig = {
    hostPowerState: async () => "online",
    pinUkLayout: async () => undefined,
    resetNotepad: async () => undefined,
    captureSafeBaselineFacts: async () => windows,
  };
  const candidate = {
    source: { commit_sha: "a".repeat(40) },
    runtime: { browser: { executable_sha256: "b".repeat(64) } },
  };
  const driver = createLiveHardwareDriver({
    mcp,
    rig,
    candidate,
    runId: "run-finalize",
    executionResolver: () => [],
    controlledExecution: {},
  });
  driver.state.session = { id: "session-before", generation: 1 };
  driver.state.atxProof = { extension: true, serial_ready: true };
  driver.state.baseline = {
    candidate_revision: candidate.source.commit_sha,
    display: {
      source_width: 1920,
      source_height: 1080,
      image_width: 1920,
      image_height: 1080,
      rotation: 0,
      signal: "present",
      resolution: "1920x1080",
      hid: "ready",
      decoded_video: "ready",
      web_rtc: "ready",
      rpc_reachability: "ready",
    },
    layout: windows.layout,
    lock_keys: windows.lock_keys,
    atx: driver.state.atxProof,
    browser: candidate.runtime.browser,
    fixture: windows.fixture,
    host_online: true,
    held_input: { keys: 0, buttons: 0 },
    session_generation: 1,
  };

  const result = await driver.finalizeRun();

  assert.equal(result.result, "pass");
  assert.equal(driver.state.safeBaselineProven, true);
  assert.deepEqual(calls, [
    "jetkvm_input_release",
    "jetkvm_session_connect",
    "jetkvm_session_reconnect",
    "jetkvm_session_status",
    "jetkvm_display_capture",
    "jetkvm_input_release",
  ]);
});

test("records failed finalization after attempting every transport close", async () => {
  const closed = [];
  const driver = {
    state: { safeBaselineProven: false },
    finalizeRun: async () => {
      throw new Error("release failed");
    },
  };
  const result = await finalizeLiveHardwareResources({
    driver,
    clients: [
      {
        label: "replacement",
        client: {
          close: async () => {
            closed.push("replacement");
            return true;
          },
          stderrEvidence: () => ({ byte_length: 0, sha256: "a".repeat(64) }),
        },
      },
      {
        label: "initial",
        client: {
          close: async () => {
            closed.push("initial");
            throw new Error("close failed");
          },
          stderrEvidence: () => ({ byte_length: 0, sha256: "b".repeat(64) }),
        },
      },
    ],
    now: () => new Date("2026-07-14T00:00:00.000Z"),
  });

  assert.deepEqual(closed, ["replacement", "initial"]);
  assert.equal(result.record.result, "fail");
  assert.equal(result.record.safe_baseline_proven, false);
  assert.equal(result.record.manual_recovery_required, true);
  assert.equal(result.record.failure_count, 3);
  assert.equal(result.failures.length, 3);
});

test("does not demand recovery when finalization precedes device contact", async () => {
  const result = await finalizeLiveHardwareResources({
    driver: undefined,
    clients: [],
    hardwareTouched: false,
  });

  assert.equal(result.record.result, "pass");
  assert.equal(result.record.manual_recovery_required, false);
  assert.equal(result.failures.length, 0);
});

test("compares every safe baseline field and permits generation advance", () => {
  const baseline = {
    candidate_revision: "a".repeat(40),
    display: { width: 1920, height: 1080 },
    layout: { klid: "00000809" },
    lock_keys: { caps: false, num: true, scroll: false },
    atx: { extension: true, serial_ready: true },
    browser: { executable_sha256: "b".repeat(64) },
    fixture: { sha256: "c".repeat(64) },
    host_online: true,
    held_input: { keys: 0, buttons: 0 },
    session_generation: 7,
  };
  const restored = structuredClone(baseline);
  restored.session_generation = 8;
  assert.equal(compareSafeBaselines(baseline, restored).result, "pass");
  restored.lock_keys.caps = true;
  assert.throws(() => compareSafeBaselines(baseline, restored), /lock_keys/u);
});

test("rejects group-readable protected environment files", () => {
  assert.doesNotThrow(() =>
    assertPrivateEnvironmentFile({ mode: 0o100600 }, "safe"),
  );
  assert.throws(
    () => assertPrivateEnvironmentFile({ mode: 0o100640 }, "unsafe"),
    /owner-only/u,
  );
});
