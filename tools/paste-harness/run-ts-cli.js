import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runTsCli(relativePath) {
  const cliPath = fileURLToPath(new URL(relativePath, import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}
