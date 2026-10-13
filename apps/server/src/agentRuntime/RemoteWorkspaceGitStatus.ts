import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorkspaceRouting from "./WorkspaceRouting.ts";

export const layer = Layer.effect(
  VcsStatusBroadcaster.VcsStatusBroadcaster,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const cache = new Map<string, C.VcsStatusResult>();
    const failure = (cwd: string) => (cause: unknown) =>
      new C.GitCommandError({
        operation: "remote.status",
        cwd,
        command: "remote",
        detail: "Sandbox Git status is unavailable.",
        cause,
      });
    const readStatus = (input: C.VcsStatusInput) =>
      workflow.invalidateLocalStatus(input.cwd).pipe(Effect.andThen(workflow.status(input)));
    const observed = (cwd: string) =>
      routes.observe(cwd, readStatus({ cwd })).pipe(
        Effect.tap((status) =>
          Effect.sync(() => {
            if (status) cache.set(cwd, status);
          }),
        ),
        Effect.mapError(failure(cwd)),
      );
    const getStatus = (input: C.VcsStatusInput) =>
      workflow.invalidateStatus(input.cwd).pipe(
        Effect.andThen(readStatus(input)),
        Effect.tap((status) => Effect.sync(() => cache.set(input.cwd, status))),
        Effect.mapError(failure(input.cwd)),
      );
    const refresh = (cwd: string) => getStatus({ cwd });
    return VcsStatusBroadcaster.VcsStatusBroadcaster.of({
      getStatus,
      refreshStatus: refresh,
      refreshLocalStatus: refresh,
      refreshPullRequestStatus: refresh,
      streamStatus: (input) =>
        Stream.callback<C.VcsStatusStreamEvent, C.GitCommandError>((queue) =>
          Effect.gen(function* () {
            let previous = "";
            yield* Effect.forever(
              Effect.gen(function* () {
                const status =
                  (yield* observed(input.cwd).pipe(
                    Effect.catch(() =>
                      Effect.logDebug("Passive sandbox Git status unavailable", {
                        cwd: input.cwd,
                      }).pipe(Effect.as(null)),
                    ),
                  )) ?? cache.get(input.cwd);
                if (status) {
                  const encoded = yield* Schema.encodeEffect(
                    Schema.fromJsonString(C.VcsStatusResult),
                  )(status);
                  if (encoded !== previous) {
                    previous = encoded;
                    yield* Queue.offer(queue, { _tag: "snapshot", local: status, remote: status });
                  }
                }
                yield* Effect.sleep("2 seconds");
              }),
            ).pipe(
              Effect.mapError(failure(input.cwd)),
              Effect.catchCause((cause) => Queue.failCause(queue, cause)),
              Effect.forkScoped,
            );
          }),
        ),
    });
  }),
);
