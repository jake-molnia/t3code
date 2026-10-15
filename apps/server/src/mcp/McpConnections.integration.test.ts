// @effect-diagnostics nodeBuiltinImport:off -- Live HTTP fixture for the external MCP protocol.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ExecutorRuntime from "./ExecutorRuntime.ts";
import * as McpConnections from "./McpConnections.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const decodeRpc = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeCall = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    structuredContent: Schema.Struct({
      result: Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
    }),
  }),
);

const decodePause = Schema.decodeUnknownSync(
  Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.Literal("waiting_for_interaction"),
      executionId: Schema.String,
    }),
  }),
);

const firstProject = ProjectId.make("c0a80101-1234-4567-89ab-000000000001");
const secondProject = ProjectId.make("c0a80101-1234-4567-89ab-000000000002");
const firstThread = ThreadId.make("thread:executor-first");
const secondThread = ThreadId.make("thread:executor-second");
const project = (projectId: ProjectId): ProjectStore.ProjectRow => ({
  projectId,
  title: projectId,
  workspaceRoot: "/workspace/shared-path",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  deletedAt: null,
});
const projects = [project(firstProject), project(secondProject)];
const base = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-executor-connections-" })),
  Layer.provideMerge(NodeServices.layer),
);
const domain = McpConnections.layer.pipe(
  Layer.provide(ExecutorRuntime.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        list: (options) =>
          Effect.succeed(
            projects.filter(
              (row) => !options?.projectIds || options.projectIds.includes(row.projectId),
            ),
          ),
        get: (id) =>
          Effect.succeed(Option.fromUndefinedOr(projects.find((row) => row.projectId === id))),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            id === firstThread || id === secondThread
              ? {
                  ...liveThreadShell(id),
                  projectId: id === firstThread ? firstProject : secondProject,
                  worktreePath: "/workspace/shared-path",
                }
              : null,
          ),
      }),
    ),
  ),
);

