import { expect, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, ThreadId, type SandboxIdeOpenInput } from "@t3tools/contracts";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as RuntimeSchema from "./Schema.ts";
import authMigration from "../persistence/Migrations/031_AuthAuthorizationScopes.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { acquireWorkspaceActivity, WorkspaceActivity } from "./WorkspaceActivity.ts";
import { makePolicy } from "./LifecyclePolicy.ts";
import * as Context from "effect/Context";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as SandboxIde from "./SandboxIde.ts";

const owner = { authSessionId: AuthSessionId.make("browser-one"), origin: "https://t3.example" };

const identity: ExecutionIdentity = {
  workspaceId: "one",
  allocationId: "a",
  generation: 1,
  incarnation: "i",
  podUid: "pod",
  protocolVersion: 1,
};
const client = (workspaceId: string, incarnation = "i") =>
  createExecutionClient({
    identity: { ...identity, workspaceId, incarnation },
    token: "private-worker-token",
    endpoint: "http://private-worker:8083",
  });
const setup = Effect.gen(function* () {
  const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(database, SqlClient.SqlClient);
  yield* RuntimeSchema.migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  yield* authMigration.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  for (const sessionId of [owner.authSessionId, AuthSessionId.make("browser-two")]) {
    yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${sessionId}, 'test', '["orchestration:operate"]', 'browser-session-cookie',
        '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z')`;
  }
  const clients = new Map([
    ["root-one", client("one")],
    ["child", client("one")],
    ["root-two", client("two")],
  ]);
  const current = (id: string) => clients.get(id) ?? client("one");
  let provisioning: Effect.Effect<void, RuntimeClient.RuntimeClientError> = Effect.void;
  const runtime = RuntimeClient.RuntimeClient.of({
    enabled: true,
    forThread: (id, _driver, scope) =>
      Effect.gen(function* () {
        const found = current(id);
        if (scope)
          yield* acquireWorkspaceActivity(found.identity.workspaceId).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
        yield* provisioning;
        return found;
      }),
    observeThread: (id) => Effect.sync(() => ({ kind: "running", client: current(id) })),
    forWorkspace: (id) => provisioning.pipe(Effect.as(client(id))),
    forUtility: (id) => Effect.succeed(client(id)),
    observeWorkspace: (id) => Effect.succeed({ kind: "running", client: client(id) }),
    sessionResidency: () => Effect.succeed(null),
    rememberSession: () => Effect.void,
    getEventCursor: () => Effect.succeed(0),
    stop: () => Effect.void,
  });
  const make = () =>
    Layer.build(
      SandboxIde.layer.pipe(
        Layer.provide(Layer.succeed(RuntimeClient.RuntimeClient, runtime)),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      ),
    ).pipe(
      Effect.map((context) => {
        const service = Context.get(context, SandboxIde.SandboxIde);
        return {
          ...service,
          open: (input: SandboxIdeOpenInput, caller = owner) => service.open(input, caller),
        };
      }),
    );
  const ide = yield* make();
  const open = (id: string) =>
    Effect.gen(function* () {
      const result = yield* ide.open({
        target: { threadId: ThreadId.make(id) },
        cwd: "/workspace/same/repo",
      });
      const url = new URL(result.url, "https://t3.example");
      const sessionId = url.pathname.split("/")[3]!;
      const bootstrap = yield* ide.authorize({
        sessionId,
        requestOrigin: url.origin,
        ticket: url.searchParams.get("ticket")!,
      });
      if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
      return { url, sessionId, requestOrigin: url.origin, cookie: bootstrap.cookie };
    });
  return {
    sql,
    ide,
    clients,
    make,
    open,
    setProvisioning: (effect: Effect.Effect<void, RuntimeClient.RuntimeClientError>) => {
      provisioning = effect;
    },
  };
});
it.effect("separates identical paths in roots and inherits the parent's worker for a child", () =>
  Effect.gen(function* () {
    const { ide, open } = yield* setup;
    const one = yield* open("root-one");
    const two = yield* open("root-two");
    const child = yield* open("child");
    expect(one.url.origin).toBe(two.url.origin);
    expect(one.sessionId).not.toBe(two.sessionId);
    for (const [session, workspace] of [
      [one, "one"],
      [two, "two"],
      [child, "one"],
    ] as const) {
      const result = yield* ide.authorize(session);
      expect(result.kind === "proxy" && result.access.identity.workspaceId).toBe(workspace);
      expect(session.url.href).not.toContain("private-worker");
    }
    expect((yield* Effect.exit(ide.authorize({ ...two, cookie: one.cookie })))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* Effect.exit(ide.authorize({ ...one, requestOrigin: "https://other.example" })))._tag,
    ).toBe("Failure");
  }),
);
it.effect("consumes tickets once, rejects cross-origin requests, and expires the ticket", () =>
  Effect.gen(function* () {
    const { ide, open } = yield* setup;
    const session = yield* open("root-one");
    expect(
      (yield* Effect.exit(
        ide.authorize({
          ...session,
          ticket: session.url.searchParams.get("ticket")!,
        }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(ide.authorize({ ...session, origin: "https://central.example" })))._tag,
    ).toBe("Failure");
    const pending = new URL(
      (yield* ide.open({
        target: { threadId: ThreadId.make("root-one") },
        cwd: "/workspace/same/repo",
      })).url,
      "https://t3.example",
    );
    yield* TestClock.adjust("61 seconds");
    expect(
      (yield* Effect.exit(
        ide.authorize({
          sessionId: pending.pathname.split("/")[3]!,
          requestOrigin: pending.origin,
          ticket: pending.searchParams.get("ticket")!,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);
it.effect("preserves an established session across central restart with a live worker", () =>
  Effect.gen(function* () {
    const { open, make } = yield* setup;
    const session = yield* open("root-one");
    const restarted = yield* make();
    const result = yield* restarted.authorize(session);
    expect(result.kind).toBe("proxy");
    expect(
      (yield* Effect.exit(
        restarted.authorize({
          ...session,
          ticket: session.url.searchParams.get("ticket")!,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("rejects replaced workers before and after central restart", () =>
  Effect.gen(function* () {
    const { ide, open, clients, make } = yield* setup;
    const session = yield* open("root-one");
    clients.set("root-one", client("one", "replacement"));
    const restarted = yield* make();
    expect((yield* Effect.exit(restarted.authorize(session)))._tag).toBe("Failure");
    expect((yield* Effect.exit(ide.authorize(session)))._tag).toBe("Failure");
    const reopened = yield* restarted.open({
      target: { threadId: ThreadId.make("root-one") },
      cwd: "/workspace/same/repo",
    });
    expect(new URL(reopened.url, session.url).pathname).not.toBe(session.url.pathname);
  }),
);

it.effect("renews active sessions beyond twelve hours but expires idle sessions", () =>
  Effect.gen(function* () {
    const { ide, open, make } = yield* setup;
    const session = yield* open("root-one");
    for (let hour = 0; hour < 14; hour++) {
      yield* TestClock.adjust("1 hour");
      expect((yield* ide.authorize(session)).kind).toBe("proxy");
    }
    const restarted = yield* make();
    expect((yield* restarted.authorize(session)).kind).toBe("proxy");
    yield* TestClock.adjust("12 hours");
    expect((yield* Effect.exit(restarted.authorize(session)))._tag).toBe("Failure");
  }),
);

it.effect("does not renew sessions for requests with invalid credentials", () =>
  Effect.gen(function* () {
    const { ide, open } = yield* setup;
    const session = yield* open("root-one");
    yield* TestClock.adjust("11 hours");
    expect((yield* Effect.exit(ide.authorize({ ...session, cookie: "wrong" })))._tag).toBe(
      "Failure",
    );
    yield* TestClock.adjust("1 hour");
    expect((yield* Effect.exit(ide.authorize(session)))._tag).toBe("Failure");
  }),
);

it.effect("pins idle compute through startup and hands it to the worker lease", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const started = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    fixture.setProvisioning(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
    );
    const ide = yield* fixture.make();
    const root = ThreadId.make("root-one");
    const policy = yield* makePolicy({
      recoverSettlements: Effect.void,
      enroll: () => Effect.void,
      retire: () => Effect.void,
      collectUsage: () => Effect.void,
      enabled: true,
      idleMs: 0,
      roots: Effect.succeed([root]),
      read: () =>
        Effect.succeed({
          ownerThreadId: root,
          workspaceId: "one",
          revision: 1,
          kind: "thread",
          members: [],
          pendingEffects: false,
          settleScript: null,
        }),
      observe: () => Effect.succeed({ kind: "running", client: client("one") }),
      resume: () => Effect.die("Idle policy must not resume while IDE owns compute"),
      stop: () => Effect.die("Idle policy must not stop while IDE owns compute"),
    });
    const opening = yield* ide
      .open({ target: { threadId: root }, cwd: "/workspace/repo" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    yield* Deferred.succeed(ready, undefined);
    const url = new URL((yield* Fiber.join(opening)).url, owner.origin);
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    const session = { sessionId: url.pathname.split("/")[3]!, requestOrigin: url.origin };
    const bootstrap = yield* ide.authorize({ ...session, ticket: url.searchParams.get("ticket")! });
    if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    const proxy = yield* ide.authorize({ ...session, cookie: bootstrap.cookie });
    if (proxy.kind !== "proxy") throw new Error("Expected proxy");
    yield* proxy.connected;
    expect((yield* WorkspaceActivity).has("one")).toBe(false);
    yield* ide.open({ target: { threadId: root }, cwd: "/workspace/repo" });
    expect((yield* WorkspaceActivity).has("one")).toBe(true);
    yield* TestClock.adjust("61 seconds");
    expect((yield* WorkspaceActivity).has("one")).toBe(false);
  }),
);

it.effect("returns a relative path and binds the one-use ticket to the opening head origin", () =>
  Effect.gen(function* () {
    const { ide } = yield* setup;
    for (const origin of ["https://t3.example", "http://t3.internal:3773"]) {
      const result = yield* ide.open(
        {
          target: { threadId: ThreadId.make("root-one") },
          cwd: "/workspace/a b",
        },
        { ...owner, origin },
      );
      expect(result.url.startsWith(SandboxIde.routePrefix)).toBe(true);
      const url = new URL(result.url, origin);
      const input = { sessionId: url.pathname.split("/")[3]!, requestOrigin: origin };
      const boot = yield* ide.authorize({ ...input, ticket: url.searchParams.get("ticket")! });
      if (boot.kind !== "bootstrap") throw new Error("Expected bootstrap");
      expect(boot.secure).toBe(origin.startsWith("https:"));
      expect(boot.url.startsWith(SandboxIde.routePrefix)).toBe(true);
      expect(boot.url).not.toContain("ticket");
      expect(new URL(boot.url, origin).searchParams.get("folder")).toBe("/workspace/a b");
      expect((yield* ide.authorize({ ...input, cookie: boot.cookie, origin })).kind).toBe("proxy");
      expect(
        (yield* Effect.exit(
          ide.authorize({
            ...input,
            cookie: boot.cookie,
            requestOrigin: "https://another.example",
          }),
        ))._tag,
      ).toBe("Failure");
    }
  }),
);

it.effect("consumes a bootstrap ticket only once across concurrent central service instances", () =>
  Effect.gen(function* () {
    const { ide, make } = yield* setup;
    const other = yield* make();
    const opened = yield* ide.open({
      target: { threadId: ThreadId.make("root-one") },
      cwd: "/workspace/repo",
    });
    const url = new URL(opened.url, "https://t3.example");
    const input = {
      sessionId: url.pathname.split("/")[3]!,
      requestOrigin: url.origin,
      ticket: url.searchParams.get("ticket")!,
    };
    const results = yield* Effect.all(
      [Effect.exit(ide.authorize(input)), Effect.exit(other.authorize(input))],
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
  }),
);

it.effect("reuses the editor URL for a client while keeping every opening ticket independent", () =>
  Effect.gen(function* () {
    const { ide } = yield* setup;
    const input = { target: { threadId: ThreadId.make("root-one") }, cwd: "/workspace/repo" };
    const urls = yield* Effect.all(
      [
        ide.open({ ...input, file: "/workspace/repo/first.ts:3" }, owner),
        ide.open({ ...input, file: "/workspace/repo/second.ts:7" }, owner),
      ],
      {
        concurrency: "unbounded",
      },
    );
    const one = new URL(urls[0].url, owner.origin);
    const two = new URL(urls[1].url, owner.origin);
    expect(one.pathname).toBe(two.pathname);
    expect(one.searchParams.get("ticket")).not.toBe(two.searchParams.get("ticket"));
    const bootstrap = (url: URL) =>
      ide.authorize({
        sessionId: url.pathname.split("/")[3]!,
        requestOrigin: owner.origin,
        ticket: url.searchParams.get("ticket")!,
      });
    const first = yield* bootstrap(one);
    const second = yield* bootstrap(two);
    if (first.kind !== "bootstrap" || second.kind !== "bootstrap")
      throw new Error("Expected bootstrap");
    expect(new URL(first.url, owner.origin).searchParams.get("payload")).toContain("first.ts%3A3");
    expect(new URL(second.url, owner.origin).searchParams.get("payload")).toContain(
      "second.ts%3A7",
    );
    expect(
      first.kind === "bootstrap" && second.kind === "bootstrap" && first.cookie === second.cookie,
    ).toBe(true);
    expect((yield* Effect.exit(bootstrap(one)))._tag).toBe("Failure");
    const anotherClient = new URL(
      (yield* ide.open(input, {
        ...owner,
        authSessionId: AuthSessionId.make("browser-two"),
      })).url,
      owner.origin,
    );
    expect(anotherClient.pathname).not.toBe(one.pathname);
    const anotherOrigin = new URL(
      (yield* ide.open(input, {
        ...owner,
        origin: "https://another.example",
      })).url,
      "https://another.example",
    );
    expect(anotherOrigin.pathname).not.toBe(one.pathname);
  }),
);

it.effect("opens project workspaces before a thread exists and isolates identical file paths", () =>
  Effect.gen(function* () {
    const { ide } = yield* setup;
    const sessions = [];
    for (const projectId of [ProjectId.make("first"), ProjectId.make("second")]) {
      const result = yield* ide.open({ target: { projectId }, cwd: "/workspace/repo" });
      const url = new URL(result.url, "https://t3.example");
      const request = { sessionId: url.pathname.split("/")[3]!, requestOrigin: url.origin };
      const bootstrap = yield* ide.authorize({
        ...request,
        ticket: url.searchParams.get("ticket")!,
      });
      if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
      const proxy = yield* ide.authorize({ ...request, cookie: bootstrap.cookie });
      expect(proxy.kind === "proxy" && proxy.access.identity.workspaceId).toBe(
        `t3:utility:project:${projectId}`,
      );
      sessions.push({ ...request, cookie: bootstrap.cookie });
    }
    expect(
      (yield* Effect.exit(ide.authorize({ ...sessions[0]!, cookie: sessions[1]!.cookie })))._tag,
    ).toBe("Failure");
  }),
);

it.effect("preserves file paths, line and column in the VS Code workspace payload", () =>
  Effect.gen(function* () {
    const { ide } = yield* setup;
    for (const origin of ["https://remote.example", "http://t3.internal:3773"]) {
      const file = "/workspace/a b/src/odd #?&%.ts:12:4";
      const result = yield* ide.open(
        {
          target: { threadId: ThreadId.make("root-one") },
          cwd: "/workspace/a b",
          file,
        },
        { ...owner, origin },
      );
      const url = new URL(result.url, origin);
      const bootstrap = yield* ide.authorize({
        sessionId: url.pathname.split("/")[3]!,
        requestOrigin: origin,
        ticket: url.searchParams.get("ticket")!,
      });
      if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
      const redirected = new URL(bootstrap.url, origin);
      expect(redirected.searchParams.get("folder")).toBe("/workspace/a b");
      const expectedFile = `vscode-remote://${new URL(origin).host}/workspace/a%20b/src/odd%20%23%3F%26%25.ts%3A12%3A4`;
      expect(JSON.parse(redirected.searchParams.get("payload")!)).toEqual([
        ["openFile", expectedFile],
        ["gotoLineMode", "true"],
      ]);
      expect(bootstrap.url).not.toContain("ticket");
      expect(bootstrap.url).not.toContain("private-worker");
    }
  }),
);

