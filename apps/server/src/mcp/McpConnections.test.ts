import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ExecutorRuntime from "./ExecutorRuntime.ts";
import * as McpConnections from "./McpConnections.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const decodePolicy = Schema.decodeUnknownSync(
  Schema.Struct({ pattern: Schema.String, action: Schema.String }),
);

const firstProject = ProjectId.make("a317acef-a957-4bd8-a7c0-3807dc72b630");
const secondProject = ProjectId.make("project:second");
const root = ThreadId.make("thread:root");
const otherRoot = ThreadId.make("thread:other-root");
const child = ThreadId.make("thread:child");
const connection = {
  address: "tools.t3_fixture.org.main",
  owner: "org",
  integration: "t3_fixture",
  name: "main",
  identityLabel: "Fixture account",
};
const tool = (name: string) => ({
  address: `tools.t3_fixture.org.main.${name}`,
  owner: "org",
  integration: "t3_fixture",
  connection: "main",
  name,
  description: name,
  static: null,
});
const project = (projectId: ProjectId): ProjectStore.ProjectRow => ({
  projectId,
  title: projectId,
  workspaceRoot: "/workspace/repo",
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
const NewToolkit = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
const NewGrant = Schema.Struct({ pattern: Schema.String });
const NewIntegration = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  endpoint: Schema.String,
});
const decodeToolkit = Schema.decodeUnknownSync(NewToolkit);
const decodeGrant = Schema.decodeUnknownSync(NewGrant);
const decodeIntegration = Schema.decodeUnknownSync(NewIntegration);
const decodeConnection = Schema.decodeUnknownSync(
  Schema.Struct({ owner: Schema.String, integration: Schema.String, name: Schema.String }),
);
const managementSession = "browser-session";