/** A real HTTP MCP server; Executor discovers and invokes these two remote tools. */
const remoteMcp = Effect.acquireRelease(
  Effect.promise(async () => {
    const calls: string[] = [];
    let token: string | undefined;
    const server = NodeHttp.createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rpc = decodeRpc(decodeJson(Buffer.concat(chunks).toString("utf8")));
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      let result: unknown;
      if (rpc.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "t3-fixture", version: "1.0.0" },
        };
      else if (rpc.method === "tools/list")
        result = {
          tools: ["read", "write", "approve"].map((name) => ({
            name,
            description: `${name} fixture data`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: name !== "approve", destructiveHint: name === "approve" },
          })),
        };
      else if (rpc.method === "tools/call") {
        const { name } = decodeCall(rpc.params);
        calls.push(name);
        result = {
          content: [{ type: "text", text: JSON.stringify({ tool: name }) }],
          structuredContent: { tool: name },
        };
      } else result = {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("MCP fixture did not bind a TCP port");
    return {
      server,
      calls,
      setToken: (value: string) => {
        token = value;
      },
      url: `http://127.0.0.1:${address.port}/mcp`,
    };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
);

const installedRuntime = process.env.T3_EXECUTOR_TEST_RUNTIME;
if (installedRuntime) {
  it.live(
    "connects, assigns UUID projects, scopes actual remote tools, and revokes a live session",
    () =>
      Effect.gen(function* () {
        const fixture = yield* remoteMcp;
        let failReplacement = false;
        const fetch: typeof globalThis.fetch = (input, init) => {
          const request = new Request(input, init);
          if (
            failReplacement &&
            request.method === "POST" &&
            new URL(request.url).pathname === "/api/connections"
          ) {
            failReplacement = false;
            return Promise.resolve(new Response(null, { status: 503 }));
          }
          return globalThis.fetch(input, init);
        };
        yield* Effect.gen(function* () {
          const service = yield* McpConnections.McpConnections;
          expect(
            yield* service.connect(
              { name: "Fixture", url: fixture.url, auth: { type: "none" } },
              "browser-session",
            ),
          ).toEqual({ status: "connected" });
          const state = yield* service.list;
          expect(state.connections).toHaveLength(1);
          const connection = state.connections[0];
          if (!connection) throw new Error("Connected MCP missing from settings");
          const tools = yield* service.tools(connection.id);
          expect(tools.map((tool) => tool.name).sort()).toEqual(["approve", "read", "write"]);
          const read = tools.find((tool) => tool.name === "read");
          const write = tools.find((tool) => tool.name === "write");
          if (!read || !write) throw new Error("Remote tool catalog incomplete");
          yield* service.setAccess({
            projectIds: [firstProject],
            connectionId: connection.id,
            tools: { mode: "selected", toolIds: [] },
          });
          expect((yield* service.list).access).toEqual([
            {
              projectId: firstProject,
              connectionId: connection.id,
              tools: { mode: "selected", toolIds: [] },
            },
          ]);
          expect(
            JSON.stringify(
              yield* service.call({
                threadId: firstThread,
                sessionId: "provider-session",
                operation: "execute",
                value: `return await tools.${read.id.replace(/^tools\./, "")}({});`,
              }),
            ),
          ).toContain("tool_blocked");
          expect(fixture.calls).toEqual([]);
          yield* service.setAccess({
            projectIds: [firstProject, secondProject],
            connectionId: connection.id,
            tools: { mode: "selected", toolIds: [read.id] },
          });
          expect((yield* service.list).access).toEqual(
            projects.map((row) => ({
              projectId: row.projectId,
              connectionId: connection.id,
              tools: { mode: "selected", toolIds: [read.id] },
            })),
          );
          yield* service.setAccess({
            projectIds: [secondProject],
            connectionId: connection.id,
            tools: { mode: "selected", toolIds: [write.id] },
          });
          const readPath = read.id.replace(/^tools\./, "");
          const writePath = write.id.replace(/^tools\./, "");
          const call = (
            threadId: ThreadId,
            operation: "search" | "schema" | "execute",
            value: string,
          ) => service.call({ threadId, sessionId: "provider-session", operation, value });
          const found = decodeSearch(yield* call(firstThread, "search", "fixture"));
          expect(found.structuredContent.result.items.map((item) => item.path)).toEqual([readPath]);
          expect(JSON.stringify(yield* call(firstThread, "schema", readPath))).toContain(readPath);
          yield* call(firstThread, "execute", `return await tools.${readPath}({});`);
          expect(fixture.calls).toEqual(["read"]);
          expect(
            JSON.stringify(
              yield* call(firstThread, "execute", `return await tools.${writePath}({});`),
            ),
          ).toContain("tool_blocked");
          expect(fixture.calls).toEqual(["read"]);
          yield* call(secondThread, "execute", `return await tools.${writePath}({});`);
          expect(fixture.calls).toEqual(["read", "write"]);
          yield* service.setAccess({
            projectIds: [firstProject],
            connectionId: connection.id,
            tools: null,
          });
          expect(
            JSON.stringify(
              yield* call(firstThread, "execute", `return await tools.${readPath}({});`),
            ),
          ).toContain("tool_blocked");
          expect(fixture.calls).toEqual(["read", "write"]);
          const beforeReconnect = (yield* service.list).access;
          for (const token of ["first-token", "replacement-token"]) {
            fixture.setToken(token);
            failReplacement = true;
            expect(
              (yield* service
                .connect(
                  {
                    connectionId: connection.id,
                    name: "Fixture",
                    url: fixture.url,
                    auth: { type: "token", token },
                  },
                  "browser-session",
                )
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect((yield* service.list).connections).toMatchObject([
              { id: connection.id, needsReconnect: true },
            ]);
            expect((yield* service.list).access).toEqual(beforeReconnect);
            yield* service.connect(
              {
                connectionId: connection.id,
                name: "Fixture",
                url: fixture.url,
                auth: { type: "token", token },
              },
              "browser-session",
            );
            expect((yield* service.list).access).toEqual(beforeReconnect);
            yield* call(secondThread, "execute", `return await tools.${writePath}({});`);
          }
          expect(fixture.calls).toEqual(["read", "write", "write", "write"]);
          const approve = tools.find((tool) => tool.name === "approve");
          if (!approve) throw new Error("Approval tool missing");
          yield* service.setAccess({
            projectIds: [firstProject],
            connectionId: connection.id,
            tools: { mode: "selected", toolIds: [approve.id] },
          });
          const paused = decodePause(
            yield* call(
              firstThread,
              "execute",
              `return await tools.${approve.id.replace(/^tools\./, "")}({});`,
            ),
          );
          const resume = {
            threadId: firstThread,
            sessionId: "provider-session",
            executionId: paused.structuredContent.executionId,
            action: "accept" as const,
            content: "{}",
          };
          expect(
            (yield* service.resume({ ...resume, threadId: secondThread }).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(fixture.calls).not.toContain("approve");
          expect(yield* service.resume(resume)).toMatchObject({
            structuredContent: { status: "completed" },
          });
          expect(fixture.calls.at(-1)).toBe("approve");
        }).pipe(Effect.provide(domain), Effect.provideService(FetchHttpClient.Fetch, fetch));
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Environment, {
          T3_EXECUTOR_RUNTIME_DIR: installedRuntime,
          T3_EXECUTOR_BUN: process.env.T3_EXECUTOR_BUN ?? "/usr/local/bin/bun",
          EXECUTOR_ALLOW_LOCAL_NETWORK: "true",
          PATH: process.env.PATH,
        }),
        Effect.provide(base),
      ),
    60_000,
  );
} else {
  it.skip("requires T3_EXECUTOR_TEST_RUNTIME for the pinned Executor domain integration", () => {});
}
