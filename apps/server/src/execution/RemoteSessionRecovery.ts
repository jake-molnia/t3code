import { CommandId, type ThreadId, type ProviderSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Runs from "../orchestration-v2/RunExecutionService.ts";
import * as Policy from "../orchestration-v2/RuntimePolicy.ts";
import { sameIdentity } from "./ExecutionWorker.ts";
import * as Protocol from "./ProviderProtocol.ts";

const decodeNullableSessionDescription = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.toCodecJson(Protocol.SessionDescription)),
);

export class RemoteRecoveryError extends Schema.TaggedError<RemoteRecoveryError>()(
  "RemoteRecoveryError",
  { threadId: Schema.String, stage: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
export class RemoteSessionRecovery extends Context.Service<
  RemoteSessionRecovery,
  {
    readonly preserve: (
      projection: Projections.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<boolean, RemoteRecoveryError>;
    readonly isRemote: (
      projection: Projections.ProjectionRuntimeRecoveryState,
    ) => Effect.Effect<boolean, RemoteRecoveryError>;
  }
>()("t3/execution/RemoteSessionRecovery") {}

export const layer = Layer.effect(
  RemoteSessionRecovery,
  Effect.gen(function* () {
    const runtime = yield* Runtime.RuntimeClient;
    const projections = yield* Projections.ProjectionStoreV2;
    const sessions = yield* Sessions.ProviderSessionManagerV2;
    const runs = yield* Runs.RunExecutionServiceV2;
    const policy = yield* Policy.RuntimePolicyV2;
    const failure = (threadId: ThreadId, stage: string) => (cause: unknown) =>
      new RemoteRecoveryError({ threadId, stage, cause });
    const candidates = (projection: Projections.ProjectionRuntimeRecoveryState) =>
      projection.providerSessions.filter(
        (session) => session.status !== "stopped" && session.status !== "error",
      );
    const isRemote = (projection: Projections.ProjectionRuntimeRecoveryState) =>
      Effect.gen(function* () {
        for (const session of candidates(projection))
          if (yield* runtime.sessionResidency(session.id)) return true;
        return false;
      }).pipe(Effect.mapError(failure(projection.thread.id, "residency")));
    const preserve = (
      projection: Projections.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
    ) =>
      Effect.gen(function* () {
        if (!(yield* isRemote(projection))) return false;
        if (trigger === "shutdown") return true;
        const observation = yield* runtime.observeThread(projection.thread.id);
        if (observation.kind === "stopped") return false;
        const client = observation.client;
        const identity = yield* Effect.tryPromise(() => client.inspectIdentity());
        const live = new Map<ProviderSessionId, typeof Protocol.SessionDescription.Type>();
        let lost = 0;
        for (const session of candidates(projection)) {
          const resident = yield* runtime.sessionResidency(session.id);
          if (!resident || !sameIdentity(resident, identity)) {
            lost++;
            continue;
          }
          const description = yield* Effect.tryPromise(() =>
            client.call("describeSession", {
              instanceId: session.providerInstanceId,
              input: { providerSessionId: session.id },
            }),
          ).pipe(Effect.flatMap(decodeNullableSessionDescription));
          if (!description) {
            lost++;
            continue;
          }
          live.set(session.id, description);
        }
        if (lost && live.size)
          return yield* new RemoteRecoveryError({
            threadId: projection.thread.id,
            stage: "mixed_worker_residency",
          });
        if (!live.size) return false;
        const activeRuns = projection.runs.filter((run) => {
          if (run.status === "running" || run.status === "waiting" || run.status === "starting")
            return true;
          if (run.status !== "completed") return false;
          const providerThread = projection.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          );
          const hasNativeChildren = projection.subagents.some(
            (child) =>
              child.runId === run.id &&
              child.origin === "provider_native" &&
              ["pending", "running", "waiting"].includes(child.status),
          );
          const ownsLatestBackground =
            (providerThread?.pendingBackgroundTasks?.length ?? 0) > 0 &&
            !projection.runs.some(
              (other) =>
                other.providerThreadId === run.providerThreadId && other.ordinal > run.ordinal,
            );
          return hasNativeChildren || ownsLatestBackground;
        });
        for (const run of activeRuns) {
          const providerThread = projection.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          );
          if (!providerThread?.providerSessionId || !run.activeAttemptId)
            return yield* new RemoteRecoveryError({
              threadId: projection.thread.id,
              stage: "active_run_identity",
            });
          const operation = yield* Effect.tryPromise(() =>
            client.operationStatus(
              `turn:${identity.incarnation}:${providerThread.providerSessionId}:${run.activeAttemptId}`,
            ),
          );
          if (operation.state === "unknown")
            return yield* new RemoteRecoveryError({
              threadId: projection.thread.id,
              stage: "unknown_turn_outcome",
            });
          if (operation.state === "missing" || (operation.result && !operation.result.ok))
            return false;
          if (
            operation.result?.ok &&
            operation.result.value &&
            typeof operation.result.value === "object" &&
            "providerFailure" in operation.result.value
          )
            return false;
        }
        for (const [sessionId] of live) {
          const session = projection.providerSessions.find((item) => item.id === sessionId);
          if (!session) continue;
          const owned = activeRuns.filter((run) =>
            projection.providerThreads.some(
              (thread) =>
                thread.id === run.providerThreadId && thread.providerSessionId === sessionId,
            ),
          );
          const modelSelection = owned[0]?.modelSelection ?? projection.thread.modelSelection;
          const runtimePolicy = yield* policy.resolve({
            thread: projection.thread,
            modelSelection,
          });
          const attached = yield* sessions.open({
            threadId: projection.thread.id,
            providerSessionId: sessionId,
            modelSelection,
            runtimePolicy,
            resumeFromSession: session,
            deferEventPump: owned.length > 0,
          });
          for (const run of owned) {
            const context = yield* projections.getTurnStartContext(projection.thread.id, run.id);
            const rootNode = context.nodes.find((node) => node.id === run.rootNodeId);
            const attempt = context.attempts.find((item) => item.id === run.activeAttemptId);
            const providerThread = context.providerThreads.find(
              (item) => item.id === run.providerThreadId,
            );
            const checkpointScope = context.checkpointScopes.find(
              (item) => item.id === rootNode?.checkpointScopeId,
            );
            const message = context.messages.find((item) => item.id === run.userMessageId);
            if (!rootNode || !attempt || !providerThread || !checkpointScope || !message)
              return yield* new RemoteRecoveryError({
                threadId: projection.thread.id,
                stage: "run_restore_context",
              });
            yield* runs.startRootRun({
              reattachOnly: true,
              reattachChildNodeIds: context.subagents
                .filter(
                  (child) =>
                    child.runId === run.id &&
                    child.origin === "provider_native" &&
                    ["pending", "running", "waiting"].includes(child.status),
                )
                .map((child) => child.id),
              reattachChildTurnIds: context.providerTurns
                .filter(
                  (turn) =>
                    turn.providerThreadId !== providerThread.id &&
                    ["pending", "running"].includes(turn.status),
                )
                .map((turn) => turn.id),
              commandId: CommandId.make(
                `command:remote-reconnect:${run.id}:${identity.incarnation}`,
              ),
              appThread: context.thread,
              providerSessionId: sessionId,
              session: attached,
              run,
              rootNode,
              checkpointScope,
              providerThread,
              attempt,
              attemptId: attempt.id,
              providerTurnOrdinal:
                context.providerTurns.find((turn) => turn.id === attempt.providerTurnId)?.ordinal ??
                1,
              message: {
                messageId: message.id,
                text: message.text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
              },
              modelSelection: run.modelSelection,
              runtimePolicy,
              relatedThreadIds: context.subagents.flatMap((agent) =>
                agent.childThreadId ? [agent.childThreadId] : [],
              ),
              relatedProviderThreadIds: context.subagents.flatMap((agent) =>
                agent.providerThreadId ? [agent.providerThreadId] : [],
              ),
            });
          }
        }
        return true;
      }).pipe(Effect.mapError(failure(projection.thread.id, "restore")));
    return RemoteSessionRecovery.of({ preserve, isRemote });
  }),
);