/** In-memory upstream HTTP persistence. Policy enforcement belongs to the real Executor integration tests. */
function fixture() {
  const projects = [project(firstProject), project(secondProject)];
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [root, { ...liveThreadShell(root), projectId: firstProject, worktreePath: "/workspace/repo" }],
    [
      otherRoot,
      { ...liveThreadShell(otherRoot), projectId: secondProject, worktreePath: "/workspace/repo" },
    ],
    [
      child,
      {
        ...liveThreadShell(child),
        projectId: firstProject,
        worktreePath: "/workspace/repo",
        lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "subagent" },
      },
    ],
  ]);
  const connections = [connection];
  const catalog = [tool("read"), tool("write")];
  const integrations = [
    {
      slug: connection.integration,
      name: "Fixture",
      kind: "mcp",
      displayUrl: "https://mcp.example.test",
    },
  ];
  const toolkits: Array<{ id: string; owner: string; slug: string }> = [];
  const grants = new Map<string, Array<{ id: string; pattern: string }>>();
  const policies = new Map<string, Array<{ id: string; pattern: string; action: string }>>();
  const secrets = new Map<string, Uint8Array>();
  const responses: unknown[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const calls: Array<{
    slug: string;
    session: string;
    name: string;
    args: unknown;
    patterns: string[];
  }> = [];
  let available = true;
  let oauthFailures = 0;
  let credentialFailures = 0;
  let sequence = 0;
  let yieldThreadLookup = false;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          secrets.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          secrets.delete(key);
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      list: (options) =>
        Effect.sync(() =>
          projects.filter(
            (row) => !options?.projectIds || options.projectIds.includes(row.projectId),
          ),
        ),
      get: (id) =>
        Effect.sync(() => Option.fromUndefinedOr(projects.find((row) => row.projectId === id))),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.gen(function* () {
          if (yieldThreadLookup) yield* Effect.yieldNow;
          return threads.get(id) ?? null;
        }),
    }),
    Layer.mock(ExecutorRuntime.ExecutorRuntime)({
      status: Effect.sync(() => ({ available })),
      request: (method, path, body) =>
        Effect.suspend(() => {
          if (path === "/api/connections" && method === "POST" && credentialFailures > 0) {
            credentialFailures--;
            requests.push({ method, path, body });
            return Effect.fail(
              new ExecutorRuntime.ExecutorRuntimeError({ operation: "replace credential" }),
            );
          }
          if (path === "/api/oauth/complete" && oauthFailures > 0) {
            oauthFailures--;
            requests.push({ method, path, body });
            return Effect.fail(
              new ExecutorRuntime.ExecutorRuntimeError({
                operation: "exchange authorization code",
              }),
            );
          }
          return Effect.sync(() => {
            requests.push({ method, path, body });
            const url = new URL(path, "http://executor.test");
            if (method === "GET" && url.pathname === "/api/connections") return [...connections];
            if (method === "GET" && url.pathname === "/api/integrations") return [...integrations];
            if (method === "GET" && url.pathname === "/api/tools") return [...catalog];
            if (path === "/api/toolkits" && method === "GET") return { toolkits: [...toolkits] };
            if (path === "/api/toolkits" && method === "POST") {
              const input = decodeToolkit(body);
              const row = { id: `toolkit-${++sequence}`, owner: input.owner, slug: input.slug };
              toolkits.push(row);
              grants.set(row.id, []);
              return row;
            }
            const policyMatch = /^\/api\/toolkits\/([^/]+)\/policies(?:\/([^/]+))?$/.exec(path);
            if (policyMatch?.[1]) {
              const rows = policies.get(policyMatch[1]) ?? [];
              if (method === "GET") return { policies: rows };
              if (method === "POST") {
                const row = { id: `policy-${++sequence}`, ...decodePolicy(body) };
                policies.set(policyMatch[1], [...rows, row]);
                return row;
              }
              policies.set(
                policyMatch[1],
                rows.filter((row) => row.id !== policyMatch[2]),
              );
              return {};
            }
            const match = /^\/api\/toolkits\/([^/]+)\/connections(?:\/([^/]+))?$/.exec(path);
            if (match?.[1]) {
              const rows = grants.get(match[1]);
              if (!rows) throw new Error(`Unknown toolkit: ${path}`);
              if (method === "GET") return { connections: [...rows] };
              if (method === "POST") {
                const row = {
                  id: `grant-${++sequence}`,
                  ...decodeGrant(body),
                };
                rows.push(row);
                return row;
              }
              if (method === "DELETE") {
                grants.set(
                  match[1],
                  rows.filter((row) => row.id !== match[2]),
                );
                return {};
              }
            }
            if (path === "/api/mcp/probe") return { versionNegotiation: "legacy" };
            if (path === "/api/mcp/servers" && method === "POST") {
              const input = decodeIntegration(body);
              integrations.push({
                slug: input.slug,
                name: input.name,
                kind: "mcp",
                displayUrl: input.endpoint,
              });
              return { slug: input.slug };
            }
            if (path === "/api/connections" && method === "POST") {
              const input = decodeConnection(body);
              connections.push({
                ...input,
                address: `tools.${input.integration}.${input.owner}.${input.name}`,
                identityLabel: "Fixture account",
              });
              return {};
            }
            if (path === "/api/oauth/probe")
              return {
                authorizationUrl: "https://auth.example.test/authorize",
                tokenUrl: "https://auth.example.test/token",
                registrationEndpoint: "https://auth.example.test/register",
                scopesSupported: ["read"],
              };
            if (path === "/api/oauth/clients/register-dynamic" || path === "/api/oauth/clients")
              return {};
            if (path === "/api/oauth/start")
              return {
                status: "redirect",
                authorizationUrl: "https://auth.example.test/authorize?state=fixture",
                state: "fixture",
              };
            if (path === "/api/oauth/complete") return {};
            if (path === "/api/connections/org/t3_fixture/main" && method === "DELETE") {
              connections.length = 0;
              return {};
            }
            if (path === "/api/mcp/servers/t3_fixture" && method === "DELETE") {
              integrations.length = 0;
              return {};
            }
            if (path === "/api/mcp/servers/t3_fixture" && method === "GET")
              return { config: { endpoint: "https://mcp.example.test" } };
            if (path === "/api/mcp/servers/t3_fixture/auth" && method === "POST") return {};
            if (path === "/api/connections/org/t3_fixture/main/refresh" && method === "POST")
              return {};
            throw new Error(`Unexpected upstream request: ${method} ${path}`);
          });
        }),
      callTool: (slug, session, name, args) =>
        Effect.sync(() => {
          const toolkit = toolkits.find((row) => row.slug === slug);
          if (!toolkit) throw new Error("Unscoped or unknown toolkit invocation");
          const invocation = {
            slug,
            session,
            name,
            args,
            patterns: (grants.get(toolkit.id) ?? []).map((row) => row.pattern),
          };
          calls.push(invocation);
          return responses.shift() ?? invocation;
        }),
    }),
  );
  return {
    layer: McpConnections.layer.pipe(Layer.provide(dependencies)),
    projects,
    threads,
    connections,
    catalog,
    toolkits,
    grants,
    secrets,
    failNextCredentialWrite: () => {
      credentialFailures++;
    },
    failNextOAuth: () => {
      oauthFailures++;
    },
    responses,
    interleaveThreadLookups: () => {
      yieldThreadLookup = true;
    },
    requests,
    calls,
    unavailable: () => {
      available = false;
    },
  };
}

