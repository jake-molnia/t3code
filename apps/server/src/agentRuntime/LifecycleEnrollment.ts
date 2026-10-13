import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { CompletedStop } from "./RuntimeClient.ts";

export const roots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    owner_thread_id: string;
  }>`SELECT owner_thread_id FROM agent_runtime_workspaces WHERE execution_requested=1`;
  return rows.map((row) => ThreadId.make(row.owner_thread_id));
});

export const enroll = (owner: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE agent_runtime_workspaces SET execution_requested=1 WHERE owner_thread_id=${owner} AND execution_requested=0`;
  });

/** Called only after policy has rechecked that the stopped workspace needs no further work. */
export const retire = (workspaceId: string, expectedRevision: number, completed: CompletedStop) =>
  Effect.gen(function* () {
    if (completed.revision !== expectedRevision) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE agent_runtime_workspaces SET execution_requested=0
    WHERE workspace_id=${workspaceId} AND admission_revision=${expectedRevision} AND execution_requested=1
    AND (lifecycle_request_json IS NULL OR (
      json_extract(lifecycle_request_json,'$.operationId')=${completed.operationId}
      AND json_extract(lifecycle_request_json,'$.revision')=${expectedRevision}
      AND json_extract(lifecycle_request_json,'$.action')=${completed.action}
    ))`;
  });

/** Domain event delivery is in memory; recover the settlement/enrollment crash gap once at startup. */
export const recoverSettlements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE agent_runtime_workspaces SET execution_requested=1
    WHERE execution_requested=0 AND owner_thread_id IN (
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json,'$.settledOverride')='settled'
        AND json_extract(payload_json,'$.deletedAt') IS NULL
    )`;
});
