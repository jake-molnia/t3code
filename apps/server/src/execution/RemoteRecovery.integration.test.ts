import { captureRunPromise } from "./EffectHttpBoundary.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
// @effect-diagnostics nodeBuiltinImport:off -- Tests own real HTTP worker/control endpoints and a temporary SQLite database.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Exit from "effect/Exit";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as C from "@t3tools/contracts";
import * as CodexTestkit from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as RuntimeSchema from "../agentRuntime/Schema.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  materializeFixtureInput,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import { planQuestionsInput } from "../orchestration-v2/testkit/fixtures/plan_questions/input.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker, type ExecutionWorker } from "./ExecutionWorker.ts";
import { makeProviderExecutor } from "./ProviderExecutor.ts";
import { listenWorker } from "./WorkerHttpServer.ts";
import { createRemoteProviderAdapter } from "./RemoteProviderAdapter.ts";

it.live(
  "central restart retains a live input request and completes the original turn once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* checkpointWorkspace("remote-recovery");
        const dbPath = `${root}/central.sqlite`;
        const databaseContext = yield* Layer.build(
          Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
        );
        const sql = Context.get(databaseContext, SqlClient.SqlClient);
        const databaseLayer = Layer.succeed(SqlClient.SqlClient, sql);
        yield* RuntimeSchema.migrate.pipe(Effect.provide(databaseLayer));
        const fixture = yield* materializeFixtureInput({
          scenario: "plan_questions",
          fixtureInput: planQuestionsInput(),
          driver: C.ProviderDriverKind.make("codex"),
          modelSelection: CODEX_MODEL_SELECTION,
        });
        const threadId = fixture.projectionThreadIds[0];
        if (!threadId) return yield* Effect.die("Fixture has no thread");
        const rawTranscript = yield* readProviderReplayTranscript(
          new URL(
            "../orchestration-v2/testkit/fixtures/plan_questions/codex_transcript.ndjson",
            import.meta.url,
          ),
        );
        // This recording predates removal of the static plan-mode instruction override.
        const currentTranscript = {
          ...rawTranscript,
          entries: rawTranscript.entries.map((entry) => {
            if (entry.type !== "expect_outbound") return entry;
            const frame = entry.frame;
            if (
              !frame ||
              typeof frame !== "object" ||
              !("params" in frame) ||
              !frame.params ||
              typeof frame.params !== "object" ||
              !("collaborationMode" in frame.params)
            )
              return entry;
            const mode = frame.params.collaborationMode;
            if (
              !mode ||
              typeof mode !== "object" ||
              !("settings" in mode) ||
              !mode.settings ||
              typeof mode.settings !== "object"
            )
              return entry;
            const { developer_instructions: _legacy, ...settings } = Schema.decodeUnknownSync(
              Schema.Record(Schema.String, Schema.Unknown),
            )(mode.settings);
            return {
              ...entry,
              frame: {
                ...frame,
                params: { ...frame.params, collaborationMode: { ...mode, settings } },
              },
            };
          }),
        };
        const transcript = yield* CodexTestkit.CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(currentTranscript, root),
        );
        const nativeContext = yield* Layer.build(CodexTestkit.layer({ transcript }));
        const nativeRegistry = Context.get(nativeContext, Registry.ProviderAdapterRegistryV2);
        const native = yield* nativeRegistry.get(CODEX_MODEL_SELECTION.instanceId);
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(`${root}/worker.jsonl`)),
          (journal) => Effect.promise(journal.close),
        );
        const identity = {
          workspaceId: `t3:${threadId}`,
          allocationId: "test-allocation",
          generation: 1,
          podUid: "test-pod",
          incarnation: "surviving-worker",
          protocolVersion: 1 as const,
        };
        const token = "test-recovery-worker-token-more-than-thirty-two-characters";
        let worker: ExecutionWorker | undefined;
        let nativeTurnStarts = 0;
        const executor = yield* makeProviderExecutor({
          adapters: new Map([[native.instanceId, native]]),
          publish: (id, event) => {
            if (!worker) return Promise.reject(new Error("worker initialization"));
            return worker.publish(id, event);
          },
        });
        const run = yield* captureRunPromise;
        worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: (method, input) => {
            if (method === "startTurn") nativeTurnStarts++;
            return run(executor.execute(method, input));
          },
          activity: () => run(executor.activity),
        });
        const handle = worker.handle;
        const workerServer = yield* Effect.acquireRelease(
          Effect.tryPromise(() => listenWorker({ host: "127.0.0.1", port: 0, handle })),
          (server) => Effect.promise(server.close),
        );
        let lastOperation: { operationId: string; revision: number; action: string } = {
          operationId: "initial",
          revision: 1,
          action: "ensure_running",
        };
        let allocations = 0;
        let controlAvailable = true;
        let observedIdentity = identity;
        let observedEndpoint = `http://127.0.0.1:${workerServer.port}`;
        const control = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({
              host: "127.0.0.1",
              port: 0,
              handle: async (request) => {
                if (!controlAvailable) return new Response(null, { status: 503 });
                if (request.method === "POST") {
                  lastOperation = Schema.decodeUnknownSync(
                    Schema.Struct({
                      operationId: Schema.String,
                      revision: Schema.Number,
                      action: Schema.String,
                    }),
                  )(await request.json());
                  allocations++;
                  return Response.json({ accepted: true });
                }
                return Response.json({
                  state: {
                    request: lastOperation,
                    epoch: 1,
                    phase: "running",
                    completedOperation: lastOperation.operationId,
                    identity: observedIdentity,
                    endpoint: observedEndpoint,
                  },
                  token,
                });
              },
            }),
          ),
          (server) => Effect.promise(server.close),
        );
        const runtimeContext = yield* Layer.build(
          Runtime.layer.pipe(
            Layer.provide(databaseLayer),
            Layer.provide(NodeHttpClient.layerNodeHttp),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  AGENT_RUNTIME_URL: `http://127.0.0.1:${control.port}`,
                  AGENT_RUNTIME_TOKEN: "control-test-token",
                }),
              ),
            ),
          ),
        );
        const runtime = Context.get(runtimeContext, Runtime.RuntimeClient);
        const centralRegistry = Layer.succeed(
          Registry.ProviderAdapterRegistryV2,
          Registry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([native.instanceId]),
            get: () =>
              Effect.succeed({
                ...native,
                openSession: (input) =>
                  Effect.gen(function* () {
                    const attachOnly =
                      input.resumeFromSession !== undefined &&
                      input.resumeFromSession.status !== "stopped";
                    const observation = attachOnly
                      ? yield* runtime.observeThread(input.threadId)
                      : null;
                    if (observation?.kind === "stopped")
                      return yield* Effect.die("Worker unexpectedly stopped");
                    const client =
                      observation?.kind === "running"
                        ? observation.client
                        : yield* runtime.forThread(input.threadId);
                    yield* runtime.rememberSession(
                      input.providerSessionId,
                      input.threadId,
                      client.identity,
                    );
                    return yield* createRemoteProviderAdapter({
                      instanceId: native.instanceId,
                      driver: native.driver,
                      client,
                      attachOnly,
                      getEventCursor: (id) => run(runtime.getEventCursor(identity, id)),
                    }).openSession(input);
                  }).pipe(Effect.orDie),
              }),
          }),
        );
        const options = { databaseLayer, remoteRuntime: runtime };
        const scenario = {
          name: "remote-recovery",
          runtimePolicyOverride: {
            cwd: root,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        };
        const first = Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (const step of fixture.steps) {
            if (step.type === "respond_to_next_runtime_request") break;
            if (step.type === "dispatch") yield* orchestrator.dispatch(step.command);
          }
          yield* orchestrator
            .streamStoredEventsFrom({ threadId, eventType: "runtime-request.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "runtime-request.updated" &&
                  stored.event.payload.status === "pending",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            projection.runtimeRequests.filter((request) => request.status === "pending").length,
            1,
          );
          assert.equal(projection.runs.length, 1);
        });
        yield* Effect.scoped(
          first.pipe(Effect.provide(layerWithRegistry(scenario, centralRegistry, options))),
        );
        const allocationsBeforeRestart = allocations;
        const lostDatabasePath = `${root}/lost-worker.sqlite`;
        yield* sql`VACUUM INTO ${lostDatabasePath}`;
        controlAvailable = false;
        const unavailable = yield* Effect.exit(
          Effect.scoped(
            Orchestrator.OrchestratorV2.pipe(
              Effect.provide(
                layerWithRegistry(scenario, centralRegistry, {
                  ...options,
                  recoverOnStartup: true,
                }),
              ),
            ),
          ),
        );
        assert.isTrue(Exit.isFailure(unavailable));
        const preserved = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.flatMap((store) => store.getThreadProjection(threadId)),
          Effect.provide(ProjectionStore.layer.pipe(Layer.provide(databaseLayer))),
        );
        assert.equal(
          preserved.runtimeRequests.filter((request) => request.status === "pending").length,
          1,
        );
        assert.equal(preserved.runs[0]?.status, "running");
        assert.equal(nativeTurnStarts, 1);
        controlAvailable = true;
        const second = Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const request = projection.runtimeRequests.find(
            (request) => request.status === "pending",
          );
          if (!request) return yield* Effect.die("Pending request lost at restart");
          assert.equal(allocations, allocationsBeforeRestart);
          const answerStep = fixture.steps.find(
            (step) => step.type === "respond_to_next_runtime_request",
          );
          if (!answerStep || answerStep.type !== "respond_to_next_runtime_request")
            return yield* Effect.die("Missing answer fixture");
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: answerStep.commandId,
            threadId,
            requestId: request.id,
            answers: answerStep.answers,
          });
          yield* orchestrator.streamStoredEventsFrom({ threadId, eventType: "run.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const completed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(completed.runs.length, 1);
          assert.equal(completed.runs[0]?.status, "completed");
          assert.equal(nativeTurnStarts, 1);
        });
        yield* Effect.scoped(
          second.pipe(
            Effect.provide(
              layerWithRegistry(scenario, centralRegistry, { ...options, recoverOnStartup: true }),
            ),
          ),
        );
        // Recover the exact pending-request snapshot against a replacement worker.
        const replacementJournal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(`${root}/replacement.jsonl`)),
          (journal) => Effect.promise(journal.close),
        );
        const replacementIdentity = {
          ...identity,
          incarnation: "replacement-worker",
          podUid: "replacement-pod",
        };
        const replacement = createExecutionWorker({
          identity: replacementIdentity,
          token,
          journal: replacementJournal,
          execute: async () => null,
        });
        const replacementServer = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: replacement.handle }),
          ),
          (server) => Effect.promise(server.close),
        );
        observedIdentity = replacementIdentity;
        observedEndpoint = `http://127.0.0.1:${replacementServer.port}`;
        const lostDatabase = Sqlite.layerFromPath(lostDatabasePath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const lostRuntimeContext = yield* Layer.build(
          Runtime.layer.pipe(
            Layer.provide(lostDatabase),
            Layer.provide(NodeHttpClient.layerNodeHttp),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  AGENT_RUNTIME_URL: `http://127.0.0.1:${control.port}`,
                  AGENT_RUNTIME_TOKEN: "control-test-token",
                }),
              ),
            ),
          ),
        );
        const lostRuntime = Context.get(lostRuntimeContext, Runtime.RuntimeClient);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const lost = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              lost.runtimeRequests.filter((request) => request.status === "pending").length,
              0,
            );
            assert.equal(lost.runs[0]?.status, "cancelled");
            assert.equal(
              lost.providerSessions.filter((session) => session.status !== "stopped").length,
              0,
            );
            assert.equal(allocations, allocationsBeforeRestart);
            assert.equal(nativeTurnStarts, 1);
          }).pipe(
            Effect.provide(
              layerWithRegistry(scenario, centralRegistry, {
                databaseLayer: lostDatabase,
                remoteRuntime: lostRuntime,
                recoverOnStartup: true,
                continueThreadsAfterServerUpdate: false,
              }),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(IdAllocator.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  { timeout: 30000 },
);
