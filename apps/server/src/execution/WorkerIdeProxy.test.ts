// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Tests exercise real streaming Node HTTP and WebSocket boundaries.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { afterEach, expect, it } from "vite-plus/test";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { listenWorker } from "./WorkerHttpServer.ts";
import { ideIdentityHeader } from "./WorkerIdeProxy.ts";

const identity: ExecutionIdentity = {
  workspaceId: "one",
  allocationId: "allocation",
  incarnation: "incarnation",
  generation: 1,
  podUid: "pod",
  protocolVersion: 1,
};
const token = "worker-secret-never-for-the-browser";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.toReversed()) await close();
  cleanups.length = 0;
});
async function fixture(
  acquireLease: () => Promise<(() => void) | undefined> = async () => () => {},
) {
  const seen: Array<NodeHttp.IncomingHttpHeaders> = [];
  const server = NodeHttp.createServer((request, response) => {
    seen.push(request.headers);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/login" }).end();
      return;
    }
    request.pipe(response);
  });
  const sockets = new NodeWS.WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    seen.push(request.headers);
    socket.on("message", (message, binary) => socket.send(message, { binary }));
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  cleanups.push(
    () =>
      new Promise((resolve, reject) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const worker = await listenWorker({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1,
    handle: async () => new Response("control"),
    ide: {
      acquireLease,
      url: `http://127.0.0.1:${address.port}`,
      identity,
      token,
    },
  });
  cleanups.push(worker.close);
  return {
    url: `http://127.0.0.1:${worker.port}/v1/ide/`,
    seen,
    headers: {
      authorization: `Bearer ${token}`,
      [ideIdentityHeader]: JSON.stringify(identity),
      cookie: "central=secret",
      "x-t3-ide-base": "/api/sandbox-ide/session/",
    },
  };
}
it("streams IDE bodies outside the buffered control limit and removes credentials", async () => {
  const fixtureResult = await fixture();
  const body = "workspace-file-content".repeat(100_000);
  const response = await fetch(fixtureResult.url, {
    method: "POST",
    headers: fixtureResult.headers,
    body,
  });
  expect(await response.text()).toBe(body);
  expect(fixtureResult.seen[0]?.authorization).toBeUndefined();
  expect(fixtureResult.seen[0]?.cookie).toBeUndefined();
  expect(fixtureResult.seen[0]?.[ideIdentityHeader]).toBeUndefined();
  const redirect = await fetch(`${fixtureResult.url}redirect`, {
    headers: fixtureResult.headers,
    redirect: "manual",
  });
  expect(redirect.headers.get("location")).toBe("/api/sandbox-ide/session/login");
});
it("rejects missing auth and every replaced execution identity before forwarding", async () => {
  const { url, headers, seen } = await fixture();
  expect((await fetch(url)).status).toBe(401);
  for (const replacement of [
    { ...identity, workspaceId: "two" },
    { ...identity, allocationId: "other" },
    { ...identity, generation: 2 },
    { ...identity, incarnation: "other" },
    { ...identity, podUid: "other" },
  ])
    expect(
      (
        await fetch(url, {
          headers: { ...headers, [ideIdentityHeader]: JSON.stringify(replacement) },
        })
      ).status,
    ).toBe(409);
  expect(seen).toHaveLength(0);
});
it("streams authenticated WebSocket frames through the worker", async () => {
  const { url, headers, seen } = await fixture();
  const socket = new NodeWS.WebSocket(url.replace("http:", "ws:"), { headers });
  try {
    await NodeEvents.EventEmitter.once(socket, "open");
    const message = NodeEvents.EventEmitter.once(socket, "message");
    socket.send("editor frame");
    const [data] = await message;
    expect(String(data)).toBe("editor frame");
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.cookie).toBeUndefined();
  } finally {
    socket.terminate();
  }
});

it("rejects new IDE traffic after quiescence and releases WebSocket activity on disconnect", async () => {
  let quiesced = false;
  let leases = 0;
  const released = Promise.withResolvers<void>();
  const { url, headers, seen } = await fixture(async () => {
    if (quiesced) return undefined;
    leases++;
    return () => {
      leases--;
      released.resolve();
    };
  });
  const socket = new NodeWS.WebSocket(url.replace("http:", "ws:"), { headers });
  await NodeEvents.EventEmitter.once(socket, "open");
  expect(leases).toBe(1);
  socket.terminate();
  await released.promise;
  expect(leases).toBe(0);
  quiesced = true;
  expect((await fetch(url, { headers })).status).toBe(409);
  expect(seen).toHaveLength(1);
});
