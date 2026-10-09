// @effect-diagnostics nodeBuiltinImport:off -- Tests own real loopback HTTP/WebSocket transports.
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import * as NodeEvents from "node:events";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import { SandboxIdeError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as TestClock from "effect/testing/TestClock";
import * as SandboxIde from "./SandboxIde.ts";
import * as Gateway from "./sandboxIdeHttp.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";

it.effect(
  "bridges browser WebSocket frames through a prefixed controller endpoint and fences identity changes",
  () =>
    Effect.gen(function* () {
      const upstream = NodeHttp.createServer();
      const sockets = new NodeSocket.NodeWS.WebSocketServer({ server: upstream });
      sockets.on("connection", (socket) =>
        socket.on("message", (message, binary) => socket.send(message, { binary })),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              for (const client of sockets.clients) client.terminate();
              sockets.close();
              upstream.close((error) => (error ? reject(error) : resolve()));
              upstream.closeAllConnections();
            }),
        ),
      );
      yield* Effect.promise(async () => {
        upstream.listen(0, "127.0.0.1");
        await NodeEvents.EventEmitter.once(upstream, "listening");
      });
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("Missing address");
      const identity: ExecutionIdentity = {
        workspaceId: "workspace",
        allocationId: "allocation",
        generation: 1,
        incarnation: "incarnation",
        podUid: "pod",
        protocolVersion: 1,
      };
      const token = "private-worker-token";
      const worker = yield* Effect.acquireRelease(
        Effect.promise(() =>
          listenWorker({
            host: "127.0.0.1",
            port: 0,
            handle: async () => new Response("control"),
            ide: {
              acquireLease: async () => () => {},
              url: `http://127.0.0.1:${address.port}`,
              identity,
              token,
            },
          }),
        ),
        (worker) => Effect.promise(worker.close),
      );
      const prefix = "/v1/execution/t3/workspace";
      const forwarded: string[] = [];
      const connections = new Set<NodeStream.Duplex>();
      const controller = NodeHttp.createServer((_request, response) =>
        response.writeHead(404).end(),
      );
      controller.on("upgrade", (request, socket, head) => {
        const path = request.url ?? "";
        forwarded.push(path);
        if (!path.startsWith(prefix + "/")) {
          socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
          return;
        }
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
        const outgoing = NodeHttp.request({
          hostname: "127.0.0.1",
          port: worker.port,
          path: path.slice(prefix.length),
          headers: request.headers,
        });
        outgoing.on("upgrade", (response, upstreamSocket, upstreamHead) => {
          connections.add(upstreamSocket);
          upstreamSocket.on("close", () => connections.delete(upstreamSocket));
          const headers: string[] = [];
          for (let index = 0; index < response.rawHeaders.length; index += 2)
            headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
          if (head.length) upstreamSocket.write(head);
          if (upstreamHead.length) socket.write(upstreamHead);
          upstreamSocket.pipe(socket).pipe(upstreamSocket);
          socket.on("error", () => upstreamSocket.destroy());
          upstreamSocket.on("error", () => socket.destroy());
        });
        outgoing.on("response", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
        outgoing.on("error", () => socket.destroy());
        outgoing.end();
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              for (const connection of connections) connection.destroy();
              controller.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
      yield* Effect.promise(async () => {
        controller.listen(0, "127.0.0.1");
        await NodeEvents.EventEmitter.once(controller, "listening");
      });
      const controllerAddress = controller.address();
      if (!controllerAddress || typeof controllerAddress === "string")
        throw new Error("Missing controller address");
      let replaced = false;
      const service = SandboxIde.SandboxIde.of({
        open: () => Effect.die("Unused"),
        authorize: () =>
          Effect.suspend(() =>
            replaced
              ? Effect.fail(new SandboxIdeError({ reason: "identity_changed" }))
              : Effect.succeed({
                  kind: "proxy",
                  access: {
                    endpoint: `http://127.0.0.1:${controllerAddress.port}${prefix}`,
                    identity,
                    token,
                  },
                }),
          ),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(
          Gateway.layer.pipe(
            Layer.provide(Layer.succeed(SandboxIde.SandboxIde, service)),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeSocket.layerWebSocketConstructorWS),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
      const socket = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new NodeSocket.NodeWS.WebSocket(`${origin}/api/sandbox-ide/session/`, {
              headers: { cookie: "t3_ide_session=scoped" },
            }),
        ),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      yield* Effect.promise(() => NodeEvents.EventEmitter.once(socket, "open"));
      const message = NodeEvents.EventEmitter.once(socket, "message");
      socket.send("editor frame");
      const [data] = yield* Effect.promise(() => message);
      expect(String(data)).toBe("editor frame");
      expect(forwarded).toEqual([`${prefix}/v1/ide/`]);
      const closed = NodeEvents.EventEmitter.once(socket, "close");
      replaced = true;
      yield* TestClock.adjust("5 seconds");
      yield* Effect.promise(() => closed);
    }),
);
