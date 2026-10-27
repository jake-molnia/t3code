import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import {
  SandboxLifecycle,
  SandboxLifecycleError,
  type WorkspaceResource,
} from "../sandbox/SandboxLifecycle.ts";
import { poolsLayer } from "./testkit/Sandbox.ts";
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
  protocolVersion: 1 as const,
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
      let posts = 0;
      let ready = false;
      const resource = (): WorkspaceResource => ({
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
      });
      const observe = () =>
        Effect.gen(function* () {
          if (ready)
            yield* Enrollment.retire("workspace", 10, proof).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.orDie,
            );
          return resource();
        });
      const lifecycle = SandboxLifecycle.of({
        ensure: observe,
        observe,
        setDesiredState: () =>
          Effect.gen(function* () {
            posts++;
            const flags = yield* sql<{
              execution_requested: number;
            }>`SELECT execution_requested FROM agent_runtime_workspaces WHERE workspace_id='workspace'`.pipe(
              Effect.orDie,
            );
            expect(flags[0]?.execution_requested).toBe(1);
            if (posts === 1) {
              yield* Enrollment.retire("workspace", 10, proof).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.orDie,
              );
              return yield* new SandboxLifecycleError({
                operation: "setDesiredState",
                httpStatus: 412,
                cause: "retirement race",
              });
            }
            ready = true;
            return yield* observe();
          }),
      });
      const runtime = yield* Runtime.RuntimeClient.pipe(
        Effect.provide(Runtime.layer.pipe(Layer.provide(poolsLayer()))),
        Effect.provideService(SandboxLifecycle, lifecycle),
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
