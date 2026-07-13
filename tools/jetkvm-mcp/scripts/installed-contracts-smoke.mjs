import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  prepareInstalledPackage,
  runInstalledModule,
  withInstalledPackage,
} from "./installed-smoke-support.mjs";

export async function runInstalledContractsSmoke({
  prepareInstalledPackageImpl = prepareInstalledPackage,
  runInstalledModuleImpl = runInstalledModule,
} = {}) {
  return withInstalledPackage(
    "contracts",
    async (installed) => {
      const result = await runInstalledModuleImpl(
        installed.consumer,
        "contracts-runner.mjs",
        `import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JETKVM_TOOL_NAMES } from "@wyrmkeep/jetkvm-mcp/dist/domain.js";
import { createMcpServer } from "@wyrmkeep/jetkvm-mcp/dist/mcp/server.js";
import { handlers, handlerCalls, validInputs } from "./deterministic-handlers.mjs";

const server = createMcpServer(handlers);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "installed-contract-smoke", version: "1.0.0" });
await client.connect(clientTransport);

const listed = await client.listTools();
assert.deepEqual(listed.tools.map((tool) => tool.name), JETKVM_TOOL_NAMES);
assert.equal(listed.tools.length, 10);
for (const tool of listed.tools) {
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.outputSchema.type, "object");
}
assert.match(
  JSON.stringify(listed.tools.find((tool) => tool.name === "jetkvm_input_mouse").inputSchema),
  /"not":\\{"const":0\\}/,
);
assert.match(
  JSON.stringify(listed.tools.find((tool) => tool.name === "jetkvm_input_paste").inputSchema),
  /"x-utf8-byte-max":262144/,
);

for (const name of JETKVM_TOOL_NAMES) {
  const result = await client.callTool({ name, arguments: validInputs[name] });
  if (name === "jetkvm_session_connect") {
    assert.equal(result.structuredContent.ok, true);
  } else {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
  }
}

await assert.rejects(
  client.callTool({
    name: "jetkvm_session_connect",
    arguments: { request_id: "invalid-timeout", timeout_ms: 99 },
  }),
  /Invalid arguments/,
);
assert.deepEqual(handlerCalls, Object.fromEntries(JETKVM_TOOL_NAMES.map((name) => [name, 1])));

await client.close();
console.log("installed contracts smoke ok");
`,
      );
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "installed contracts smoke ok\n");
    },
    { prepareInstalledPackageImpl },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runInstalledContractsSmoke();
}
