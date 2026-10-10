import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Requests own compute while waiting for admission as well as while executing. */
export class WorkspaceActivity extends Context.Reference<Map<string, number>>(
  "t3/agentRuntime/WorkspaceActivity",
  {
    defaultValue: () => new Map(),
  },
) {}

const retainWorkspaceActivity = (workspaceId: string) =>
  Effect.flatMap(WorkspaceActivity, (active) =>
    Effect.sync(() => {
      active.set(workspaceId, (active.get(workspaceId) ?? 0) + 1);
      return () => {
        const remaining = (active.get(workspaceId) ?? 1) - 1;
        if (remaining > 0) active.set(workspaceId, remaining);
        else active.delete(workspaceId);
      };
    }),
  );

export const withWorkspaceActivity = <A, E, R>(
  workspaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    retainWorkspaceActivity(workspaceId),
    () => effect,
    (release) => Effect.sync(release),
  );

export const acquireWorkspaceActivity = (workspaceId: string) =>
  Effect.acquireRelease(retainWorkspaceActivity(workspaceId), (release) => Effect.sync(release));
