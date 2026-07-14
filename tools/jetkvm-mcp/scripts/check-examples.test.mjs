import test from "node:test";

import { runExampleCommand } from "./check-examples.mjs";

test("uses the child exit status when the child closes stdin early", async () => {
  await runExampleCommand(
    process.execPath,
    ["--eval", 'require("node:fs").closeSync(0); setTimeout(() => {}, 25);'],
    { input: "x".repeat(1024 * 1024) },
  );
});