it.effect("fails closed when either a thread or project worker is unavailable", () =>
  Effect.gen(function* () {
    const { ide, setProvisioning } = yield* setup;
    setProvisioning(
      Effect.fail(
        new RuntimeClient.RuntimeClientError({ operation: "ensure-running", cause: "offline" }),
      ),
    );
    for (const target of [
      { threadId: ThreadId.make("root-one") },
      { projectId: ProjectId.make("project") },
    ]) {
      const error = yield* ide
        .open({ target, cwd: "/workspace/repo", file: "/workspace/repo/file.ts:2" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
    }
    expect((yield* WorkspaceActivity).has("one")).toBe(false);
    expect((yield* WorkspaceActivity).has("t3:utility:project:project")).toBe(false);
  }),
);

it.effect.each(["revoke", "expire", "remove", "scope"])(
  "rejects established IDE access when its owning app session changes: %s",
  (invalidation) =>
    Effect.gen(function* () {
      const { ide, open, sql, make } = yield* setup;
      const session = yield* open("root-one");
      if (invalidation === "revoke")
        yield* sql`UPDATE auth_sessions SET revoked_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${owner.authSessionId}`;
      else if (invalidation === "expire")
        yield* sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${owner.authSessionId}`;
      else if (invalidation === "scope")
        yield* sql`UPDATE auth_sessions SET scopes = '[]' WHERE session_id = ${owner.authSessionId}`;
      else yield* sql`DELETE FROM auth_sessions WHERE session_id = ${owner.authSessionId}`;
      const restarted = yield* make();
      expect((yield* restarted.authorize(session).pipe(Effect.flip)).reason).toBe("forbidden");
      expect((yield* Effect.exit(ide.authorize(session)))._tag).toBe("Failure");
    }),
);

it.effect("rejects an unredeemed IDE ticket after its app session is revoked", () =>
  Effect.gen(function* () {
    const { ide, sql } = yield* setup;
    const opened = yield* ide.open({
      target: { threadId: ThreadId.make("root-one") },
      cwd: "/workspace/repo",
    });
    yield* sql`UPDATE auth_sessions SET revoked_at = '1970-01-01T00:00:00.000Z' WHERE session_id = ${owner.authSessionId}`;
    const url = new URL(opened.url, owner.origin);
    expect(
      (yield* ide
        .authorize({
          sessionId: url.pathname.split("/")[3]!,
          requestOrigin: owner.origin,
          ticket: url.searchParams.get("ticket")!,
        })
        .pipe(Effect.flip)).reason,
    ).toBe("forbidden");
  }),
);
