import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Bindings from "../agentRuntime/Bindings.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Routing from "../agentRuntime/WorkspaceRouting.ts";
import { SessionPlacement } from "../execution/SessionPlacement.ts";
import { dispatchFailure } from "../mcp/threadAccess.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Worker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const sourceId = C.ThreadId.make("fork-workspace-source");
const targetId = C.ThreadId.make("fork-workspace-target");
const runId = C.RunId.make("fork-workspace-run");
const nodeId = C.NodeId.make("fork-workspace-node");
const checkpointId = C.CheckpointId.make("fork-workspace-checkpoint");
const provider = C.ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "test" };
const pendingMessage = "The source checkpoint is still preparing. Retry when it is ready.";
const unavailableMessage = "No usable checkpoint is available for the selected run.";

function fixture(placement: "per-thread" | "shared-when-supported" = "per-thread") {
  const acquired: string[] = [];
  const described: string[] = [];
  const database = Sqlite.layerMemory;
  const routes = Layer.mock(Routing.WorkspaceRouting)({
    enabled: true,
    describeThread: (id) =>
      Effect.sync(() => {
        described.push(id);
        return {
          workspaceId: `t3:${id}`,
          virtualCwd: `/workspace/${id}/repo`,
          relativeCwd: `${id}/repo`,
        };
      }),
  });
  const runtime = Layer.mock(Runtime.RuntimeClient)({
    enabled: true,
    forThread: (id) =>
      Effect.sync(() => acquired.push(id)).pipe(
        Effect.andThen(Effect.die("Unexpected worker acquisition")),
      ),
  });
  const harness = Harness.layerWithRegistry(
    { name: "fork-workspace-admission" },
    Registry.layerFromAdapters([
      {
        instanceId: provider,
        driver: C.ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Unexpected provider execution"),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false },
  ).pipe(
    Layer.provide(routes),
    Layer.provide(runtime),
    Layer.provide(Layer.succeed(SessionPlacement, placement)),
  );
  return {
    acquired,
    described,
    layer: Layer.mergeAll(harness, Outbox.layer.pipe(Layer.provideMerge(database))),
  };
}

const source = (status: C.OrchestrationV2Run["status"], withCheckpointId = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: C.CommandId.make("create-fork-source"),
      threadId: sourceId,
      projectId: C.ProjectId.make("fork-workspace-project"),
      title: "Source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/workspace/source/repo",
      createdBy: "user",
      creationSource: "web",
    });
    yield* sink.write({
      events: [
        {
          id: C.EventId.make("fork-source-run"),
          type: "run.created",
          threadId: sourceId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceId,
            ordinal: 1,
            providerInstanceId: provider,
            modelSelection,
            providerThreadId: null,
            userMessageId: C.MessageId.make("fork-source-message"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: status === "running" ? null : now,
            checkpointId: withCheckpointId ? checkpointId : null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const capture = (status: C.OrchestrationV2Checkpoint["status"] = "ready", checkpointRun = runId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: C.EventId.make(`fork-checkpoint-${status}`),
          type: "checkpoint.captured",
          threadId: sourceId,
          runId: checkpointRun,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: sourceId,
            scopeId: C.CheckpointScopeId.make("fork-workspace-scope"),
            runId: checkpointRun,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: C.CheckpointRef.make("refs/t3/checkpoints/fork-source"),
            status,
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
  });

const fork = (
  command = "fork-workspace",
  sourcePoint: Extract<C.OrchestrationV2Command, { type: "thread.fork" }>["sourcePoint"] = {
    type: "run",
    runId,
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: C.CommandId.make(command),
      sourceThreadId: sourceId,
      targetThreadId: targetId,
      sourcePoint,
      createdBy: "user",
      creationSource: "web",
    });
  });

const noTarget = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.equal(
    (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${targetId}`)
      .length,
    0,
  );
  assert.equal(
    (yield* sql`SELECT thread_id FROM agent_runtime_thread_bindings WHERE thread_id=${targetId}`)
      .length,
    0,
  );
  assert.equal(
    (yield* sql`SELECT workspace_id FROM agent_runtime_workspaces WHERE owner_thread_id=${targetId}`)
      .length,
    0,
  );
  assert.equal(
    (yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id=${targetId}`)
      .length,
    0,
  );
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  assert.isFalse(yield* worker.runOnce);
});

const rejected = (message: string) =>
  Effect.gen(function* () {
    const error = yield* fork().pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    assert.equal(userFacingDispatchErrorMessage(error), message);
    const mcp = dispatchFailure(error);
    assert.equal(mcp._tag, "OrchestratorMcpFailure");
    assert.equal(mcp.code, "orchestration_error");
    assert.equal(mcp.message, message);
    yield* noTarget;
  });

it.effect.each(["failed", "completed"] as const)(
  "rejects %s source without native session or checkpoint before creating a target",
  (status) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* source(status);
      yield* rejected(unavailableMessage);
      assert.deepEqual(f.described, []);
      assert.deepEqual(f.acquired, []);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["missing", "error", "stale"] as const)(
  "rejects the selected run's %s checkpoint",
  (status) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* source("completed", true);
      yield* capture(status);
      yield* rejected(unavailableMessage);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("does not substitute another run's ready checkpoint", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* source("completed");
    yield* capture("ready", C.RunId.make("different-run"));
    yield* rejected(unavailableMessage);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "rejects pending delivery, then a ready retry creates exactly one independent workspace binding",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* source("waiting");
      yield* rejected(pendingMessage);
      assert.deepEqual(f.acquired, []);
      yield* capture();
      yield* fork("fork-ready-retry");
      yield* fork("fork-ready-retry");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT workspace_id FROM agent_runtime_workspaces WHERE owner_thread_id=${targetId}`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT thread_id FROM agent_runtime_thread_bindings WHERE thread_id=${targetId}`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id=${targetId}`)
          .length,
        1,
      );
      assert.notEqual(
        (yield* Bindings.read(sourceId)).workspaceId,
        (yield* Bindings.read(targetId)).workspaceId,
      );
      assert.deepEqual(f.described, [targetId]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["failed", "completed"] as const)(
  "accepts %s source with a ready checkpoint without requiring a native session",
  (status) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* source(status, true);
      yield* capture();
      yield* fork();
      const binding = yield* Bindings.read(targetId);
      assert.equal(binding.ownerThreadId, targetId);
      assert.notEqual(binding.workspaceId, (yield* Bindings.read(sourceId)).workspaceId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const target = yield* orchestrator.getThreadRecords(targetId, ["contextTransfers"]);
      assert.equal(target.thread.worktreePath, `/workspace/${targetId}/repo`);
      assert.equal(target.thread.branch, "main");
      assert.equal(target.thread.lineage.relationshipToParent, "fork");
      const outbox = yield* Outbox.EffectOutboxV2;
      assert.equal(
        Option.getOrThrow(yield* outbox.get(`effect:fork-workspace:${targetId}`)).status,
        "pending",
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("still rejects active source runs even when a checkpoint exists", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* source("running", true);
    yield* capture();
    const error = yield* fork().pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    assert.include(
      userFacingDispatchErrorMessage(error) ?? "",
      "in-progress and rolled-back runs cannot be forked",
    );
    yield* noTarget;
  }).pipe(Effect.provide(f.layer));
});

it.effect("preserves upstream shared-session forks without workspace checkpoint admission", () => {
  const f = fixture("shared-when-supported");
  return Effect.gen(function* () {
    yield* source("failed");
    yield* fork();
    const outbox = yield* Outbox.EffectOutboxV2;
    assert.isTrue(Option.isNone(yield* outbox.get(`effect:fork-workspace:${targetId}`)));
  }).pipe(Effect.provide(f.layer));
});
