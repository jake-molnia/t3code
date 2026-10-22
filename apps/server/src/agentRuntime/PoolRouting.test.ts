import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ExecutionPoolId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import {
  SandboxLifecycle,
  SandboxLifecycleError,
  type WorkspaceResource,
} from "../sandbox/SandboxLifecycle.ts";
import type { Placement } from "../sandbox/Configuration.ts";
import { placement, poolsLayer } from "./testkit/Sandbox.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as Runtime from "./RuntimeClient.ts";
import * as Bindings from "./Bindings.ts";

const services = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
type Operation = {
  workspaceId: string;
  profile: string;
  desiredState: "running" | "suspended" | "released";
  version: string;
};
const lifecycleFixture = (name: string) => {
  const operations: Operation[] = [];
  const reads: Array<{ workspaceId: string; profile: string }> = [];
  const states = new Map<string, Operation>();
  const health: {
    failNextStop: boolean;
    workspaceStatus: number;
    workspacePhase: WorkspaceResource["state"];
  } = { failNextStop: false, workspaceStatus: 200, workspacePhase: "running" };
  const resource = (state: Operation): WorkspaceResource => {
    const identity = {
      workspaceId: state.workspaceId,
      allocationId: `${name}-allocation`,
      generation: 1,
      incarnation: `${name}-worker`,
      podUid: `${name}-pod`,
      protocolVersion: 1 as const,
    };
    const phase = state.desiredState === "running" ? health.workspacePhase : state.desiredState;
    return {
      id: state.workspaceId,
      pool: name,
      profile: state.profile,
      desiredState: state.desiredState,
      state: phase,
      version: state.version,
      progress: null,
      error: null,
      identity,
      execution:
        phase === "running"
          ? {
              identity,
              endpoint: `http://worker.invalid/${name}/${encodeURIComponent(state.workspaceId)}`,
              token: "worker-private-token",
            }
          : null,
    };
  };
  const check = (workspaceId: string) =>
    Effect.gen(function* () {
      if (health.workspaceStatus !== 200)
        return yield* new SandboxLifecycleError({
          operation: "observe",
          httpStatus: health.workspaceStatus,
          cause: "unavailable",
        });
      const state = states.get(workspaceId);
      if (!state)
        return yield* new SandboxLifecycleError({
          operation: "observe",
          httpStatus: 404,
          cause: "missing",
        });
      return state;
    });
  const lifecycle = SandboxLifecycle.of({
    ensure: (workspaceId, target) =>
      Effect.gen(function* () {
        expect(target.id).toBe(name);
        if (!states.has(workspaceId))
          states.set(workspaceId, {
            workspaceId,
            profile: target.profile,
            desiredState: "released",
            version: "0",
          });
        return resource(yield* check(workspaceId));
      }),
    observe: (workspaceId) =>
      Effect.gen(function* () {
        const state = yield* check(workspaceId);
        reads.push({ workspaceId, profile: state.profile });
        return resource(state);
      }),
    setDesiredState: (workspaceId, _target, desiredState, version) =>
      Effect.gen(function* () {
        const state = yield* check(workspaceId);
        operations.push({ ...state, desiredState, version });
        if (health.failNextStop && desiredState !== "running") {
          health.failNextStop = false;
          return yield* new SandboxLifecycleError({
            operation: "setDesiredState",
            httpStatus: 503,
            cause: "unavailable",
          });
        }
        if (version !== state.version)
          return yield* new SandboxLifecycleError({
            operation: "setDesiredState",
            httpStatus: 412,
            cause: "conflict",
          });
        const updated = { ...state, desiredState, version: String(Number(state.version) + 1) };
        states.set(workspaceId, updated);
        return resource(updated);
      }),
  });
  return { name, operations, reads, health, lifecycle };
};

const fixture = Effect.sync(() => {
  const a = lifecycleFixture("gompers");
  const b = lifecycleFixture("portal");
  const entries = [placement(a.name, `${a.name}-v1`), placement(b.name, `${b.name}-v1`)];
  let configured = entries;
  let defaultPoolId = entries[0]!.id;
  const lifecycle = Layer.succeed(SandboxLifecycle, {
    ensure: (id, target) => (target.id === a.name ? a : b).lifecycle.ensure(id, target),
    observe: (id, target) => (target.id === a.name ? a : b).lifecycle.observe(id, target),
    setDesiredState: (id, target, state, version) =>
      (target.id === a.name ? a : b).lifecycle.setDesiredState(id, target, state, version),
  });
  const writeConfig = (id: string, pools: Placement[] = entries) =>
    Effect.sync(() => {
      configured = pools;
      defaultPoolId = ExecutionPoolId.make(id);
    });
  const runtime = () =>
    Runtime.RuntimeClient.pipe(
      Effect.provide(
        Runtime.layer.pipe(
          Layer.provide(poolsLayer(configured, defaultPoolId)),
          Layer.provide(lifecycle),
        ),
      ),
    );
  return { a, b, entries, writeConfig, runtime };
});

