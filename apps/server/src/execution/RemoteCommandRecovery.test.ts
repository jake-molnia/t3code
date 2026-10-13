import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Recovery from "./RemoteCommandRecovery.ts";
import { createExecutionClient } from "./ExecutionClient.ts";

const services = Events.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, Projections.layer).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  ),
);
const identity = (workspace: string, incarnation: string): ExecutionIdentity => ({
  workspaceId: `t3:${workspace}`,
  allocationId: incarnation,
  generation: 1,
  podUid: incarnation,
  incarnation,
  protocolVersion: 1,
});
const seed = Effect.fn(function* (
  name: string,
  ordinal: number,
  status: C.OrchestrationV2Run["status"],
  worker?: ExecutionIdentity,
) {
  const sink = yield* Events.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = C.ThreadId.make(name),
    runId = C.RunId.make(`${name}:${ordinal}`);
  const instanceId = C.ProviderInstanceId.make("codex");
  if (ordinal === 1)
    yield* sink.write({
      events: [
        {
          id: C.EventId.make(`${name}:create`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: C.ProjectId.make("project"),
            title: name,
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
            settledAt: null,
            settledOverride: null,
            lastVisitedAt: null,
          },
        },
      ],
    });
  yield* sink.write({
    events: [
      {
        id: C.EventId.make(`${runId}:create`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          providerThreadId: null,
          userMessageId: C.MessageId.make(`${runId}:message`),
          rootNodeId: null,
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
  const item: Extract<C.OrchestrationV2TurnItem, { type: "command_execution" }> = {
    id: C.TurnItemId.make(`${runId}:command`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "command_execution",
    status: "running",
    title: "server",
    input: "python3 -m http.server",
    output: "Serving port 8766",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const event: C.OrchestrationV2DomainEvent = {
    id: C.EventId.make(`${item.id}:running`),
    type: "turn-item.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: item,
  };
  yield* sink.write({
    events: [event],
    ...(worker
      ? { executionDelivery: { identity: worker, sequence: ordinal, sessionId: name, event: {} } }
      : {}),
  });
  return { item, event };
});

it.effect(
  "interrupts only commands with proven lost worker identity and retires repaired records",
  () =>
    Effect.gen(function* () {
      const old = yield* seed("replaced", 1, "completed", identity("replaced", "old"));
      const active = yield* seed("replaced", 2, "running", identity("replaced", "current"));
      const live = yield* seed("live", 1, "completed", identity("live", "current"));
      const legacy = yield* seed("legacy", 1, "completed");
      let observations = 0;
      const runtime = Layer.mock(Runtime.RuntimeClient)({
        enabled: true,
        observeThread: (threadId) =>
          Effect.sync(() => {
            observations++;
            const current = identity(threadId, "current");
            return {
              kind: "running" as const,
              client: createExecutionClient({
                identity: current,
                token: "test",
                endpoint: "http://worker.test",
                fetch: async () => Response.json(current),
              }),
            };
          }),
      });
      yield* Effect.gen(function* () {
        const recovery = yield* Recovery.RemoteCommandRecovery;
        const projections = yield* Projections.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* recovery.reconcile;
        const replaced = yield* projections.getThreadProjection(old.item.threadId);
        expect(replaced.turnItems.find((item) => item.id === old.item.id)?.status).toBe(
          "interrupted",
        );
        expect(replaced.turnItems.find((item) => item.id === active.item.id)?.status).toBe(
          "running",
        );
        expect(replaced.runs.find((run) => run.id === active.item.runId)?.status).toBe("running");
        expect(
          (yield* projections.getThreadProjection(live.item.threadId)).turnItems[0]?.status,
        ).toBe("running");
        expect(
          (yield* projections.getThreadProjection(legacy.item.threadId)).turnItems[0]?.status,
        ).toBe("running");
        expect(
          yield* sql`SELECT item_id FROM agent_runtime_command_residency WHERE item_id = ${old.item.id}`,
        ).toHaveLength(0);
        const previous = observations;
        yield* recovery.reconcile;
        expect(observations - previous).toBe(1); // Only the genuinely live background command remains eligible.
      }).pipe(
        Effect.provide(
          Recovery.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(ThreadCommands.layer),
            Layer.provide(IdAllocator.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(services)),
);

it.effect("rolls back command provenance with a rejected event transaction", () =>
  Effect.gen(function* () {
    const { event, item } = yield* seed("rollback", 1, "completed");
    const sink = yield* Events.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sink
      .write({
        executionDelivery: {
          identity: identity("rollback", "old"),
          sequence: 1,
          sessionId: "rollback",
          event: {},
        },
        events: [
          { ...event, id: C.EventId.make("rollback:remote-command") },
          {
            id: C.EventId.make("rollback:bad-child"),
            type: "thread.created",
            threadId: C.ThreadId.make("bad-child"),
            occurredAt: event.occurredAt,
            payload: {
              ...(yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(item.threadId))
                .thread,
              id: C.ThreadId.make("bad-child"),
              lineage: {
                parentThreadId: C.ThreadId.make("missing-parent"),
                relationshipToParent: "subagent",
                rootThreadId: item.threadId,
              },
            },
          },
        ],
      })
      .pipe(Effect.flip);
    expect(yield* sql`SELECT * FROM agent_runtime_command_residency`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM agent_runtime_event_cursors`).toHaveLength(0);
  }).pipe(Effect.provide(services)),
);

it.effect("the atomic recovery guard cannot overwrite a concurrent command completion", () =>
  Effect.gen(function* () {
    const { event, item } = yield* seed("race", 1, "completed", identity("race", "old"));
    const sink = yield* Events.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      identity_json: string;
      payload_json: string;
    }>`SELECT residency.identity_json,item.payload_json
    FROM agent_runtime_command_residency residency JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id=residency.item_id`;
    if (!row) throw new Error("Missing fixture provenance");
    yield* sink.write({
      events: [
        {
          ...event,
          id: C.EventId.make("race:complete"),
          payload: { ...item, status: "completed", exitCode: 0, completedAt: event.occurredAt },
        },
      ],
    });
    const stored = yield* sink.write({
      executionCommandGuard: {
        itemId: item.id,
        identityJson: row.identity_json,
        payloadJson: row.payload_json,
      },
      events: [
        {
          ...event,
          id: C.EventId.make("race:stale-recovery"),
          payload: { ...item, status: "interrupted", completedAt: event.occurredAt },
        },
      ],
    });
    expect(stored).toHaveLength(0);
    expect(
      (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(item.threadId))
        .turnItems[0]?.status,
    ).toBe("completed");
  }).pipe(Effect.provide(services)),
);

it.effect.each(["released", "suspended", "unconfirmed"] as const)(
  "requires a completed release before interrupting commands on a stopped worker (%s)",
  (state) =>
    Effect.gen(function* () {
      const { item } = yield* seed(
        `stop-${state}`,
        1,
        "completed",
        identity(`stop-${state}`, "old"),
      );
      const runtime = Layer.mock(Runtime.RuntimeClient)({
        enabled: true,
        observeThread: () =>
          Effect.succeed({
            kind: "stopped",
            ...(state === "unconfirmed"
              ? {}
              : {
                  completedStop: {
                    operationId: "stop",
                    revision: 1,
                    action:
                      state === "released" ? ("release_compute" as const) : ("suspend" as const),
                  },
                }),
          }),
      });
      yield* Effect.gen(function* () {
        yield* (yield* Recovery.RemoteCommandRecovery).reconcile;
        const projection = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(
          item.threadId,
        );
        expect(projection.turnItems[0]?.status).toBe(
          state === "released" ? "interrupted" : "running",
        );
      }).pipe(
        Effect.provide(
          Recovery.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(ThreadCommands.layer),
            Layer.provide(IdAllocator.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(services)),
);

it.effect("bounds a thread batch and advances beyond its first page", () =>
  Effect.gen(function* () {
    const { item, event } = yield* seed("batch", 1, "completed", identity("batch", "old"));
    const sink = yield* Events.EventSinkV2;
    yield* sink.write({
      executionDelivery: {
        identity: identity("batch", "old"),
        sequence: 2,
        sessionId: "batch",
        event: {},
      },
      events: Array.from({ length: 129 }, (_, index) => ({
        ...event,
        id: C.EventId.make(`batch:event:${index}`),
        payload: { ...item, id: C.TurnItemId.make(`batch:item:${index}`), ordinal: index + 2 },
      })),
    });
    let observations = 0;
    const current = identity("batch", "current");
    const runtime = Layer.mock(Runtime.RuntimeClient)({
      enabled: true,
      observeThread: () =>
        Effect.sync(() => {
          observations++;
          return {
            kind: "running" as const,
            client: createExecutionClient({
              identity: current,
              token: "test",
              endpoint: "http://worker.test",
              fetch: async () => Response.json(current),
            }),
          };
        }),
    });
    yield* Effect.gen(function* () {
      const recovery = yield* Recovery.RemoteCommandRecovery;
      const sql = yield* SqlClient.SqlClient;
      yield* recovery.reconcile;
      expect(yield* sql`SELECT item_id FROM agent_runtime_command_residency`).toHaveLength(2);
      yield* recovery.reconcile;
      expect(yield* sql`SELECT item_id FROM agent_runtime_command_residency`).toHaveLength(0);
      const final = observations;
      yield* recovery.reconcile;
      expect(observations).toBe(final);
    }).pipe(
      Effect.provide(
        Recovery.layer.pipe(
          Layer.provide(runtime),
          Layer.provide(ThreadCommands.layer),
          Layer.provide(IdAllocator.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(services)),
);
