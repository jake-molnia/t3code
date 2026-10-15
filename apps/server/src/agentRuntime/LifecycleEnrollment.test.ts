import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import * as Runtime from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as Enrollment from "./LifecycleEnrollment.ts";

const services = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  FetchHttpClient.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const proof: Runtime.CompletedStop = { operationId: "idle:10", revision: 10, action: "suspend" };
const identity = {
  workspaceId: "workspace",
  allocationId: "allocation",
  generation: 1,
  incarnation: "incarnation",
  podUid: "pod",
  protocolVersion: 1,
};

it.live(
  "retires only matching completed stops, keeps observation pure, and re-enrolls explicit wakes across a retirement race",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      const receipt = JSON.stringify({
        ...proof,
        expectedIdentity: identity,
        version: "before-stop",
        acceptedVersion: "stopped",
      });
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision,execution_requested,lifecycle_request_json) VALUES ('workspace','owner',10,1,${receipt})`;
      const run = yield* captureRunPromise;
      let posts = 0;
      let ready = false;
      const controller = yield* Effect.acquireRelease(
        Effect.promise(() =>
          listenWorker({
            host: "127.0.0.1",
            port: 0,
            handle: async (request) => {
              const resource = () =>
                Response.json(
                  {
                    id: "workspace",
                    pool: "local",
                    profile: "t3",
                    desiredState: ready ? "running" : "suspended",
                    state: ready ? "running" : "suspended",
                    version: ready ? "ready" : "stopped",
                    progress: null,
                    error: null,
                    identity,
                    execution: ready
                      ? { identity, endpoint: "http://worker.test", token: "worker-token" }
                      : null,
                  },
                  { headers: { etag: ready ? '"ready"' : '"stopped"' } },
                );
              if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/state")) {
                posts++;
                const flags = await run(
                  sql<{
                    execution_requested: number;
                  }>`SELECT execution_requested FROM agent_runtime_workspaces WHERE workspace_id='workspace'`,
                );
                expect(flags[0]?.execution_requested).toBe(1);
                if (posts === 1) {
                  await run(
                    Enrollment.retire("workspace", 10, proof).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    ),
                  );
                  return Response.json({}, { status: 412 });
                }
                ready = true;
              }
              if (ready)
                await run(
                  Enrollment.retire("workspace", 10, proof).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
                );
              return resource();
            },
          }),
        ),
        (server) => Effect.promise(server.close),
      );
      const runtime = yield* Runtime.RuntimeClient.pipe(
        Effect.provide(
          Runtime.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  AGENT_RUNTIME_URL: `http://127.0.0.1:${controller.port}`,
                  AGENT_RUNTIME_TOKEN: "controller-token",
                }),
              ),
            ),
          ),
        ),
      );
      const observed = yield* runtime.observeWorkspace("workspace");
      expect(observed.kind).toBe("stopped");
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("owner")]);
      if (observed.kind !== "stopped" || !observed.completedStop)
        throw new Error("Completed stop proof missing");
      yield* Enrollment.retire("workspace", 10, observed.completedStop);
      expect(yield* Enrollment.roots).toEqual([]);
      yield* runtime.forWorkspace("workspace");
      expect(posts).toBe(2);
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("owner")]);
      yield* Enrollment.retire("workspace", 10, proof);
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("owner")]);
      const state = yield* sql<{
        admission_revision: number;
        execution_requested: number;
      }>`SELECT admission_revision,execution_requested FROM agent_runtime_workspaces WHERE workspace_id='workspace'`;
      expect(state).toEqual([{ admission_revision: 11, execution_requested: 1 }]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "cannot retire another stop intent and explicitly enrolling a retired owner restores the sweep",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      const newer = JSON.stringify({ ...proof, operationId: "different:10" });
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision,execution_requested,lifecycle_request_json) VALUES ('workspace','owner',10,1,${newer})`;
      yield* Enrollment.retire("workspace", 10, proof);
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("owner")]);
      yield* sql`UPDATE agent_runtime_workspaces SET lifecycle_request_json=NULL`;
      yield* Enrollment.retire("workspace", 10, proof);
      expect(yield* Enrollment.roots).toEqual([]);
      yield* Enrollment.enroll(ThreadId.make("owner"));
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("owner")]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "recovers settled retired roots with ambiguous receipts once, without enrolling unsettled or deleted roots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)`;
      for (const [id, settledOverride, deletedAt] of [
        ["settled", "settled", null],
        ["unsettled", null, null],
        ["deleted", "settled", "2026-10-11T00:00:00Z"],
      ]) {
        const payload = JSON.stringify({ settledOverride, deletedAt });
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision,execution_requested) VALUES (${id},${id},10,0)`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,payload_json) VALUES (${id},${payload})`;
      }
      yield* Enrollment.recoverSettlements;
      expect(yield* Enrollment.roots).toEqual([ThreadId.make("settled")]);
      yield* Enrollment.retire("settled", 10, { ...proof, action: "release_compute" });
      expect(yield* Enrollment.roots).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);
