import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Bindings from "./Bindings.ts";

const services = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  ),
);
const now = DateTime.makeUnsafe("2026-10-08T00:00:00Z");
function thread(
  id: string,
  parent?: { id: string; relationship: "fork" | "subagent" },
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project:shared"),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: parent ? ThreadId.make(parent.id) : null,
      relationshipToParent: parent?.relationship ?? null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
function created(value: OrchestrationV2AppThread): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`create:${value.id}`),
    type: "thread.created",
    threadId: value.id,
    providerInstanceId: value.providerInstanceId,
    occurredAt: now,
    payload: value,
  };
}

it.layer(services)("execution binding transactions", (it) => {
  it.effect("independent roots and forks allocate separately while nested subagents inherit", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const roots = [thread("root-a"), thread("root-b")];
      const child = thread("child-a", { id: "root-a", relationship: "subagent" });
      const grandchild = thread("grandchild-a", { id: "child-a", relationship: "subagent" });
      const fork = thread("fork-a", { id: "root-a", relationship: "fork" });
      yield* sink.write({ events: [...roots, child, grandchild, fork].map(created) });
      const a = yield* Bindings.read("root-a");
      assert.strictEqual((yield* Bindings.read("child-a")).workspaceId, a.workspaceId);
      assert.strictEqual((yield* Bindings.read("grandchild-a")).workspaceId, a.workspaceId);
      assert.notStrictEqual((yield* Bindings.read("root-b")).workspaceId, a.workspaceId);
      assert.notStrictEqual((yield* Bindings.read("fork-a")).workspaceId, a.workspaceId);
    }),
  );
  it.effect("missing delegation owner rolls back the thread and event transaction", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const bad = thread("orphan", { id: "missing", relationship: "subagent" });
      yield* sink.write({ events: [created(bad)] }).pipe(Effect.flip);
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = 'orphan'`;
      assert.strictEqual(rows.length, 0);
      const bindings =
        yield* sql`SELECT thread_id FROM agent_runtime_thread_bindings WHERE thread_id = 'orphan'`;
      assert.strictEqual(bindings.length, 0);
    }),
  );
  it.effect(
    "commits the worker cursor atomically and ignores a replay with new domain event ids",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const value = thread("cursor-root");
        yield* sink.write({ events: [created(value)] });
        const binding = yield* Bindings.read(value.id);
        const delivery = {
          identity: {
            workspaceId: binding.workspaceId,
            allocationId: "allocation",
            generation: 1,
            incarnation: "worker-1",
            protocolVersion: 1 as const,
            podUid: "pod",
          },
          sequence: 1,
          sessionId: "session",
          event: {},
        };
        const update = (id: string, title: string): OrchestrationV2DomainEvent => ({
          id: EventId.make(id),
          type: "thread.metadata-updated",
          threadId: value.id,
          providerInstanceId: value.providerInstanceId,
          occurredAt: now,
          payload: { ...value, title },
        });
        yield* sink.write({ events: [update("first", "committed")], executionDelivery: delivery });
        const replay = yield* sink.write({
          events: [update("different-id", "duplicate")],
          executionDelivery: delivery,
        });
        assert.strictEqual(replay.length, 0);
        assert.strictEqual((yield* projections.getThread(value.id)).title, "committed");
        assert.strictEqual(yield* Bindings.cursor(binding.workspaceId, "worker-1", "session"), 1);
      }),
  );
});
