import assert from "node:assert/strict";
import test from "node:test";
import { validatePackReport } from "./check-package.mjs";

const requiredPaths = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "dist/deviceLeaseRunner.js",
];

function reportWith(...additionalPaths) {
  return [
    {
      files: [...requiredPaths, ...additionalPaths].map((path) => ({ path })),
    },
  ];
}

test("accepts only production dist, schema, and metadata files", () => {
  assert.doesNotThrow(() =>
    validatePackReport(
      reportWith("dist/deviceLease.js", "schemas/session-connect.schema.json"),
    ),
  );
});

test("rejects files outside the production allowlist", () => {
  assert.throws(
    () => validatePackReport(reportWith("scripts/check-package.mjs")),
    /outside the production allowlist: scripts\/check-package\.mjs/,
  );
});

for (const forbiddenPath of [
  "dist/deviceLease.test.js",
  "dist/fixtures/session.json",
  "dist/debug/controller.json",
  "dist/trace.json",
  "dist/.env",
  "dist/device-lease-proof.json",
  "schemas/client-secret.json",
]) {
  test(`rejects forbidden package path ${forbiddenPath}`, () => {
    assert.throws(
      () => validatePackReport(reportWith(forbiddenPath)),
      /forbidden production package path/,
    );
  });
}

test("rejects a missing required production file", () => {
  const report = reportWith();
  report[0].files = report[0].files.filter(
    ({ path }) => path !== "dist/deviceLeaseRunner.js",
  );
  assert.throws(
    () => validatePackReport(report),
    /missing required files: dist\/deviceLeaseRunner\.js/,
  );
});

test("rejects malformed npm pack output", () => {
  for (const malformed of [
    null,
    [],
    [{ files: null }],
    [{ files: [{ path: 1 }] }],
  ]) {
    assert.throws(
      () => validatePackReport(malformed),
      /invalid npm pack report/,
    );
  }
});
