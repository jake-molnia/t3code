import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Scope from "effect/Scope";
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
      ),
    ).pipe(Effect.map((context) => Context.get(context, SandboxIde.SandboxIde)));
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
it.effect("rejects sessions when their worker is replaced", () =>
  Effect.gen(function* () {
    const { ide, open, clients } = yield* setup;
    const session = yield* open("root-one");
    clients.set("root-one", client("one", "replacement"));
    expect((yield* ide.authorize(session).pipe(Effect.flip)).reason).toBe("identity_changed");
    const replacement = yield* open("root-one");
    const proxy = yield* ide.authorize(replacement);
    expect(proxy.kind === "proxy" && proxy.access.identity.incarnation).toBe("replacement");
  }),
);
it.effect("reopens a live worker after central restart with a fresh IDE session", () =>
  Effect.gen(function* () {
    const { open, make } = yield* setup;
    const session = yield* open("root-one");
    const restarted = yield* make();
    expect((yield* restarted.authorize(session).pipe(Effect.flip)).reason).toBe("expired");
    const result = yield* restarted.open({
      target: { threadId: ThreadId.make("root-one") },
      cwd: "/workspace/same/repo",
    });
    const url = new URL(result.url, session.requestOrigin);
    const request = { sessionId: url.pathname.split("/")[3]!, requestOrigin: url.origin };
    const boot = yield* restarted.authorize({
      ...request,
      ticket: url.searchParams.get("ticket")!,
    });
    if (boot.kind !== "bootstrap") throw new Error("Expected bootstrap");
    const proxy = yield* restarted.authorize({ ...request, cookie: boot.cookie });
    expect(proxy.kind === "proxy" && proxy.access.identity).toEqual(client("one").identity);
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
    const url = new URL((yield* Fiber.join(opening)).url, "http://t3.internal:3773");
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
      const result = yield* ide.open({
        target: { threadId: ThreadId.make("root-one") },
        cwd: "/workspace/a b",
      });
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
      const result = yield* ide.open({
        target: { threadId: ThreadId.make("root-one") },
        cwd: "/workspace/a b",
        file,
      });
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
