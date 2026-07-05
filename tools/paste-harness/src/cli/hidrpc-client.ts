import {
  DEFAULT_HIDRPC_DELAY_MS,
  DEFAULT_HIDRPC_TIMEOUT_MS,
  loadTextForHidRpc,
  runHidRpcText,
} from "../hidrpcClient.js";
import { loadRigEnv } from "../ssh.js";

import {
  failCli,
  optionalInteger,
  optionalString,
  parseArgs,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadRigEnv();
  const text = await loadTextForHidRpc({
    text: optionalString(args, "text"),
    textFile: optionalString(args, "text-file"),
  });

  const result = await runHidRpcText(env, text, {
    host: optionalString(args, "host") ?? env.KVM_PRIMARY,
    delayMs: optionalInteger(args, "delay-ms", DEFAULT_HIDRPC_DELAY_MS),
    timeoutMs: optionalInteger(args, "timeout-ms", DEFAULT_HIDRPC_TIMEOUT_MS),
    maxStepsPerReport: optionalInteger(args, "max-steps-per-report", 128),
    clearBefore: args.flags.has("clear"),
    saveAfter: args.flags.has("save"),
  });

  process.stdout.write(`${JSON.stringify({ ok: result.completed && !result.failed, ...result }, null, 2)}\n`);
  if (!result.completed || result.failed || !result.handshakeAck) {
    process.exit(1);
  }
}

main().catch(failCli);
