import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeviceReleaseProvenance,
  validateDeviceReleaseProvenance,
} from "./device-release-provenance.mjs";

const COMMIT = "a".repeat(40);

test("binds a CI-built device binary to its exact source commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-device-provenance-"));
  const binaryPath = join(directory, "jetkvm_app");
  const deviceTestsPath = join(directory, "device-tests.tar.gz");
  try {
    await writeFile(binaryPath, "device-binary");
    await writeFile(deviceTestsPath, "device-tests");
    const provenance = await createDeviceReleaseProvenance({
      binaryPath,
      deviceTestsPath,
      sourceCommit: COMMIT,
      repository: "WyrmKeep/jetkvm-reliable-paste-private",
      workflowRef:
        "WyrmKeep/jetkvm-reliable-paste-private/.github/workflows/build.yml@refs/heads/release",
      runId: "123456",
      runAttempt: 1,
    });

    const validated = validateDeviceReleaseProvenance(provenance, {
      source: { commit_sha: COMMIT },
    });
    assert.equal(validated.binary.filename, "jetkvm_app");
    assert.match(validated.binary.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(validated.device_tests.filename, "device-tests.tar.gz");
    assert.match(validated.device_tests.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(validated.builder.run_id, "123456");

    assert.throws(
      () =>
        validateDeviceReleaseProvenance(provenance, {
          source: { commit_sha: "b".repeat(40) },
        }),
      /did not match the candidate/u,
    );
    assert.throws(
      () =>
        validateDeviceReleaseProvenance(
          {
            ...provenance,
            unexpected: true,
          },
          { source: { commit_sha: COMMIT } },
        ),
      /fields are invalid/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
