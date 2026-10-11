import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Requests own compute while waiting for admission as well as while executing. */
export class WorkspaceActivity extends Context.Reference<Map<string, number>>(
  "t3/agentRuntime/WorkspaceActivity",
  {
    defaultValue: () => new Map(),
  },
) {}

/** Recent explicit requests get idle grace; observations never enter this ledger. */
export class WorkspaceRecentActivity extends Context.Reference<Map<string, number>>(
  "t3/agentRuntime/WorkspaceRecentActivity",
  { defaultValue: () => new Map() },
) {}

const retainWorkspaceActivity = (workspaceId: string, recordRecent = true) =>
  Effect.gen(function* () {
    const active = yield* WorkspaceActivity;
    const recent = yield* WorkspaceRecentActivity;
    const touch = Effect.gen(function* () {
      if (!recordRecent) return;
      const now = yield* Clock.currentTimeMillis;
      recent.delete(workspaceId);
      recent.set(workspaceId, now);
      if (recent.size > 1024) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
    });
    active.set(workspaceId, (active.get(workspaceId) ?? 0) + 1);
    yield* touch;
    return Effect.gen(function* () {
      const remaining = (active.get(workspaceId) ?? 1) - 1;
      if (remaining > 0) active.set(workspaceId, remaining);
      else active.delete(workspaceId);
      yield* touch;
    });
  });

export const withWorkspaceActivity = <A, E, R>(
  workspaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    retainWorkspaceActivity(workspaceId),
    () => effect,
    (release) => release,
  );

export const acquireWorkspaceActivity = (workspaceId: string) =>
  Effect.acquireRelease(retainWorkspaceActivity(workspaceId), (release) => release).pipe(
    Effect.asVoid,
  );

/** Passive reads hold compute only while reading; they do not postpone idle suspension. */
export const withWorkspaceObservationActivity = <A, E, R>(
  workspaceId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    retainWorkspaceActivity(workspaceId, false),
    () => effect,
    (release) => release,
  );
