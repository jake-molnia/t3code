// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Gateway integration test owns a loopback worker fixture.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { SandboxIdeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import { expect, it } from "vite-plus/test";
import * as SandboxIde from "./SandboxIde.ts";
import * as Gateway from "./sandboxIdeHttp.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";

it.each(["", "/v1/execution/t3/workspace"])(
  "redeems tickets and streams paths/redirects through worker endpoint prefix %s",
  async (prefix) => {
    const seen: string[] = [];
    const server = NodeHttp.createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/static/main.js" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("IDE content");
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    const address = server.address();
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
    const worker = await listenWorker({
      host: "127.0.0.1",
      port: 0,
      handle: async () => new Response("control"),
      ide: {
        acquireLease: async () => () => {},
        url: `http://127.0.0.1:${address.port}`,
        identity,
        token,
      },
    });
    const forwarded: string[] = [];
    const controller = await listenWorker({
      host: "127.0.0.1",
      port: 0,
      handle: async (request) => {
        const url = new URL(request.url);
        forwarded.push(url.pathname + url.search);
        if (prefix && !url.pathname.startsWith(prefix + "/"))
          return new Response(null, { status: 404 });
        return fetch(
          `http://127.0.0.1:${worker.port}${url.pathname.slice(prefix.length)}${url.search}`,
          { headers: request.headers, redirect: "manual" },
        );
      },
    });
    const base = "https://session.ide.example/api/sandbox-ide/session/";
    const gateway = HttpRouter.toWebHandler(
      Gateway.layer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeSocket.layerWebSocketConstructorWS),
        Layer.provide(
          Layer.succeed(
            SandboxIde.SandboxIde,
            SandboxIde.SandboxIde.of({
              open: () => Effect.die("Unused"),
              authorize: (input) =>
                input.ticket === "ticket"
                  ? Effect.succeed({ kind: "bootstrap", cookie: "scoped", url: base, secure: true })
                  : input.cookie === "scoped"
                    ? Effect.succeed({
                        kind: "proxy",
                        access: {
                          endpoint: `http://127.0.0.1:${controller.port}${prefix}`,
                          identity,
                          token,
                        },
                      })
                    : Effect.fail(new SandboxIdeError({ reason: "forbidden" })),
            }),
          ),
        ),
      ),
      { disableLogger: true },
    );
    const request = (path: string, cookie?: string) =>
      gateway.handler(
        new Request(`${base}${path}`, {
          headers: { host: "session.ide.example", ...(cookie ? { cookie } : {}) },
        }),
      );
    try {
      const boot = await request("?ticket=ticket");
      expect(boot.status).toBe(303);
      expect(boot.headers.get("location")).toBe(base);
      expect(boot.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
      expect(seen).toHaveLength(0);
      expect((await request("static/main.js")).status).toBe(401);
      const asset = await request("static/main.js?v=1", "t3_ide_session=scoped");
      expect(await asset.text()).toBe("IDE content");
      expect(seen).toEqual(["/static/main.js?v=1"]);
      expect(forwarded).toEqual([`${prefix}/v1/ide/static/main.js?v=1`]);
      const redirect = await request("redirect", "t3_ide_session=scoped");
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/api/sandbox-ide/session/static/main.js");
    } finally {
      await gateway.dispose();
      await controller.close();
      await worker.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
);
