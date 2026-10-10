// @effect-diagnostics nodeBuiltinImport:off -- Exercise the actual HTTP transport boundary.
import * as Http from "node:http";
import { afterEach, expect, test } from "@effect/vitest";
import {
  createExecutionClient,
  ExecutionOperationError,
  ExecutionTransportError,
} from "./ExecutionClient.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";

const identity: ExecutionIdentity = {
  allocationId: "a",
  podUid: "p",
  protocolVersion: 1,
  workspaceId: "w",
  generation: 1,
  incarnation: "i",
};
const servers: Http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function fixture(handle: Http.RequestListener, requestTimeoutMs = 1_000) {
  const server = Http.createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return createExecutionClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: "secret",
    identity,
    requestTimeoutMs,
  });
}

test("plaintext gateway failures become transport errors across every execution route", async () => {
  let requests = 0;
  const client = await fixture((_request, response) => {
    requests++;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("workspace unavailable with private upstream details");
  });
  for (const invoke of [
    () => client.call("preview.start", {}, "same-operation"),
    () => client.transient("fs.read", {}),
    () => client.operationStatus("same-operation"),
    () => client.inspectIdentity(),
    () => client.events(0),
    () => client.ack("session", 1),
  ]) {
    await expect(invoke()).rejects.toMatchObject({
      code: "unavailable",
      message: "Worker transport unavailable",
    });
  }
  expect(requests).toBe(6);
});

test("worker structured failures retain their operation code without retrying mutations", async () => {
  let requests = 0;
  const client = await fixture((_request, response) => {
    requests++;
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "stale_identity" }));
  });
  await expect(client.call("git.commit", {}, "persisted-id")).rejects.toBeInstanceOf(
    ExecutionOperationError,
  );
  await expect(client.transient("fs.read", {})).rejects.toMatchObject({ code: "stale_identity" });
  expect(requests).toBe(2);
});

test("invalid JSON and authorization responses are bounded transport failures", async () => {
  const client = await fixture((request, response) => {
    response.writeHead(request.url === "/v1/transient" ? 403 : 200);
    response.end("private invalid response");
  });
  await expect(client.call("preview.start", {})).rejects.toBeInstanceOf(ExecutionTransportError);
  await expect(client.transient("fs.read", {})).rejects.toMatchObject({ code: "authorization" });
});

test.each([false, true])(
  "deadline covers stalled headers and body (headers sent: %s) without replay",
  async (sendHeaders) => {
    let requests = 0;
    const client = await fixture((_request, response) => {
      requests++;
      if (sendHeaders) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"ok":true,"value":');
      }
    }, 100);
    await expect(client.call("git.commit", {}, "persisted-id")).rejects.toMatchObject({
      code: "timeout",
    });
    expect(requests).toBe(1);
  },
);
