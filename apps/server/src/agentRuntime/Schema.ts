import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Fork schema uses its own names so upstream migration numbers remain unmodified. */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_workspaces (
    workspace_id TEXT PRIMARY KEY,
    owner_thread_id TEXT NOT NULL UNIQUE,
    admission_revision INTEGER NOT NULL DEFAULT 1 CHECK(admission_revision > 0),
    execution_requested INTEGER NOT NULL DEFAULT 0,
    lifecycle_request_json TEXT
  )`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(agent_runtime_workspaces)`;
  if (!columns.some((column) => column.name === "lifecycle_request_json"))
    yield* sql`ALTER TABLE agent_runtime_workspaces ADD COLUMN lifecycle_request_json TEXT`;
  if (!columns.some((column) => column.name === "execution_requested"))
    yield* sql`ALTER TABLE agent_runtime_workspaces ADD COLUMN execution_requested INTEGER NOT NULL DEFAULT 0`;
  if (!columns.some((column) => column.name === "pool_id"))
    yield* sql`ALTER TABLE agent_runtime_workspaces ADD COLUMN pool_id TEXT`;
  if (!columns.some((column) => column.name === "profile_id"))
    yield* sql`ALTER TABLE agent_runtime_workspaces ADD COLUMN profile_id TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_thread_bindings (
    thread_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES agent_runtime_workspaces(workspace_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_runtime_workspace_members
    ON agent_runtime_thread_bindings(workspace_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_workspace_paths (
    virtual_cwd TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES agent_runtime_workspaces(workspace_id),
    relative_cwd TEXT NOT NULL,
    thread_id TEXT,
    utility_key TEXT,
    source_url TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_session_residency (
    provider_session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    identity_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_usage_history (
    workspace_id TEXT PRIMARY KEY,
    sources_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_runtime_event_cursors (
    workspace_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 0),
    PRIMARY KEY(workspace_id, incarnation, session_id)
  )`;
});

/** Existing conversations retain delegation ownership when adopting the fork. */
export const backfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    threadId: string;
    parentId: string | null;
    relationship: string | null;
  }>`
    SELECT thread_id AS threadId,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parentId,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship
    FROM orchestration_v2_projection_threads`;
  const pending = new Map(rows.map((row) => [row.threadId, row]));
  const owners = new Map<string, string>();
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, row] of pending) {
      const child = row.relationship === "subagent" && row.parentId !== null;
      if (child && row.parentId !== null && pending.has(row.parentId)) continue;
      const owner = child && row.parentId !== null ? (owners.get(row.parentId) ?? id) : id;
      owners.set(id, owner);
      const workspaceId = `t3:${owner}`;
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id, owner_thread_id)
        VALUES (${workspaceId}, ${owner}) ON CONFLICT(owner_thread_id) DO NOTHING`;
      yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id, workspace_id)
        VALUES (${id}, ${workspaceId}) ON CONFLICT(thread_id) DO NOTHING`;
      pending.delete(id);
      progressed = true;
    }
    if (!progressed)
      return yield* Effect.die(
        new Error("Cyclic thread delegation cannot be assigned a workspace"),
      );
  }
});
