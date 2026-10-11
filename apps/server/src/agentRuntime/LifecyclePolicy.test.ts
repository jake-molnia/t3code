import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import {
  WorkspaceActivity,
  WorkspaceRecentActivity,
  withWorkspaceActivity,
} from "./WorkspaceActivity.ts";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import {
  ExecutionIdentity,
  ExecutionResult,
} from "../../../../packages/contracts/src/execution.ts";
import * as Policy from "./LifecyclePolicy.ts";

const root = ThreadId.make("root");
const child = ThreadId.make("child");
const at = DateTime.makeUnsafe(1_000);
const scriptResult = {
  stdout: "",
  stderr: "",
  code: 0,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
const identity = Schema.decodeUnknownSync(ExecutionIdentity)({
  workspaceId: "workspace",
  allocationId: "allocation",
  generation: 1,
  incarnation: "incarnation",
  podUid: "pod",
  protocolVersion: 1,
});

function member(id = root): Policy.LifecycleMember {
  return {
    thread: {
      id,
      status: "completed",
      activeRunId: null,
      activityRunStatus: null,
      pendingBackgroundTasks: [],
      createdAt: at,
      latestUserMessageAt: at,
      latestRunCompletedAt: at,
      settledAt: at,
      settledOverride: "settled",
    },
    runs: [],
    requests: [],
    subagents: [],
    nativeBackground: false,
    unassignedUserMessages: false,
  };
}
function snapshot(members = [member()]): Policy.LifecycleSnapshot {
  return {
    ownerThreadId: root,
    workspaceId: "workspace",
    revision: 10,
    kind: "thread",
    members,
    pendingEffects: false,
    settleScript: {
      cwd: "/workspace",
      command: "/bin/sh",
      args: ["-c", "cleanup"],
      timeoutMs: 1_000,
    },
  };
}

const Request = Schema.Struct({
  method: Schema.String,
  operationId: Schema.String,
  input: Schema.Unknown,
});
const decodeRequest = Schema.decodeUnknownSync(Request);

function harness(initial = snapshot()) {
  let current = initial;
  let stopped = false;
  let resumes = 0;
  let scriptRuns = 0;
  let script: () => Promise<typeof scriptResult> = async () => scriptResult;
  const stops: Array<{ action: string; operationId: string; revision: number }> = [];
  const methods: string[] = [];
  const operations = new Map<
    string,
    { state: "running" | "completed"; result?: typeof ExecutionResult.Type }
  >();
  const client = createExecutionClient({
    endpoint: "http://worker.test",
    token: "test-token",
    identity,
    fetch: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.startsWith("/v1/operations/"))
        return Response.json(
          operations.get(decodeURIComponent(pathname.slice("/v1/operations/".length))) ?? {
            state: "missing",
          },
        );
      const request = decodeRequest(JSON.parse(String(init?.body)));
      methods.push(request.method);
      if (request.method === "terminals.list") return Response.json({ ok: true, value: [] });
      if (request.method === "terminals.closeIdle") return Response.json({ ok: true, value: null });
      if (request.method !== "scripts.settle") throw new Error("Unexpected worker method");
      operations.set(request.operationId, { state: "running" });
      scriptRuns++;
      const value = await script();
      const result = { ok: true, value } satisfies typeof ExecutionResult.Type;
      operations.set(request.operationId, { state: "completed", result });
      return Response.json(result);
    },
  });
  const ports: Policy.LifecyclePolicyPorts = {
    collectUsage: () => Effect.void,
    enabled: true,
    idleMs: 0,
    roots: Effect.succeed([root]),
    read: () => Effect.sync(() => current),
    observe: () =>
      Effect.sync(() =>
        stopped ? ({ kind: "stopped" } as const) : ({ kind: "running", client } as const),
      ),
    resume: () =>
      Effect.sync(() => {
        stopped = false;
        resumes++;
        return client;
      }),
    stop: (view, action, operationId) =>
      Effect.sync(() => {
        stops.push({ action, operationId, revision: view.revision });
      }),
  };
  return {
    ports,
    methods,
    stops,
    operations,
    resumes: () => resumes,
    scriptRuns: () => scriptRuns,
    setSnapshot: (next: Policy.LifecycleSnapshot) => {
      current = next;
    },
    setStopped: () => {
      stopped = true;
    },
    setScript: (next: () => Promise<typeof scriptResult>) => {
      script = next;
    },
  };
}

