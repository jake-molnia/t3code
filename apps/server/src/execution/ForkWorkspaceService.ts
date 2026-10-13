import { ThreadId, RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Routing from "../agentRuntime/WorkspaceRouting.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { transferForkBundle } from "../agentRuntime/SeedWorkspace.ts";
import * as WorkerProtocol from "../agentRuntime/worker/Protocol.ts";
import * as P from "./ForkWorkspaceProtocol.ts";

export const ForkPreparation = Schema.Struct({
  targetThreadId: ThreadId,
  sourceThreadId: ThreadId,
  sourceRunId: RunId,
});
export class ForkWorkspaceError extends Schema.TaggedError<ForkWorkspaceError>()(
  "ForkWorkspaceError",
  { targetThreadId: ThreadId, cause: Schema.Defect() },
) {}
export class ForkWorkspaceService extends Context.Service<
  ForkWorkspaceService,
  {
    readonly prepare: (
      input: typeof ForkPreparation.Type,
    ) => Effect.Effect<void, ForkWorkspaceError>;
  }
>()("t3/execution/ForkWorkspaceService") {}
const decodeBundle = Schema.decodeUnknownEffect(P.ForkBundle);
const decodeScript = Schema.decodeUnknownEffect(WorkerProtocol.ScriptResult);

export const layer = Layer.effect(
  ForkWorkspaceService,
  Effect.gen(function* () {
    const projections = yield* Projections.ProjectionStoreV2;
    const routes = yield* Routing.WorkspaceRouting;
    const runtime = yield* Runtime.RuntimeClient;
    const projects = yield* Effect.serviceOption(Projects.ProjectService);
    const settings = yield* Settings.ServerSettingsService;
    const scope = yield* Effect.scope;
    return ForkWorkspaceService.of({
      prepare: (input) =>
        Effect.gen(function* () {
          const source = yield* projections.getThreadRecords(input.sourceThreadId, [
            "runs",
            "checkpoints",
            "checkpointScopes",
          ]);
          const run = source.runs.find((run) => run.id === input.sourceRunId);
          const checkpoint = run?.checkpointId
            ? source.checkpoints.find((checkpoint) => checkpoint.id === run.checkpointId)
            : source.checkpoints.find(
                (checkpoint) =>
                  checkpoint.runId === input.sourceRunId &&
                  checkpoint.nodeId === run?.rootNodeId &&
                  checkpoint.status === "ready",
              );
          if (!run || !checkpoint || checkpoint.status !== "ready" || !source.thread.worktreePath)
            return yield* new ForkWorkspaceError({
              targetThreadId: input.targetThreadId,
              cause: "The selected source checkpoint is not ready",
            });
          const destination = yield* routes.registerFork({
            targetThreadId: input.targetThreadId,
            sourceCwd: source.thread.worktreePath,
          });
          const sourceClient = yield* routes.clientForCwd(source.thread.worktreePath);
          const targetClient = yield* runtime.forThread(input.targetThreadId);
          const bundle = yield* routes
            .call({
              cwd: source.thread.worktreePath,
              method: "git.bundleFork",
              input: { checkpointRef: checkpoint.ref },
            })
            .pipe(Effect.flatMap(decodeBundle));
          const transferred = yield* transferForkBundle({
            source: sourceClient,
            destination: targetClient,
            bundle,
          });
          const { bundlePath: _bundlePath, lfsObjects: _lfsObjects, ...snapshot } = bundle;
          yield* Effect.tryPromise(() =>
            targetClient.call("git.importFork", {
              ...snapshot,
              cwd: destination.relativeCwd,
              ...transferred,
            }),
          );
          if (Option.isNone(projects))
            return yield* new ForkWorkspaceError({
              targetThreadId: input.targetThreadId,
              cause: "Project setup service is unavailable",
            });
          const project = yield* projects.value.getById(source.thread.projectId);
          if (Option.isNone(project)) return;
          const script = setupProjectScript(
            resolveProjectScripts(yield* settings.getSettings, project.value),
          );
          if (!script) return;
          const setup = routes
            .call({
              cwd: destination.virtualCwd,
              method: "scripts.run",
              input: {
                operationId: `fork-setup:${input.targetThreadId}`,
                command: "/bin/sh",
                args: ["-lc", script.command],
                timeoutMs: 3_600_000,
                env: {
                  T3CODE_PROJECT_ROOT: destination.virtualCwd,
                  T3CODE_WORKTREE_PATH: destination.virtualCwd,
                },
              },
            })
            .pipe(
              Effect.flatMap(decodeScript),
              Effect.flatMap((result) =>
                result.code === 0
                  ? Effect.void
                  : Effect.fail(
                      new ForkWorkspaceError({
                        targetThreadId: input.targetThreadId,
                        cause: "Fork setup script failed",
                      }),
                    ),
              ),
            );
          if (script.async)
            yield* setup.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Fork setup script failed", { cause }),
              ),
              Effect.forkIn(scope),
            );
          else yield* setup;
        }).pipe(
          Effect.mapError(
            (cause) => new ForkWorkspaceError({ targetThreadId: input.targetThreadId, cause }),
          ),
        ),
    });
  }),
);
