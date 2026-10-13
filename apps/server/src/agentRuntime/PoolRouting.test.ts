// @effect-diagnostics nodeBuiltinImport:off -- Real controller HTTP and configuration-file boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ExecutionPoolId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as Pools from "./ExecutionPools.ts";
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
const operationSchema = Schema.Struct({
  workspaceId: Schema.String,
  operationId: Schema.String,
  revision: Schema.Number,
  action: Schema.String,
  profile: Schema.String,
});
const decodeOperation = Schema.decodeUnknownSync(operationSchema);
type Operation = typeof operationSchema.Type;
const identity = (workspaceId: string, controller: string) => ({
  workspaceId,
  allocationId: `${controller}-allocation`,
  generation: 1,
  incarnation: `${controller}-worker`,
  podUid: `${controller}-pod`,
  protocolVersion: 1 as const,
});
const resourceSample = {
  sampledAt: 123,
  cpuCount: 8,
  cpuUtilization: 0.1,
  availableMemoryBytes: 24000,
  totalMemoryBytes: 32000,
};

const controller = (name: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const token = `test-${name}-controller-token-at-least-thirty-two-characters`;
      const operations: Operation[] = [];
      const reads: Array<{ workspaceId: string; profile: string | null }> = [];
      const states = new Map<string, Operation>();
      const health = {
        status: 200,
        metricsStatus: 200,
        metrics: resourceSample,
        failNextStop: false,
        workspaceStatus: 200,
        workspacePhase: "running",
      };
      const server = await listenWorker({
        host: "127.0.0.1",
        port: 0,
        handle: async (request) => {
          if (request.headers.get("authorization") !== `Bearer ${token}`)
            return new Response(null, { status: 401 });
          const url = new URL(request.url);
          if (url.pathname === "/control/healthz")
            return new Response(null, { status: health.status });
          if (url.pathname === "/control/v1/resources")
            return Response.json(
              {
                ...health.metrics,
                requestCapacity: {
                  profile: name === "portal" ? "wrong-profile" : url.searchParams.get("profile"),
                  sampledAt: 123,
                  availableSlots: 0,
                },
              },
              { status: health.metricsStatus },
            );
          if (url.pathname === "/control/v1/operations" && request.method === "POST") {
            const operation = decodeOperation(await request.json());
            operations.push(operation);
            if (health.failNextStop && operation.action !== "ensure_running") {
              health.failNextStop = false;
              return Response.json({}, { status: 503 });
            }
            states.set(operation.workspaceId, operation);
            return Response.json({});
          }
          if (url.pathname.startsWith("/control/v1/workspaces/")) {
            if (health.workspaceStatus !== 200)
              return Response.json({}, { status: health.workspaceStatus });
            const workspaceId = decodeURIComponent(
              url.pathname.slice("/control/v1/workspaces/".length),
            );
            reads.push({ workspaceId, profile: url.searchParams.get("profile") });
            const state = states.get(workspaceId);
            if (!state) return Response.json({}, { status: 404 });
            return Response.json({
              state: {
                request: state,
                epoch: 1,
                phase: health.workspacePhase,
                completedOperation: state.operationId,
                identity: identity(workspaceId, name),
                endpoint: `http://worker.invalid/${name}/${encodeURIComponent(workspaceId)}`,
              },
              token: "worker-private-token",
            });
          }
          return new Response(null, { status: 404 });
        },
      });
      return {
        ...server,
        name,
        token,
        url: `http://127.0.0.1:${server.port}/control`,
        operations,
        reads,
        health,
      };
    }),
    (value) => Effect.promise(value.close),
  );

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pool-routing-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const a = yield* controller("gompers");
  const b = yield* controller("portal");
  const config = NodePath.join(directory, "pools.json");
  const entries = [a, b].map((server) => ({
    id: server.name,
    label: server.name,
    url: server.url,
    tokenFile: NodePath.join(directory, `${server.name}.token`),
    profile: `${server.name}-v1`,
    providerDrivers: ["codex"],
    enabled: true,
  }));
  yield* Effect.promise(() =>
    Promise.all(
      entries.map((entry, index) => NodeFSP.writeFile(entry.tokenFile, [a, b][index]!.token)),
    ),
  );
  const writeConfig = (defaultPoolId: string, pools = entries) =>
    Effect.promise(() => NodeFSP.writeFile(config, JSON.stringify({ defaultPoolId, pools })));
  yield* writeConfig("gompers");
  const provider = ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { T3_EXECUTION_POOLS_FILE: config } }),
  );
  const runtime = () =>
    Runtime.RuntimeClient.pipe(Effect.provide(Runtime.layer.pipe(Layer.provide(provider))));
  const pools = () =>
    Pools.ExecutionPools.pipe(Effect.provide(Pools.layer.pipe(Layer.provide(provider))));
  return { a, b, entries, writeConfig, runtime, pools };
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
    "routes roots to distinct controllers and all descendants to their owner's controller",
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

  it.effect("classifies only pending controller observations for provider acquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const root = thread("pending-observation");
        yield* create([root]);
        const runtime = yield* f.runtime();
        yield* runtime.forThread(root.id);
        for (const phase of ["starting", "suspending", "releasing", "failed", "unexpected"]) {
          f.a.health.workspacePhase = phase;
          expect(
            Runtime.isWorkerObservationPending(
              yield* runtime.observeThread(root.id).pipe(Effect.flip),
            ),
          ).toBe(["starting", "suspending", "releasing"].includes(phase));
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

  it.effect("publishes only public pool information and degrades missing health or metrics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const pools = yield* f.pools();
        const healthy = yield* pools.snapshot;
        expect(healthy.pools[0]).toEqual({
          id: "gompers",
          label: "gompers",
          available: true,
          resources: resourceSample,
          requestCapacity: { profile: "gompers-v1", sampledAt: 123, availableSlots: 0 },
          providerDrivers: [ProviderDriverKind.make("codex")],
        });
        expect(healthy.pools[1]?.requestCapacity).toBeNull();
        const published = JSON.stringify(healthy);
        for (const privateValue of [
          f.a.token,
          f.b.token,
          f.a.url,
          f.b.url,
          ...f.entries.map((entry) => entry.tokenFile),
        ])
          expect(published).not.toContain(privateValue);
        f.a.health.status = 503;
        f.b.health.metricsStatus = 503;
        const degraded = yield* pools.snapshot;
        expect(degraded.pools[0]).toMatchObject({ available: false, resources: null });
        expect(degraded.pools[1]).toMatchObject({ available: true, resources: null });
      }),
    ),
  );
});
