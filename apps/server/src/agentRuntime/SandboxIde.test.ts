import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
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
  let provisioning: Effect.Effect<void> = Effect.void;
  const runtime = RuntimeClient.RuntimeClient.of({
    ideOrigin: (identity) =>
      provisioning.pipe(
        Effect.as(
          `https://t3-ide-${identity.workspaceId === "two" ? "b".repeat(32) : "a".repeat(32)}.example.ts.net`,
        ),
      ),
    enabled: true,
    forThread: (id, _driver, scope) =>
      Effect.gen(function* () {
        const found = current(id);
        if (scope)
          yield* acquireWorkspaceActivity(found.identity.workspaceId).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
        return found;
      }),
    observeThread: (id) => Effect.sync(() => ({ kind: "running", client: current(id) })),
    forWorkspace: (id) => Effect.succeed(client(id)),
    forUtility: (id) => Effect.succeed(client(id)),
    observeWorkspace: (id) => Effect.succeed({ kind: "running", client: client(id) }),
    sessionResidency: () => Effect.succeed(null),
    rememberSession: () => Effect.void,
    getEventCursor: () => Effect.succeed(0),
    stop: () => Effect.void,
  });
  const make = (privateOrigin = false) =>
    Layer.build(
      SandboxIde.layer.pipe(
        Layer.provide(Layer.succeed(RuntimeClient.RuntimeClient, runtime)),
        Layer.provide(NodeCrypto.layer),
      ),
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(
          privateOrigin
            ? { T3CODE_SANDBOX_IDE_DOMAIN: "example.ts.net" }
            : { T3CODE_SANDBOX_IDE_ORIGIN: "https://ide.example" },
        ),
      ),
      Effect.map((context) => Context.get(context, SandboxIde.SandboxIde)),
    );
  const ide = yield* make();
  const open = (id: string) =>
    Effect.gen(function* () {
      const result = yield* ide.open({
        threadId: ThreadId.make(id),
        cwd: "/workspace/same/repo",
      });
      const url = new URL(result.url);
      const sessionId = url.pathname.split("/")[3]!;
      const bootstrap = yield* ide.authorize({
        sessionId,
        host: url.host,
        ticket: url.searchParams.get("ticket")!,
      });
      if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
      return { url, sessionId, host: url.host, cookie: bootstrap.cookie };
    });
  return {
    ide,
    clients,
    make,
    open,
    setProvisioning: (effect: Effect.Effect<void>) => {
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
    expect(one.host).not.toBe(two.host);
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
    expect((yield* Effect.exit(ide.authorize({ ...one, host: two.host })))._tag).toBe("Failure");
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
        threadId: ThreadId.make("root-one"),
        cwd: "/workspace/same/repo",
      })).url,
    );
    yield* TestClock.adjust("61 seconds");
    expect(
      (yield* Effect.exit(
        ide.authorize({
          sessionId: pending.pathname.split("/")[3]!,
          host: pending.host,
          ticket: pending.searchParams.get("ticket")!,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);
it.effect(
  "rejects replaced workers and central-restart sessions while reopening the live worker",
  () =>
    Effect.gen(function* () {
      const { ide, open, clients, make } = yield* setup;
      const session = yield* open("root-one");
      clients.set("root-one", client("one", "replacement"));
      expect((yield* Effect.exit(ide.authorize(session)))._tag).toBe("Failure");
      const restarted = yield* make();
      expect((yield* Effect.exit(restarted.authorize(session)))._tag).toBe("Failure");
      const reopened = yield* restarted.open({
        threadId: ThreadId.make("root-one"),
        cwd: "/workspace/same/repo",
      });
      expect(reopened.url).not.toBe(session.url.toString());
    }),
);

it.effect("uses runtime-provisioned private workspace origins and keeps sessions distinct", () =>
  Effect.gen(function* () {
    const { make } = yield* setup;
    const ide = yield* make(true);
    const urls = [];
    for (const id of ["root-one", "child", "root-two"]) {
      urls.push(
        new URL(
          (yield* ide.open({
            threadId: ThreadId.make(id),
            cwd: "/workspace/repo",
          })).url,
        ),
      );
    }
    expect(urls[0]!.host).toBe(urls[1]!.host);
    expect(urls[0]!.pathname).not.toBe(urls[1]!.pathname);
    expect(urls[0]!.host).not.toBe(urls[2]!.host);
    const one = urls[0]!;
    const id = one.pathname.split("/")[3]!;
    const bootstrap = yield* ide.authorize({
      sessionId: id,
      host: one.host,
      ticket: one.searchParams.get("ticket")!,
    });
    if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
    expect(
      (yield* Effect.exit(
        ide.authorize({
          sessionId: id,
          host: urls[2]!.host,
          cookie: bootstrap.cookie,
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("pins idle compute through HTTPS provisioning and hands it to the worker lease", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const started = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    fixture.setProvisioning(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
    );
    const ide = yield* fixture.make(true);
    const root = ThreadId.make("root-one");
    const policy = yield* makePolicy({
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
      observe: () => Effect.die("Idle policy must not observe while IDE owns compute"),
      resume: () => Effect.die("Idle policy must not resume while IDE owns compute"),
      stop: () => Effect.die("Idle policy must not stop while IDE owns compute"),
    });
    const opening = yield* ide
      .open({ threadId: root, cwd: "/workspace/repo" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    yield* Deferred.succeed(ready, undefined);
    const url = new URL((yield* Fiber.join(opening)).url);
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    const session = { sessionId: url.pathname.split("/")[3]!, host: url.host };
    const bootstrap = yield* ide.authorize({ ...session, ticket: url.searchParams.get("ticket")! });
    if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap");
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    const proxy = yield* ide.authorize({ ...session, cookie: bootstrap.cookie });
    if (proxy.kind !== "proxy") throw new Error("Expected proxy");
    yield* proxy.connected;
    expect((yield* WorkspaceActivity).has("one")).toBe(false);
    yield* ide.open({ threadId: root, cwd: "/workspace/repo" });
    expect((yield* WorkspaceActivity).has("one")).toBe(true);
    yield* TestClock.adjust("61 seconds");
    expect((yield* WorkspaceActivity).has("one")).toBe(false);
  }),
);