const assign = (
  service: McpConnections.McpConnections["Service"],
  projectIds: ProjectId[] = [firstProject],
) =>
  service.setAccess({
    projectIds,
    connectionId: connection.address,
    tools: { mode: "selected", toolIds: [tool("read").address] },
  });
const invoke = (service: McpConnections.McpConnections["Service"], threadId = root) =>
  service.call({
    threadId,
    sessionId: "provider-session",
    operation: "execute",
    value: "return 1;",
  });
const authorize = (service: McpConnections.McpConnections["Service"]) =>
  service.connect(
    {
      name: "OAuth MCP",
      url: "https://mcp.example.test",
      auth: { type: "oauth", redirectUri: "https://t3.example.test/settings/mcp" },
    },
    managementSession,
  );

describe("McpConnections", () => {
  it.effect(
    "only the originating thread and provider session can resume a paused execution once",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        expect(McpConnections.projectToolkitSlug(firstProject)).toMatch(
          /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/,
        );
        yield* assign(service, [firstProject, secondProject]);
        f.responses.push({
          structuredContent: { status: "waiting_for_interaction", executionId: "execution-one" },
        });
        yield* invoke(service);
        const input = {
          threadId: root,
          sessionId: "provider-session",
          executionId: "execution-one",
          action: "accept",
          content: "{}",
        } satisfies Parameters<typeof service.resume>[0];
        for (const wrong of [
          { ...input, threadId: otherRoot },
          { ...input, threadId: child },
          { ...input, sessionId: "replacement-provider-session" },
        ])
          expect((yield* service.resume(wrong).pipe(Effect.asVoid, Effect.flip)).reason).toBe(
            "not_found",
          );
        expect(f.calls).toHaveLength(1);
        yield* service.resume(input);
        expect(f.calls.at(-1)).toMatchObject({
          slug: McpConnections.projectToolkitSlug(firstProject),
          session: `${root}:provider-session`,
          name: "resume",
          args: { executionId: "execution-one", action: "accept", content: "{}" },
        });
        expect((yield* service.resume(input).pipe(Effect.asVoid, Effect.flip)).reason).toBe(
          "not_found",
        );
        expect(f.calls).toHaveLength(2);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("consumes resume ownership before concurrent retries can call upstream twice", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* assign(service);
      f.responses.push({
        structuredContent: { status: "waiting_for_interaction", executionId: "execution-one" },
      });
      yield* invoke(service);
      f.interleaveThreadLookups();
      const input = {
        threadId: root,
        sessionId: "provider-session",
        executionId: "execution-one",
        action: "accept",
        content: "{}",
      } satisfies Parameters<typeof service.resume>[0];
      yield* Effect.all(
        [service.resume(input).pipe(Effect.result), service.resume(input).pipe(Effect.result)],
        { concurrency: "unbounded" },
      );
      expect(f.calls.filter((call) => call.name === "resume")).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "uses project identity for identical checkout paths and preserves child session identity",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        yield* assign(service, [firstProject, secondProject]);
        yield* invoke(service);
        yield* invoke(service, otherRoot);
        yield* invoke(service, child);
        expect(f.calls.map((call) => call.slug)).toEqual([
          McpConnections.projectToolkitSlug(firstProject),
          McpConnections.projectToolkitSlug(secondProject),
          McpConnections.projectToolkitSlug(firstProject),
        ]);
        expect(new Set(f.calls.map((call) => call.session)).size).toBe(3);
        expect(f.calls.every((call) => call.name === "execute")).toBe(true);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "keeps exact selections fixed while all-tools grants include newly discovered tools",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        yield* assign(service);
        yield* service.setAccess({
          projectIds: [secondProject],
          connectionId: connection.address,
          tools: { mode: "all" },
        });
        f.catalog.push(tool("newTool"));
        yield* invoke(service);
        yield* invoke(service, otherRoot);
        expect(f.calls.map((call) => call.patterns)).toEqual([
          ["t3_fixture.org.main.read"],
          ["t3_fixture.org.main.*"],
        ]);
        expect((yield* service.list).access).toEqual([
          {
            projectId: firstProject,
            connectionId: connection.address,
            tools: { mode: "selected", toolIds: [tool("read").address] },
          },
          { projectId: secondProject, connectionId: connection.address, tools: { mode: "all" } },
        ]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "revokes access for the next call of an existing session and removes all project grants before disconnecting",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        yield* assign(service, [firstProject, secondProject]);
        yield* invoke(service);
        yield* service.setAccess({
          projectIds: [firstProject],
          connectionId: connection.address,
          tools: null,
        });
        yield* invoke(service);
        expect(f.calls.map((call) => call.patterns)).toEqual([["t3_fixture.org.main.read"], []]);
        expect(f.calls[0]?.session).toBe(f.calls[1]?.session);
        yield* service.remove(connection.address);
        expect([...f.grants.values()].flat()).toEqual([]);
        const deletes = f.requests.filter((request) => request.method === "DELETE");
        expect(deletes.at(-2)?.path).toBe("/api/connections/org/t3_fixture/main");
        expect((yield* service.list).connections).toEqual([]);
        yield* invoke(service, otherRoot);
        expect(f.calls.at(-1)?.patterns).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "rejects unknown projects, foreign tools, static tools, and wildcard tool names before mutation",
    () => {
      const f = fixture();
      f.catalog.push(tool("*"));
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        for (const id of [
          "tools.other.org.main.read",
          "executor.coreTools.policies.create",
          tool("*").address,
        ]) {
          const error = yield* service
            .setAccess({
              projectIds: [firstProject],
              connectionId: connection.address,
              tools: { mode: "selected", toolIds: [id] },
            })
            .pipe(Effect.asVoid, Effect.flip);
          expect(error.reason).toBe("invalid_input");
        }
        expect(
          (yield* assign(service, [ProjectId.make("missing")]).pipe(Effect.asVoid, Effect.flip))
            .reason,
        ).toBe("not_found");
        expect(f.requests.every((request) => request.method === "GET")).toBe(true);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "never forwards calls for absent project grants, missing threads, or deleted threads",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        expect((yield* invoke(service).pipe(Effect.asVoid, Effect.flip)).reason).toBe("not_found");
        yield* assign(service);
        f.threads.delete(root);
        expect((yield* invoke(service).pipe(Effect.asVoid, Effect.flip)).reason).toBe("not_found");
        const deleted = liveThreadShell(root);
        f.threads.set(root, { ...deleted, projectId: firstProject, deletedAt: deleted.createdAt });
        expect((yield* invoke(service).pipe(Effect.asVoid, Effect.flip)).reason).toBe("not_found");
        f.projects.length = 0;
        expect((yield* invoke(service, child).pipe(Effect.asVoid, Effect.flip)).reason).toBe(
          "not_found",
        );
        expect(f.calls).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("encodes discovery input as string data rather than executable source", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* assign(service);
      const value = '"); return tools.executor.coreTools.policies.create({}); //';
      yield* service.call({ threadId: root, sessionId: "session", operation: "search", value });
      yield* service.call({ threadId: root, sessionId: "session", operation: "schema", value });
      expect(f.calls[0]?.args).toEqual({
        code: `return tools.search(${JSON.stringify({ query: value, limit: 20 })});`,
      });
      expect(f.calls[1]?.args).toEqual({
        code: `return tools.describe.tool(${JSON.stringify({ path: value })});`,
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("does not contact the upstream management API when unavailable", () => {
    const f = fixture();
    f.unavailable();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      expect(yield* service.list).toEqual({ available: false, connections: [], access: [] });
      expect(f.requests).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "preserves MCP version negotiation and sends API credentials only through the connection flow",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        expect(
          yield* service.connect(
            {
              name: "Private MCP",
              url: "https://mcp.example.test",
              auth: { type: "token", token: "test-token" },
            },
            managementSession,
          ),
        ).toEqual({ status: "connected" });
        expect(
          f.requests.find((request) => request.path === "/api/mcp/servers")?.body,
        ).toMatchObject({ versionNegotiation: "legacy", endpoint: "https://mcp.example.test/" });
        expect(
          f.requests.find(
            (request) => request.path === "/api/connections" && request.method === "POST",
          )?.body,
        ).toMatchObject({ owner: "org", template: "header", value: "test-token" });
        expect(JSON.stringify(yield* service.list)).not.toContain("test-token");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "registers OAuth with the browser callback and reuses upstream state for completion",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        const redirectUri = "https://t3.example.test/settings/mcp";
        expect(
          yield* service.connect(
            {
              name: "OAuth MCP",
              url: "https://mcp.example.test",
              auth: { type: "oauth", redirectUri },
            },
            managementSession,
          ),
        ).toEqual({
          status: "authorize",
          authorizationUrl: "https://auth.example.test/authorize?state=fixture",
          state: "fixture",
        });
        expect(
          f.requests.find((request) => request.path === "/api/oauth/clients/register-dynamic")
            ?.body,
        ).toMatchObject({ redirectUri, scopes: ["read"] });
        expect(
          f.requests.find((request) => request.path === "/api/oauth/start")?.body,
        ).toMatchObject({ redirectUri, owner: "org", clientOwner: "org", template: "oauth2" });
        yield* service.completeAuth(
          { state: "fixture", code: "authorization-code" },
          managementSession,
        );
        expect(f.requests.at(-1)).toEqual({
          method: "POST",
          path: "/api/oauth/complete",
          body: { state: "fixture", code: "authorization-code" },
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("validates OAuth callback before creating an integration", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      const error = yield* service
        .connect(
          {
            name: "Invalid callback",
            url: "https://mcp.example.test",
            auth: { type: "oauth", redirectUri: "https://t3.example.test/wrong-path" },
          },
          managementSession,
        )
        .pipe(Effect.asVoid, Effect.flip);
      expect(error.reason).toBe("invalid_input");
      expect(f.requests.filter((request) => request.method !== "GET")).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "rejects another browser's OAuth callback without consuming the original browser's state",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        yield* authorize(service);
        const input = { state: "fixture", code: "authorization-code" };
        expect(
          (yield* service.completeAuth(input, "other-browser").pipe(Effect.asVoid, Effect.flip))
            .reason,
        ).toBe("oauth");
        expect(f.requests.filter((request) => request.path === "/api/oauth/complete")).toEqual([]);
        expect(f.secrets.size).toBe(1);
        yield* service.completeAuth(input, managementSession);
        expect(f.secrets.size).toBe(0);
        expect(
          (yield* service.completeAuth(input, managementSession).pipe(Effect.asVoid, Effect.flip))
            .reason,
        ).toBe("oauth");
        expect(f.requests.filter((request) => request.path === "/api/oauth/complete")).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("keeps a failed OAuth callback retryable and serializes successful redemption", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* authorize(service);
      const input = { state: "fixture", code: "authorization-code" };
      f.failNextOAuth();
      expect((yield* service.completeAuth(input, managementSession).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(f.secrets.size).toBe(1);
      const results = yield* Effect.all(
        [
          service.completeAuth(input, managementSession).pipe(Effect.result),
          service.completeAuth(input, managementSession).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
      expect(f.secrets.size).toBe(0);
      expect(f.requests.filter((request) => request.path === "/api/oauth/complete")).toHaveLength(
        2,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects expired OAuth state before exchanging the authorization code", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* authorize(service);
      yield* TestClock.adjust(15 * 60_000 + 1);
      expect(
        (yield* service
          .completeAuth({ state: "fixture", code: "authorization-code" }, managementSession)
          .pipe(Effect.asVoid, Effect.flip)).reason,
      ).toBe("oauth");
      expect(f.requests.filter((request) => request.path === "/api/oauth/complete")).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("retains pending OAuth ownership when the service is recreated", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* authorize(yield* McpConnections.McpConnections);
      }).pipe(Effect.provide(f.layer));
      expect(f.secrets.size).toBe(1);
      yield* Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        yield* service.completeAuth(
          { state: "fixture", code: "authorization-code" },
          managementSession,
        );
      }).pipe(Effect.provide(f.layer));
      expect(f.secrets.size).toBe(0);
      expect(f.requests.filter((request) => request.path === "/api/oauth/complete")).toHaveLength(
        1,
      );
    });
  });

  it.effect(
    "preserves selected-but-empty mode across service recreation without granting tools",
    () => {
      const f = fixture();
      const input = {
        projectIds: [firstProject],
        connectionId: connection.address,
        tools: { mode: "selected" as const, toolIds: [] },
      };
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* McpConnections.McpConnections;
          yield* assign(service);
          yield* service.setAccess(input);
        }).pipe(Effect.provide(f.layer));
        yield* Effect.gen(function* () {
          const service = yield* McpConnections.McpConnections;
          expect((yield* service.list).access).toEqual([
            { projectId: firstProject, connectionId: connection.address, tools: input.tools },
          ]);
          expect([...f.grants.values()].flat()).toEqual([]);
          yield* service.setAccess({ ...input, tools: { mode: "all" } });
          expect((yield* service.list).access[0]?.tools).toEqual({ mode: "all" });
          yield* service.setAccess({ ...input, tools: null });
          expect((yield* service.list).access).toEqual([]);
        }).pipe(Effect.provide(f.layer));
      });
    },
  );

  it.effect.each(["retry", "disconnect"] as const)(
    "recovers a failed credential replacement after restart via %s",
    (recovery) => {
      const f = fixture();
      const input = {
        connectionId: connection.address,
        name: "Fixture",
        url: "https://mcp.example.test",
        auth: { type: "token" as const, token: "replacement" },
      };
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* McpConnections.McpConnections;
          yield* assign(service);
          f.failNextCredentialWrite();
          expect((yield* service.connect(input, managementSession).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }).pipe(Effect.provide(f.layer));
        yield* Effect.gen(function* () {
          const service = yield* McpConnections.McpConnections;
          const state = yield* service.list;
          expect(state.connections).toMatchObject([
            { id: connection.address, needsReconnect: true },
          ]);
          expect(state.access).toHaveLength(1);
          if (recovery === "retry") {
            yield* service.connect(input, managementSession);
            expect((yield* service.list).connections).toMatchObject([
              { id: connection.address, needsReconnect: false },
            ]);
            expect((yield* service.list).access).toEqual(state.access);
          } else {
            yield* service.remove(connection.address);
            expect((yield* service.list).connections).toEqual([]);
            expect([...f.grants.values()].flat()).toEqual([]);
          }
        }).pipe(Effect.provide(f.layer));
      });
    },
  );

  it.effect("allows retry after resume preflight fails without dispatching twice", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* assign(service);
      f.responses.push({
        structuredContent: { status: "waiting_for_interaction", executionId: "retry-pause" },
      });
      yield* invoke(service);
      const thread = f.threads.get(root);
      if (!thread) throw new Error("Missing fixture thread");
      f.threads.delete(root);
      const input = {
        threadId: root,
        sessionId: "provider-session",
        executionId: "retry-pause",
        action: "accept" as const,
        content: "{}",
      };
      expect((yield* service.resume(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(f.calls.filter((call) => call.name === "resume")).toEqual([]);
      f.threads.set(root, thread);
      yield* service.resume(input);
      expect(f.calls.filter((call) => call.name === "resume")).toHaveLength(1);
      expect((yield* service.resume(input).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("reconnects a saved connection without losing its project and tool grants", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* McpConnections.McpConnections;
      yield* assign(service, [firstProject, secondProject]);
      const before = yield* service.list;
      yield* service.connect(
        {
          name: "Fixture",
          url: "https://mcp.example.test",
          connectionId: connection.address,
          auth: { type: "token", token: "replacement-token" },
        },
        managementSession,
      );
      expect((yield* service.list).access).toEqual(before.access);
      expect((yield* service.list).connections).toEqual(before.connections);
      yield* invoke(service);
      expect(f.calls.at(-1)?.patterns).toEqual(["t3_fixture.org.main.read"]);
      expect(
        f.requests.some(
          (request) => request.method === "DELETE" && request.path.includes("/toolkits/"),
        ),
      ).toBe(false);
      expect(
        f.requests.find(
          (request) => request.method === "POST" && request.path === "/api/connections",
        )?.body,
      ).toMatchObject({ integration: "t3_fixture", name: "main", value: "replacement-token" });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "rejects local-process URLs and embedded credentials before contacting Executor",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* McpConnections.McpConnections;
        for (const url of [
          "file:///tmp/server",
          "stdio:node",
          "https://user:password@mcp.example.test",
          "not a URL",
        ]) {
          const error = yield* service
            .connect({ name: "Invalid MCP", url, auth: { type: "none" } }, managementSession)
            .pipe(Effect.asVoid, Effect.flip);
          expect(error.reason).toBe("invalid_input");
        }
        expect(f.requests).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );
});
