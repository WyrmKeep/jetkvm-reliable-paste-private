import assert from "node:assert/strict";

import {
  prepareInstalledPackage,
  runInstalledModule,
} from "./installed-smoke-support.mjs";

const installed = await prepareInstalledPackage("sse");
try {
  const result = await runInstalledModule(
    installed.consumer,
    "sse-runner.mjs",
    `import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { DisposableSecret } from "@wyrmkeep/jetkvm-mcp/dist/browser/auth.js";
import { parseLegacySsePolicy } from "@wyrmkeep/jetkvm-mcp/dist/config.js";
import { LegacySseAdapter } from "@wyrmkeep/jetkvm-mcp/dist/mcp/legacySse.js";
import { handlers } from "./deterministic-handlers.mjs";
const observedContexts = [];
const auditedHandlers = Object.fromEntries(
  Object.entries(handlers).map(([name, handler]) => [
    name,
    async (input, context) => {
      observedContexts.push({ name, context });
      return handler(input, context);
    },
  ]),
);

const authority = "installed.mcp.test";
const origin = "https://installed-client.test";
const token = "installed-test-token";
const credential = {
  principalId: "installed-operator",
  secret: DisposableSecret.fromUtf8(token),
};
const policy = parseLegacySsePolicy({
  enabled: true,
  scheme: "http",
  bindHost: "0.0.0.0",
  allowNetworkExposure: true,
  allowPlaintextHttp: true,
  allowDangerousNetworkPlaintext: true,
  hostAuthorities: [authority],
  allowedOrigins: [origin],
  bearerEnvironmentVariable: "JETKVM_INSTALLED_TEST_BEARER",
});
const transportClosed = Promise.withResolvers();
const adapter = new LegacySseAdapter({
  handlerRegistry: auditedHandlers,
  securityPolicy: policy,
  bearerCredential: credential,
  onDiagnostic: (event) => {
    if (event.code === "transport_closed") transportClosed.resolve();
  },
});
const server = createServer((request, response) => {
  void adapter.handleRequest(request, response);
});
adapter.attachServer(server);
const listening = Promise.withResolvers();
server.once("listening", listening.resolve);
server.listen(0, policy.bindHost);
await listening.promise;
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const baseUrl = \`http://127.0.0.1:\${address.port}\`;

function headers() {
  return {
    Host: authority,
    Origin: origin,
    Authorization: \`Bearer \${token}\`,
    "X-JetKVM-CSRF": "1",
  };
}

async function request(path, { method = "GET", requestHeaders = {}, body = "" } = {}) {
  const url = new URL(\`\${baseUrl}\${path}\`);
  const ready = Promise.withResolvers();
  const outgoing = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: \`\${url.pathname}\${url.search}\`,
    method,
    headers: {
      ...requestHeaders,
      ...(body.length === 0 ? {} : { "Content-Length": String(Buffer.byteLength(body)) }),
    },
  });
  outgoing.once("response", ready.resolve);
  outgoing.once("error", ready.reject);
  outgoing.end(body);
  const response = await ready.promise;
  response.setEncoding("utf8");
  let text = "";
  for await (const chunk of response) text += chunk;
  return { status: response.statusCode, headers: response.headers, text };
}

function createFrameReader(response) {
  response.setEncoding("utf8");
  let buffer = "";
  const frames = [];
  const waiters = [];
  response.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const boundary = buffer.indexOf("\\n\\n");
      if (boundary < 0) break;
      const frame = \`\${buffer.slice(0, boundary)}\\n\\n\`;
      buffer = buffer.slice(boundary + 2);
      const resolve = waiters.shift();
      if (resolve) resolve(frame);
      else frames.push(frame);
    }
  });
  return async () => {
    const frame = frames.shift();
    if (frame !== undefined) return frame;
    const pending = Promise.withResolvers();
    waiters.push(pending.resolve);
    return pending.promise;
  };
}

async function openSse() {
  const ready = Promise.withResolvers();
  const outgoing = httpRequest(\`\${baseUrl}/sse\`, {
    method: "GET",
    headers: headers(),
  });
  outgoing.once("response", ready.resolve);
  outgoing.once("error", ready.reject);
  outgoing.end();
  const response = await ready.promise;
  const nextFrame = createFrameReader(response);
  const endpointFrame = await nextFrame();
  const match = /^event: endpoint\\ndata: (\\/messages\\?sessionId=[0-9a-f-]+)\\n\\n$/.exec(endpointFrame);
  if (!match?.[1]) throw new Error("Invalid endpoint frame");
  return { response, endpoint: match[1], endpointFrame, nextFrame };
}

const unauthorizedGet = await request("/sse", {
  requestHeaders: { Host: authority, Origin: origin, "X-JetKVM-CSRF": "1" },
});
assert.equal(unauthorizedGet.status, 401);
assert.equal(unauthorizedGet.text, "Unauthorized");
const forbiddenGet = await request("/sse", {
  requestHeaders: { ...headers(), Host: "attacker.test" },
});
assert.equal(forbiddenGet.status, 403);
assert.equal(forbiddenGet.text, "Forbidden");

const first = await openSse();
const second = await openSse();
assert.notEqual(first.endpoint, second.endpoint);
for (const stream of [first, second]) {
  assert.equal(stream.response.statusCode, 200);
  assert.equal(stream.response.headers["content-type"], "text/event-stream");
  assert.equal(stream.endpointFrame, \`event: endpoint\\ndata: \${stream.endpoint}\\n\\n\`);
}

const unauthorizedPost = await request(first.endpoint, {
  method: "POST",
  requestHeaders: {
    Host: authority,
    Origin: origin,
    "X-JetKVM-CSRF": "1",
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(unauthorizedPost.status, 401);

async function postMessage(stream, message) {
  return request(stream.endpoint, {
    method: "POST",
    requestHeaders: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

for (const [id, stream] of [[1, first], [101, second]]) {
  const initialized = await postMessage(stream, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: \`installed-sse-smoke-\${id}\`, version: "1.0.0" },
    },
  });
  assert.deepEqual(initialized, {
    status: 202,
    headers: initialized.headers,
    text: "Accepted",
  });
  const initializeFrame = await stream.nextFrame();
  assert.match(initializeFrame, new RegExp(\`^event: message\\\\ndata: {.*"id":\${id}}\\\\n\\\\n$\`));
}

const listedFirst = await postMessage(first, {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});
assert.equal(listedFirst.status, 202);
const firstListFrame = await first.nextFrame();
const firstListPayload = JSON.parse(firstListFrame.slice("event: message\\ndata: ".length, -2));
assert.equal(firstListPayload.result.tools.length, 10);

first.response.destroy();
await transportClosed.promise;
const closedFirst = await postMessage(first, {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/list",
  params: {},
});
assert.equal(closedFirst.status, 404);

const listedSecond = await postMessage(second, {
  jsonrpc: "2.0",
  id: 102,
  method: "tools/list",
  params: {},
});
assert.equal(listedSecond.status, 202);
const secondListFrame = await second.nextFrame();
const secondListPayload = JSON.parse(secondListFrame.slice("event: message\\ndata: ".length, -2));
assert.equal(secondListPayload.result.tools.length, 10);

const called = await postMessage(second, {
  jsonrpc: "2.0",
  id: 103,
  method: "tools/call",
  params: {
    name: "jetkvm_session_connect",
    arguments: { request_id: "success", timeout_ms: 100 },
  },
});
assert.equal(called.status, 202);
const callFrame = await second.nextFrame();
const callPayload = JSON.parse(callFrame.slice("event: message\\ndata: ".length, -2));
assert.equal(callPayload.result.structuredContent.operation_id, "operation-success");
const firstRoutingId = new URL(first.endpoint, baseUrl).searchParams.get("sessionId");
const secondRoutingId = new URL(second.endpoint, baseUrl).searchParams.get("sessionId");
const applicationSessionId = callPayload.result.structuredContent.session_id;
assert.notEqual(applicationSessionId, firstRoutingId);
assert.notEqual(applicationSessionId, secondRoutingId);

assert.equal(observedContexts.length, 1);
const [{ context }] = observedContexts;
assert.deepEqual(Object.keys(context).sort(), ["correlationId", "principalId", "signal"]);
assert.equal(context.principalId, "installed-operator");
assert.match(context.correlationId, /^mcp-[a-f0-9]{32}$/);
assert.notEqual(context.correlationId, firstRoutingId);
assert.notEqual(context.correlationId, secondRoutingId);
assert.doesNotMatch(
  JSON.stringify(context),
  /authInfo|requestInfo|sessionId|authorization|bearer|csrf|installed-test-token/i,
);

const invalidJson = await request(second.endpoint, {
  method: "POST",
  requestHeaders: { ...headers(), "Content-Type": "application/json" },
  body: "{",
});
assert.equal(invalidJson.status, 400);
assert.equal(invalidJson.text, "Invalid JSON");

second.response.destroy();
await adapter.close();
credential.secret.dispose();
const closed = Promise.withResolvers();
server.close(closed.resolve);
await closed.promise;
console.log("installed SSE protocol smoke ok");
`,
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "installed SSE protocol smoke ok\n");
} finally {
  await installed.cleanup();
}
