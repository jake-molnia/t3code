import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExecutorRuntime from "./ExecutorRuntime.ts";

const decodeRpc = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
    method: Schema.String,
  }),
);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const base = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-executor-runtime-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(`${directory}/t3-supervisor.mjs`, "");
  let starts = 0;
  let alive = true;
  let mutations = 0;
  let initializations = 0;
  const paths: string[] = [];
  let toolResponse: ((id: string | number | undefined) => Promise<Response> | Response) | undefined;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.acquireRelease(
      Effect.sync(() => {
        starts++;
        alive = true;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.sync(() => alive),
          kill: () =>
            Effect.sync(() => {
              alive = false;
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
      (child) => child.kill().pipe(Effect.ignore),
    ),
  );
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ healthy: true });
    if (url.pathname === "/api/auth/sign-in/email")
      return new Response("{}", { headers: { "set-auth-token": "session" } });
    if (url.pathname === "/api/account/api-keys") return Response.json({ value: "management-key" });
    if (url.pathname.startsWith("/api/")) {
      expect(request.headers.get("x-api-key")).toBe("management-key");
      if (request.method === "POST") {
        mutations++;
        return new Response(null, { status: 503 });
      }
      return Response.json({ ok: true });
    }
    expect(request.headers.get("authorization")).toBe("Bearer management-key");
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = decodeRpc(decodeJson(await request.text()));
    if (rpc.method === "initialize") {
      initializations++;
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    paths.push(url.pathname);
    if (toolResponse) return toolResponse(rpc.id);
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  };
  return {
    layer: ExecutorRuntime.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)),
      Layer.provide(Layer.succeed(HostProcess.Environment)({ T3_EXECUTOR_RUNTIME_DIR: directory })),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch)),
    ),
    setToolResponse: (handler: typeof toolResponse) => {
      toolResponse = handler;
    },
    counts: () => ({ starts, mutations, initializations }),
    paths,
    crash: () => {
      alive = false;
    },
  };
});

