import * as C from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorkspaceRouting from "./WorkspaceRouting.ts";

interface CachedStatus {
  readonly local: C.VcsStatusLocalResult;
  readonly identity: { readonly refName: string | null; readonly commitSha: string } | null;
  readonly generation: number;
  readonly remote: C.VcsStatusRemoteResult | null;
}

const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(C.VcsStatusResult));

export const layer = Layer.effect(
  VcsStatusBroadcaster.VcsStatusBroadcaster,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const policy = yield* BackgroundPolicy.BackgroundPolicy;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const cache = new Map<string, CachedStatus>();
    const localReads = yield* KeyedLock.make<string>();
    let generation = 0;
    const failure = (cwd: string) => (cause: unknown) =>
      new C.GitCommandError({
        operation: "remote.status",
        cwd,
        command: "remote",
        detail: "Sandbox Git status is unavailable.",
        cause,
      });
    const readHead = (cwd: string) =>
      git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
        Effect.map(({ commitSha }) => commitSha),
        Effect.orElseSucceed(() => null),
      );
    const readLocalSnapshot = (cwd: string) =>
      localReads.withLock(
        cwd,
        Effect.gen(function* () {
          const before = yield* readHead(cwd);
          yield* workflow.invalidateLocalStatus(cwd);
          const local = yield* workflow.localStatus({ cwd });
          const after = yield* readHead(cwd);
          const refName = yield* git
            .resolveBranchName(cwd, "HEAD")
            .pipe(Effect.orElseSucceed(() => undefined));
          const identity =
            local.isRepo && before !== null && before === after && local.refName === refName
              ? { refName: local.refName, commitSha: after }
              : null;
          const previous = cache.get(cwd);
          const unchanged =
            identity !== null &&
            previous?.identity?.refName === identity.refName &&
            previous.identity.commitSha === identity.commitSha;
          const snapshot: CachedStatus = {
            local,
            identity,
            generation: unchanged ? previous.generation : ++generation,
            remote: unchanged ? previous.remote : null,
          };
          cache.set(cwd, snapshot);
          if (!unchanged) yield* workflow.invalidateRemoteStatus(cwd);
          return snapshot;
        }).pipe(Effect.mapError(failure(cwd))),
      );
    const localSnapshots = yield* Cache.makeWith(readLocalSnapshot, {
      capacity: 256,
      timeToLive: () => Duration.zero,
      requireServicesAt: "lookup",
    });
    const refreshLocalSnapshot = (cwd: string) => Cache.get(localSnapshots, cwd);
    const refreshLocalStatus = (cwd: string) =>
      refreshLocalSnapshot(cwd).pipe(Effect.map(({ local }) => local));
    const readRemoteStatus = (
      cwd: string,
      options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
    ) =>
      Effect.gen(function* () {
        const before = yield* refreshLocalSnapshot(cwd);
        if (before.identity === null) return before;
        // The workflow cache is keyed by cwd, so a new read must not inherit an older checkout's result.
        yield* workflow.invalidateRemoteStatus(cwd);
        const remote = yield* workflow.remoteStatus({ cwd }, options);
        const after = yield* refreshLocalSnapshot(cwd);
        // Do not hold the local-read lock during forge I/O: a switch must clear the old PR immediately.
        const current = cache.get(cwd) ?? after;
        if (after.generation !== before.generation || current.generation !== before.generation)
          return current;
        const snapshot = { ...current, remote };
        cache.set(cwd, snapshot);
        return snapshot;
      }).pipe(Effect.mapError(failure(cwd)));
    const refreshStatus = (cwd: string) =>
      Effect.gen(function* () {
        yield* workflow.invalidateStatus(cwd);
        const { local, remote } = yield* readRemoteStatus(cwd);
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
              ? readRemoteStatus(cwd, {
                  refreshUpstream: false,
                  refreshMissingPullRequest: true,
                }).pipe(Effect.map(({ remote }) => remote))
              : Effect.succeed(null),
          ),
        ),
      streamStatus: (input, options) =>
        Stream.callback<C.VcsStatusStreamEvent, C.GitCommandError>((queue) =>
          Effect.gen(function* () {
            let previous = "";
            const publish = Effect.gen(function* () {
              const snapshot = cache.get(input.cwd);
              if (!snapshot) return;
              const { local, remote } = snapshot;
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
                yield* observe(readRemoteStatus(input.cwd));
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
