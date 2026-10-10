import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Requests own compute while waiting for admission as well as while executing. */
export class WorkspaceActivity extends Context.Reference<Map<string, number>>(
  "t3/agentRuntime/WorkspaceActivity",
  {
    defaultValue: () => new Map(),
  },
) {}

export const withWorkspaceActivity = <A, E, R>(
  workspaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(WorkspaceActivity, (active) =>
    Effect.acquireUseRelease(
      Effect.sync(() => active.set(workspaceId, (active.get(workspaceId) ?? 0) + 1)),
      () => effect,
      () =>
        Effect.sync(() => {
          const remaining = (active.get(workspaceId) ?? 1) - 1;
          if (remaining > 0) active.set(workspaceId, remaining);
          else active.delete(workspaceId);
        }),
    ),
  );
