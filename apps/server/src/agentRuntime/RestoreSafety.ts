import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type Owner = Pick<OrchestrationV2AppThread, "id" | "worktreePath">;
type Scope = Pick<OrchestrationV2CheckpointScope, "cwd">;
export class RestoreSafetyError extends Schema.TaggedError<RestoreSafetyError>()(
  "RemoteRestoreSafetyError",
  { cause: Schema.Defect() },
) {}
export class RestoreSafety extends Context.Reference<{
  readonly check:
    | ((thread: Owner, scope: Scope) => Effect.Effect<boolean, RestoreSafetyError>)
    | undefined;
}>("t3/agentRuntime/RestoreSafety", { defaultValue: () => ({ check: undefined }) }) {}

export const layer = Layer.effect(
  RestoreSafety,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      check: (thread: Owner, scope: Scope) =>
        Effect.gen(function* () {
          if (thread.worktreePath === null || thread.worktreePath !== scope.cwd) return false;
          const rows = yield* sql<{ members: number }>`
        SELECT COUNT(DISTINCT member.thread_id) AS members
        FROM agent_runtime_thread_bindings owner
        JOIN agent_runtime_workspace_paths path ON path.workspace_id = owner.workspace_id
        JOIN agent_runtime_thread_bindings member ON member.workspace_id = owner.workspace_id
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = member.thread_id
        WHERE owner.thread_id = ${thread.id} AND path.virtual_cwd = ${scope.cwd} AND thread.deleted_at IS NULL`;
          return rows[0]?.members === 1;
        }).pipe(Effect.mapError((cause) => new RestoreSafetyError({ cause }))),
    };
  }),
);
