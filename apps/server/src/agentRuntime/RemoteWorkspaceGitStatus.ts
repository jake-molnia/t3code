import * as C from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorkspaceRouting from "./WorkspaceRouting.ts";

const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(C.VcsStatusResult));

export const layer = Layer.effect(
  VcsStatusBroadcaster.VcsStatusBroadcaster,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const policy = yield* BackgroundPolicy.BackgroundPolicy;
    const localCache = new Map<string, C.VcsStatusLocalResult>();
    const remoteCache = new Map<string, C.VcsStatusRemoteResult | null>();
    const failure = (cwd: string) => (cause: unknown) =>
      new C.GitCommandError({
        operation: "remote.status",
        cwd,
        command: "remote",
        detail: "Sandbox Git status is unavailable.",
        cause,
      });
    const refreshLocalStatus = (cwd: string) =>
      workflow.invalidateLocalStatus(cwd).pipe(
        Effect.andThen(workflow.localStatus({ cwd })),
        Effect.tap((local) => Effect.sync(() => localCache.set(cwd, local))),
        Effect.mapError(failure(cwd)),
      );
    const readRemoteStatus = (
      cwd: string,
      options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
    ) =>
      workflow.remoteStatus({ cwd }, options).pipe(
        Effect.tap((remote) => Effect.sync(() => remoteCache.set(cwd, remote))),
        Effect.mapError(failure(cwd)),
      );
    const refreshStatus = (cwd: string) =>
      Effect.gen(function* () {
        yield* workflow.invalidateStatus(cwd);
        const remote = yield* readRemoteStatus(cwd);
        // Fetch can move the base used by local change totals.
        const local = yield* refreshLocalStatus(cwd);
        return mergeGitStatusParts(local, remote);
      }).pipe(Effect.mapError(failure(cwd)));
    const canRefresh = (cwd: string) => policy.shouldRunScopeWork({ type: "vcs-status", cwd });
    return VcsStatusBroadcaster.VcsStatusBroadcaster.of({
      getStatus: ({ cwd }) => refreshStatus(cwd),
      refreshStatus,
      refreshLocalStatus,
      refreshPullRequestStatus: (cwd) =>
        canRefresh(cwd).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? readRemoteStatus(cwd, { refreshUpstream: false, refreshMissingPullRequest: true })
              : Effect.succeed(null),
          ),
        ),
      streamStatus: (input, options) =>
        Stream.callback<C.VcsStatusStreamEvent, C.GitCommandError>((queue) =>
          Effect.gen(function* () {
            let previous = "";
            const publish = Effect.gen(function* () {
              const local = localCache.get(input.cwd);
              if (!local) return;
              const remote = remoteCache.get(input.cwd) ?? null;
              const encoded = yield* encodeStatus(mergeGitStatusParts(local, remote));
              if (encoded === previous) return;
              previous = encoded;
              yield* Queue.offer(queue, { _tag: "snapshot", local, remote });
            });
            const observe = <A, E>(read: Effect.Effect<A, E>) =>
              routes.observe(input.cwd, read).pipe(
                Effect.catch(() =>
                  Effect.logDebug("Passive sandbox Git status unavailable", { cwd: input.cwd }),
                ),
                Effect.andThen(publish),
                Effect.mapError(failure(input.cwd)),
              );
            yield* observe(refreshLocalStatus(input.cwd));
            yield* Effect.sleep("2 seconds").pipe(
              Effect.andThen(observe(refreshLocalStatus(input.cwd))),
              Effect.forever,
              Effect.catchCause((cause) => Queue.failCause(queue, cause)),
              Effect.forkScoped,
            );
            if (input.includeRemote === false) return;
            yield* Effect.gen(function* () {
              const interval = yield* (
                options?.automaticRemoteRefreshInterval ?? Effect.succeed(Duration.seconds(30))
              );
              if (!Duration.isZero(interval) && (yield* canRefresh(input.cwd))) {
                yield* observe(
                  workflow
                    .invalidateRemoteStatus(input.cwd)
                    .pipe(Effect.andThen(readRemoteStatus(input.cwd))),
                );
              }
              yield* Effect.sleep(Duration.isZero(interval) ? Duration.seconds(2) : interval);
            }).pipe(
              Effect.forever,
              Effect.catchCause((cause) => Queue.failCause(queue, cause)),
              Effect.forkScoped,
            );
          }),
        ),
    });
  }),
);