describe("managed Executor runtime", () => {
  it.effect("stays unavailable without an installed runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* ExecutorRuntime.ExecutorRuntime;
      expect(yield* runtime.status).toEqual({ available: false });
      expect((yield* runtime.request("GET", "/api/connections").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(
      Effect.provide(ExecutorRuntime.layer),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(base),
    ),
  );
  it.effect("starts once, confines management requests, and never retries failed mutations", () =>
    Effect.gen(function* () {
      const host = yield* fixture;
      yield* Effect.gen(function* () {
        const runtime = yield* ExecutorRuntime.ExecutorRuntime;
        expect(yield* runtime.status).toEqual({ available: true });
        yield* runtime.request("GET", "/api/connections");
        expect((yield* runtime.request("GET", "/api/../../outside").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* runtime
            .request("POST", "/api/connections", { value: "private" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(host.counts().starts).toBe(1);
        expect(host.counts().mutations).toBe(1);
      }).pipe(Effect.provide(host.layer));
    }).pipe(Effect.scoped, Effect.provide(base)),
  );
  it.effect.each(["cancel", "request-error", "expired-session"] as const)(
    "keeps another in-flight call alive after %s",
    (failure) =>
      Effect.gen(function* () {
        const host = yield* fixture;
        const firstStarted = Promise.withResolvers<void>();
        const secondStarted = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        const secondResponse = Promise.withResolvers<Response>();
        let firstId: string | number | undefined;
        let requests = 0;
        host.setToolResponse((id) => {
          requests++;
          if (requests === 1) {
            firstId = id;
            firstStarted.resolve();
            return firstResponse.promise;
          }
          secondStarted.resolve();
          return failure === "cancel"
            ? secondResponse.promise
            : new Response(null, { status: failure === "expired-session" ? 404 : 400 });
        });
        yield* Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime.ExecutorRuntime;
          const execution = yield* runtime
            .callTool("project", "thread", "execute", {})
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => firstStarted.promise);
          const other = yield* runtime
            .callTool("project", "thread", "execute", {})
            .pipe(Effect.result, Effect.forkScoped);
          yield* Effect.promise(() => secondStarted.promise);
          if (failure === "cancel") yield* Fiber.interrupt(other);
          else expect((yield* Fiber.join(other))._tag).toBe("Failure");
          firstResponse.resolve(
            Response.json({
              jsonrpc: "2.0",
              id: firstId,
              result: { content: [{ type: "text", text: "completed once" }] },
            }),
          );
          secondResponse.resolve(new Response(null, { status: 202 }));
          expect(yield* Fiber.join(execution)).toMatchObject({
            content: [{ text: "completed once" }],
          });
          host.setToolResponse(undefined);
          yield* runtime.callTool("project", "thread", "execute", {});
          expect(host.counts().initializations).toBe(failure === "expired-session" ? 2 : 1);
        }).pipe(Effect.provide(host.layer));
      }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect(
    "isolates sessions by project and thread and reconnects after process replacement",
    () =>
      Effect.gen(function* () {
        const host = yield* fixture;
        yield* Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime.ExecutorRuntime;
          yield* runtime.callTool("project-a", "root", "execute", { code: "return 1" });
          yield* runtime.callTool("project-a", "root", "execute", { code: "return 2" });
          yield* runtime.callTool("project-b", "root", "execute", { code: "return 3" });
          yield* runtime.callTool("project-a", "child", "execute", { code: "return 4" });
          expect(host.counts().initializations).toBe(3);
          expect(host.paths).toEqual([
            "/mcp/toolkits/project-a",
            "/mcp/toolkits/project-a",
            "/mcp/toolkits/project-b",
            "/mcp/toolkits/project-a",
          ]);
          host.crash();
          yield* runtime.callTool("project-a", "root", "execute", { code: "return 5" });
          expect(host.counts().starts).toBe(2);
          expect(host.counts().initializations).toBe(4);
        }).pipe(Effect.provide(host.layer));
      }).pipe(Effect.scoped, Effect.provide(base)),
  );
});

// Run against the same pinned bundle that the head image copies into /opt/executor.
const installedRuntime = process.env.T3_EXECUTOR_TEST_RUNTIME;
const decodeToolkit = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.String, slug: Schema.String }),
);
if (installedRuntime) {
  it.live(
    "persists project toolkits across managed runtime restarts",
    () =>
      Effect.gen(function* () {
        const toolkit = yield* Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime.ExecutorRuntime;
          const created = yield* runtime
            .request("POST", "/api/toolkits", {
              owner: "org",
              name: "Runtime proof",
              slug: "runtime-proof",
            })
            .pipe(Effect.flatMap(decodeToolkit));
          const result = yield* runtime.callTool(created.slug, "root-proof", "execute", {
            code: "return 6 * 7;",
          });
          expect(result).toMatchObject({ structuredContent: { status: "completed", result: 42 } });
          return created;
        }).pipe(Effect.provide(ExecutorRuntime.layer));
        yield* Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime.ExecutorRuntime;
          const result = yield* runtime.callTool(toolkit.slug, "root-proof", "execute", {
            code: "return 7 * 8;",
          });
          expect(result).toMatchObject({ structuredContent: { status: "completed", result: 56 } });
          const persisted = yield* runtime.request("GET", "/api/toolkits");
          expect(persisted).toMatchObject({
            toolkits: expect.arrayContaining([expect.objectContaining({ id: toolkit.id })]),
          });
          yield* runtime.request("DELETE", `/api/toolkits/${toolkit.id}`);
        }).pipe(Effect.provide(ExecutorRuntime.layer));
      }).pipe(
        Effect.provideService(HostProcess.Environment, {
          T3_EXECUTOR_RUNTIME_DIR: installedRuntime,
          T3_EXECUTOR_BUN: process.env.T3_EXECUTOR_BUN ?? "/usr/local/bin/bun",
          PATH: process.env.PATH,
        }),
        Effect.provide(base),
      ),
    60_000,
  );
}
