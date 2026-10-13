import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import {
  ExecutionIdentity,
  type ExecutionEvent,
} from "../../../../packages/contracts/src/execution.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(ExecutionIdentity));

export const Binding = Schema.Struct({
  threadId: Schema.String,
  workspaceId: Schema.String,
  ownerThreadId: Schema.String,
  revision: Schema.Number,
});
export type Binding = typeof Binding.Type;

export class BindingError extends Schema.TaggedError<BindingError>()("RuntimeBindingError", {
  threadId: Schema.String,
  cause: Schema.Defect(),
}) {}

export const read = Effect.fn("AgentRuntimeBindings.read")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT b.thread_id AS threadId, b.workspace_id AS workspaceId,
    w.owner_thread_id AS ownerThreadId, w.admission_revision AS revision
    FROM agent_runtime_thread_bindings b JOIN agent_runtime_workspaces w USING(workspace_id)
    WHERE b.thread_id = ${threadId}`;
  if (rows.length !== 1)
    return yield* new BindingError({ threadId, cause: "Thread has no execution binding" });
  return yield* Schema.decodeUnknownEffect(Binding)(rows[0]).pipe(
    Effect.mapError((cause) => new BindingError({ threadId, cause })),
  );
});

/** Called inside EventSink's transaction, together with thread creation and run intent. */
export const apply = Effect.fn("AgentRuntimeBindings.apply")(function* (
  event: OrchestrationV2DomainEvent,
  delivery?: ExecutionEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "turn-item.updated" && event.payload.type === "command_execution") {
    const item = event.payload;
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting") {
      yield* sql`DELETE FROM agent_runtime_command_residency WHERE item_id = ${item.id}`;
    } else if (delivery) {
      const identity = yield* encodeIdentity(delivery.identity);
      yield* sql`INSERT INTO agent_runtime_command_residency(item_id, thread_id, identity_json)
        VALUES (${item.id}, ${event.threadId}, ${identity})
        ON CONFLICT(item_id) DO UPDATE SET
          checked_at = CASE WHEN identity_json = excluded.identity_json THEN checked_at ELSE 0 END,
          identity_json = excluded.identity_json`;
    }
  }
  if (event.type === "thread.deleted")
    yield* sql`DELETE FROM agent_runtime_command_residency WHERE thread_id = ${event.threadId}`;
  if (event.type === "thread.created") {
    const thread = event.payload;
    if (
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.parentThreadId !== null
    ) {
      const parent = yield* read(thread.lineage.parentThreadId);
      yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id, workspace_id)
        VALUES (${thread.id}, ${parent.workspaceId}) ON CONFLICT(thread_id) DO NOTHING`;
    } else {
      const workspaceId = `t3:${thread.id}`;
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id, owner_thread_id, pool_id)
        VALUES (${workspaceId}, ${thread.id}, ${thread.executionPoolId ?? null}) ON CONFLICT(owner_thread_id) DO NOTHING`;
      yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id, workspace_id)
        VALUES (${thread.id}, ${workspaceId}) ON CONFLICT(thread_id) DO NOTHING`;
    }
  }
  if (
    event.type === "thread.created" ||
    event.type === "run.updated" ||
    event.type === "thread.unsettled" ||
    event.type === "thread.settled" ||
    event.type === "runtime-request.updated" ||
    event.type === "thread.deleted"
  ) {
    yield* sql`UPDATE agent_runtime_workspaces SET admission_revision = admission_revision + 1
      WHERE workspace_id IN (SELECT workspace_id FROM agent_runtime_thread_bindings
        WHERE thread_id = ${event.threadId})`;
  }
});

export const cursor = Effect.fn("AgentRuntimeBindings.cursor")(function* (
  workspaceId: string,
  incarnation: string,
  sessionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ sequence: number }>`SELECT sequence FROM agent_runtime_event_cursors
    WHERE workspace_id = ${workspaceId} AND incarnation = ${incarnation} AND session_id = ${sessionId}`;
  return rows[0]?.sequence ?? 0;
});

/** Call in the same transaction that commits the normalized provider event. */
export const acknowledge = Effect.fn("AgentRuntimeBindings.acknowledge")(function* (
  workspaceId: string,
  incarnation: string,
  sessionId: string,
  sequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO agent_runtime_event_cursors(workspace_id, incarnation, session_id, sequence)
    VALUES (${workspaceId}, ${incarnation}, ${sessionId}, ${sequence})
    ON CONFLICT(workspace_id, incarnation, session_id) DO UPDATE
      SET sequence = MAX(sequence, excluded.sequence)`;
});