it.effect(
  "holds compute throughout a pending workspace request and releases its intent on interruption",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const policy = yield* Policy.makePolicy(h.ports);
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const request = yield* withWorkspaceActivity(
        "workspace",
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(yield* policy.reconcileThread(root)).toBe("busy");
      expect(h.stops).toEqual([]);
      expect(h.methods).toEqual([]);
      yield* Fiber.interrupt(request);
      expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
      expect(h.stops).toHaveLength(1);
    }).pipe(Effect.provideService(WorkspaceActivity, new Map()), Effect.scoped),
);

it.effect(
  "does not submit an idle decision when a workspace request starts after its snapshot",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const begin = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const request = yield* Effect.gen(function* () {
        yield* Deferred.await(begin);
        yield* withWorkspaceActivity(
          "workspace",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(finish);
          }),
        );
      }).pipe(Effect.forkChild);
      let observations = 0;
      const policy = yield* Policy.makePolicy({
        ...h.ports,
        observe: (workspaceId) =>
          Effect.gen(function* () {
            if (++observations === 2) {
              yield* Deferred.succeed(begin, undefined);
              yield* Deferred.await(entered);
            }
            return yield* h.ports.observe(workspaceId);
          }),
      });
      expect(yield* policy.reconcileThread(root)).toBe("busy");
      expect(h.stops).toEqual([]);
      yield* Fiber.interrupt(request);
    }).pipe(Effect.provideService(WorkspaceActivity, new Map()), Effect.scoped),
);