function thread(
  id: string,
  pool?: string,
  parent?: OrchestrationV2AppThread,
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    ...v2Projection.thread,
    id: threadId,
    ...(pool ? { executionPoolId: ExecutionPoolId.make(pool) } : {}),
    title: id,
    lineage: {
      parentThreadId: parent?.id ?? null,
      relationshipToParent: parent ? "subagent" : null,
      rootThreadId: parent?.id ?? threadId,
    },
  };
}
const create = (threads: readonly OrchestrationV2AppThread[]) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: threads.map((value) => ({
        id: EventId.make(`pool-create:${value.id}`),
        type: "thread.created" as const,
        threadId: value.id,
        providerInstanceId: value.providerInstanceId,
        occurredAt: value.createdAt,
        payload: value,
      })),
    });
  });

it.layer(services, { excludeTestServices: true })("durable execution pool routing", (it) => {
  it.effect(
    "routes roots to distinct sandbox placements and all descendants to their owner's placement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const a = thread("pools-a", "gompers");
          const b = thread("pools-b", "portal");
          const child = thread("pools-child", undefined, b);
          const grandchild = thread("pools-grandchild", undefined, child);
          yield* create([a, b, child, grandchild]);
          const runtime = yield* f.runtime();
          const aClient = yield* runtime.forThread(a.id);
          const bClient = yield* runtime.forThread(b.id);
          const childClient = yield* runtime.forThread(child.id);
          const grandchildClient = yield* runtime.forThread(grandchild.id);
          expect(aClient.identity.allocationId).toBe("gompers-allocation");
          expect(bClient.identity.allocationId).toBe("portal-allocation");
          expect(childClient.identity).toEqual(bClient.identity);
          expect(grandchildClient.identity).toEqual(bClient.identity);
          expect(aClient.identity.workspaceId).not.toBe(bClient.identity.workspaceId);
          expect(f.a.operations.map((operation) => operation.workspaceId)).toEqual([
            aClient.identity.workspaceId,
          ]);
          expect(
            f.b.operations.every(
              (operation) => operation.workspaceId === bClient.identity.workspaceId,
            ),
          ).toBe(true);
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const shell = yield* projections.getShellSnapshot();
          expect(shell.threads.find((value) => value.id === b.id)?.executionPoolId).toBe("portal");
        }),
      ),
  );

  it.effect("classifies only pending sandbox observations for provider acquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const root = thread("pending-observation");
        yield* create([root]);
        const runtime = yield* f.runtime();
        yield* runtime.forThread(root.id);
        for (const phase of [
          "starting",
          "suspending",
          "releasing",
          "failed",
          "unavailable",
        ] as const) {
          f.a.health.workspacePhase = phase;
          expect(
            Runtime.isWorkerObservationPending(
              yield* runtime.observeThread(root.id).pipe(Effect.flip),
            ),
          ).toBe(["starting", "suspending", "releasing", "unavailable"].includes(phase));
        }
        f.a.health.workspacePhase = "running";
        for (const status of [503, 401, 403, 404, 409]) {
          f.a.health.workspaceStatus = status;
          expect(
            Runtime.isWorkerObservationPending(
              yield* runtime.observeThread(root.id).pipe(Effect.flip),
            ),
          ).toBe(status === 503);
        }
      }),
    ),
  );

  it.effect(
    "pins the original pool and profile through configuration changes, observe, and failed-stop retries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const root = thread("pools-pinned");
          yield* create([root]);
          const first = yield* f.runtime();
          const client = yield* first.forThread(root.id);
          yield* f.writeConfig(
            "portal",
            f.entries.map((entry) => ({ ...entry, profile: `${entry.id}-v2` })),
          );
          const restarted = yield* f.runtime();
          expect((yield* restarted.forThread(root.id)).identity).toEqual(client.identity);
          const observed = yield* restarted.observeThread(root.id);
          expect(observed.kind).toBe("running");
          const binding = yield* Bindings.read(root.id);
          const stop = {
            operationId: "pool-stop",
            expectedRevision: binding.revision,
            expectedIdentity: client.identity,
          };
          f.a.health.failNextStop = true;
          yield* restarted.stop(root.id, "suspend", stop).pipe(Effect.flip);
          yield* restarted.stop(root.id, "suspend", stop);
          expect(f.b.operations).toHaveLength(0);
          expect(f.b.reads).toHaveLength(0);
          expect(f.a.operations.every((operation) => operation.profile === "gompers-v1")).toBe(
            true,
          );
          expect(f.a.reads.every((read) => read.profile === "gompers-v1")).toBe(true);
          expect(f.a.operations.at(-1)).toEqual(f.a.operations.at(-2));
          const sql = yield* SqlClient.SqlClient;
          const rows =
            yield* sql`SELECT pool_id, profile_id FROM agent_runtime_workspaces WHERE workspace_id=${client.identity.workspaceId}`;
          expect(rows).toEqual([{ pool_id: "gompers", profile_id: "gompers-v1" }]);
        }),
      ),
  );

  it.effect("fails closed when a bound pool disappears instead of using the new default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const root = thread("pools-removed", "gompers");
        yield* create([root]);
        const first = yield* f.runtime();
        yield* first.forThread(root.id);
        yield* f.writeConfig(
          "portal",
          f.entries.filter((entry) => entry.id === "portal"),
        );
        const restarted = yield* f.runtime();
        yield* restarted.forThread(root.id).pipe(Effect.flip);
        yield* restarted.observeThread(root.id).pipe(Effect.flip);
        expect(f.b.operations).toHaveLength(0);
        expect(f.b.reads).toHaveLength(0);
      }),
    ),
  );
});