it.effect("never stops a root waiting while a bound child runs", () =>
  Effect.gen(function* () {
    const waiting = member();
    waiting.thread = { ...waiting.thread, status: "waiting" };
    const running = member(child);
    running.thread = { ...running.thread, status: "running" };
    const h = harness(snapshot([waiting, running]));
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("busy");
    expect(h.stops).toEqual([]);
    expect(h.methods).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("does not release compute after a failed cleanup", () =>
  Effect.gen(function* () {
    const h = harness();
    h.setScript(async () => ({ ...scriptResult, code: 1 }));
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root).pipe(Effect.flip)).toBeInstanceOf(
      Policy.LifecyclePolicyError,
    );
    expect(h.stops).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("waits for a slow cleanup before submitting release", () =>
  Effect.gen(function* () {
    const h = harness();
    let announceStart = () => {};
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    let finish = (_result: typeof scriptResult) => {};
    const result = new Promise<typeof scriptResult>((resolve) => {
      finish = resolve;
    });
    h.setScript(async () => {
      announceStart();
      return await result;
    });
    const policy = yield* Policy.makePolicy(h.ports);
    const running = yield* policy.reconcileThread(root).pipe(Effect.forkScoped);
    yield* Effect.promise(() => started);
    expect(h.stops).toEqual([]);
    finish(scriptResult);
    expect(yield* Fiber.join(running)).toBe("release-submitted");
    expect(h.stops).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("reconstructs settled cleanup after restart without rerunning a completed script", () =>
  Effect.gen(function* () {
    const h = harness();
    const first = yield* Policy.makePolicy(h.ports);
    expect(yield* first.reconcileThread(root)).toBe("release-submitted");
    const second = yield* Policy.makePolicy(h.ports);
    expect(yield* second.reconcileThread(root)).toBe("release-submitted");
    expect(h.scriptRuns()).toBe(1);
    expect(h.stops[0]?.operationId).toBe(h.stops[1]?.operationId);
  }).pipe(Effect.scoped),
);

it.effect("does not wake or inspect terminals in a stopped workspace", () =>
  Effect.gen(function* () {
    const h = harness({
      ...snapshot([
        { ...member(), thread: { ...member().thread, settledOverride: null, settledAt: null } },
      ]),
      settleScript: null,
    });
    h.setStopped();
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("stopped");
    expect(yield* policy.reconcileThread(root)).toBe("stopped");
    expect(h.stops).toEqual([]);
    expect(h.methods).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("fences release when new work changes revision during cleanup", () =>
  Effect.gen(function* () {
    const h = harness();
    h.setScript(async () => {
      h.setSnapshot({ ...snapshot(), revision: 11, pendingEffects: true });
      return scriptResult;
    });
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("stale");
    expect(h.stops).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("keeps unknown script outcomes and child settlement from releasing a workspace", () =>
  Effect.gen(function* () {
    const h = harness();
    h.operations.set("settle:root:1000:incarnation", { state: "running" });
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("script-running");
    expect(yield* policy.reconcileThread(child)).toBe("busy");
    expect(h.scriptRuns()).toBe(0);
    expect(h.stops).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("suspends an idle utility without treating observations as new activity", () =>
  Effect.gen(function* () {
    const h = harness({ ...snapshot(), kind: "utility", members: [], settleScript: null });
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("suspend-submitted");
    expect(h.scriptRuns()).toBe(0);
    expect(h.stops[0]?.action).toBe("suspend");
  }).pipe(Effect.scoped),
);

it.effect("resumes an idle-suspended root only to finish pending settled cleanup", () =>
  Effect.gen(function* () {
    const h = harness();
    h.setStopped();
    const policy = yield* Policy.makePolicy(h.ports);
    expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
    expect(h.resumes()).toBe(1);
    expect(h.scriptRuns()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("releases a proven suspended settlement without waking compute", () =>
  Effect.gen(function* () {
    const h = harness({ ...snapshot(), settlementProven: true });
    const policy = yield* Policy.makePolicy({
      ...h.ports,
      observe: () => Effect.succeed({ kind: "stopped", phase: "suspended", identity }),
    });
    expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
    expect(h.resumes()).toBe(0);
    expect(h.scriptRuns()).toBe(0);
    expect(h.methods).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "recent completed workspace use grants idle grace on old threads (settled: %s)",
  (settled) =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 hour");
      const participant = member();
      if (!settled) participant.thread = { ...participant.thread, settledOverride: "active" };
      const view = snapshot([participant]);
      const h = harness(view);
      const policy = yield* Policy.makePolicy({ ...h.ports, idleMs: 60_000 });
      yield* withWorkspaceActivity("workspace", TestClock.adjust("10 minutes"));
      expect(yield* policy.reconcileThread(root)).toBe("grace");
      expect(h.methods).toEqual([]);
      yield* TestClock.adjust("30 seconds");
      for (let i = 0; i < 3; i++) {
        yield* h.ports.observe("workspace");
        expect(yield* policy.reconcileThread(root)).toBe("grace");
      }
      yield* TestClock.adjust("30 seconds");
      expect(yield* policy.reconcileThread(root)).toBe(
        settled ? "release-submitted" : "suspend-submitted",
      );
      expect(h.stops).toHaveLength(1);
    }).pipe(
      Effect.provideService(WorkspaceActivity, new Map()),
      Effect.provideService(WorkspaceRecentActivity, new Map()),
      Effect.scoped,
    ),
);

it.effect("completed input during a lifecycle observation prevents idle terminal cleanup", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 hour");
    const h = harness();
    const policy = yield* Policy.makePolicy({
      ...h.ports,
      idleMs: 60_000,
      observe: (workspaceId) => withWorkspaceActivity(workspaceId, h.ports.observe(workspaceId)),
    });
    expect(yield* policy.reconcileThread(root)).toBe("grace");
    expect(h.methods).not.toContain("terminals.closeIdle");
    expect(h.stops).toEqual([]);
  }).pipe(
    Effect.provideService(WorkspaceActivity, new Map()),
    Effect.provideService(WorkspaceRecentActivity, new Map()),
    Effect.scoped,
  ),
);

it.effect("bounds recent workspace activity without retaining completed active leases", () =>
  Effect.gen(function* () {
    const active = yield* WorkspaceActivity;
    const recent = yield* WorkspaceRecentActivity;
    for (let index = 0; index < 1025; index++)
      yield* withWorkspaceActivity(`workspace-${index}`, Effect.void);
    expect(active.size).toBe(0);
    expect(recent.size).toBe(1024);
    expect(recent.has("workspace-0")).toBe(false);
    expect(recent.has("workspace-1024")).toBe(true);
  }).pipe(
    Effect.provideService(WorkspaceActivity, new Map()),
    Effect.provideService(WorkspaceRecentActivity, new Map()),
  ),
);

it.effect.each(["running", "suspended"] as const)(
  "settlement releases %s compute without grace for completed pre-settlement requests",
  (phase) =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 second");
      yield* withWorkspaceActivity("workspace", Effect.void);
      const h = harness({ ...snapshot(), settleScript: null });
      const policy = yield* Policy.makePolicy({
        ...h.ports,
        idleMs: 60_000,
        observe:
          phase === "running"
            ? h.ports.observe
            : () =>
                Effect.succeed({
                  kind: "stopped",
                  phase: "suspended",
                  identity,
                }),
      });
      // Equal timestamps are also pre-settlement: the explicit settle wins.
      expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
      expect(h.stops).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      h.setSnapshot({
        ...snapshot([
          { ...member(), thread: { ...member().thread, settledAt: DateTime.makeUnsafe(2_000) } },
        ]),
        settleScript: null,
      });
      expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
      expect(h.stops).toHaveLength(2);
    }).pipe(
      Effect.provideService(WorkspaceActivity, new Map()),
      Effect.provideService(WorkspaceRecentActivity, new Map()),
      Effect.scoped,
    ),
);

it.effect("completed use after settlement during observation retains compute", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("2 seconds");
    const h = harness();
    const policy = yield* Policy.makePolicy({
      ...h.ports,
      idleMs: 60_000,
      observe: (workspaceId) => withWorkspaceActivity(workspaceId, h.ports.observe(workspaceId)),
    });
    expect(yield* policy.reconcileThread(root)).toBe("grace");
    expect(h.stops).toEqual([]);
    expect(h.methods).toEqual([]);
  }).pipe(
    Effect.provideService(WorkspaceActivity, new Map()),
    Effect.provideService(WorkspaceRecentActivity, new Map()),
    Effect.scoped,
  ),
);

it.effect(
  "collects usage on busy workspaces before the activity guard without changing idle grace",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const collected: boolean[] = [];
      const activity = new Map([["workspace", 1]]);
      const recent = new Map<string, number>();
      const policy = yield* Policy.makePolicy({
        ...h.ports,
        collectUsage: (_client, force) =>
          Effect.sync(() => {
            collected.push(force);
          }),
      }).pipe(
        Effect.provideService(WorkspaceActivity, activity),
        Effect.provideService(WorkspaceRecentActivity, recent),
      );
      expect(
        yield* policy
          .reconcileThread(root)
          .pipe(
            Effect.provideService(WorkspaceActivity, activity),
            Effect.provideService(WorkspaceRecentActivity, recent),
          ),
      ).toBe("busy");
      expect(collected).toEqual([false]);
      expect(recent.size).toBe(0);
      expect(h.stops).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "forces history capture after the settle script and before stopping, retaining compute on failure",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const order: string[] = [];
      h.setScript(async () => {
        order.push("script");
        return scriptResult;
      });
      let fail = true;
      const policy = yield* Policy.makePolicy({
        ...h.ports,
        collectUsage: (_client, force) =>
          Effect.gen(function* () {
            order.push(force ? "final-history" : "periodic-history");
            if (force && fail)
              return yield* new Policy.LifecyclePolicyError({
                operation: "collect-usage",
                cause: "unread history",
              });
          }),
        stop: (...args) =>
          Effect.sync(() => {
            order.push("stop");
          }).pipe(Effect.andThen(h.ports.stop(...args))),
      });
      expect((yield* policy.reconcileThread(root).pipe(Effect.exit))._tag).toBe("Failure");
      expect(order).toEqual(["periodic-history", "script", "final-history"]);
      expect(h.stops).toEqual([]);
      fail = false;
      expect(yield* policy.reconcileThread(root)).toBe("release-submitted");
      expect(order.slice(-2)).toEqual(["final-history", "stop"]);
      expect(h.scriptRuns()).toBe(1);
    }).pipe(Effect.scoped),
);
