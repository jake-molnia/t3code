import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceRouting from "./agentRuntime/WorkspaceRouting.ts";
import * as RuntimeClient from "./agentRuntime/RuntimeClient.ts";
import * as RuntimeSchema from "./agentRuntime/Schema.ts";
import {
  WorkspaceActivity,
  WorkspaceRecentActivity,
  withWorkspaceActivity,
} from "./agentRuntime/WorkspaceActivity.ts";
import { createExecutionClient } from "./execution/ExecutionClient.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  hasCompatibleOrchestrationProtocol,
  resolveDirectEndpointsForConfig,
  refreshProviderWorkspaceSnapshot,
  shouldUseBoundedThreadSnapshot,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
} from "./ws.ts";

const isWorkspaceRoutingError = Schema.is(WorkspaceRouting.WorkspaceRoutingError);

it.effect.each(["running", "stopped", "fresh", "denied"] as const)(
  "workspace provider refresh after the five-minute scan interval: %s",
  (mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('metadata-workspace','metadata-owner')`;
      yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd) VALUES ('/workspace/metadata/repo','metadata-workspace','metadata/repo')`;
      let running = mode === "running";
      let ensures = 0;
      let metadataReads = 0;
      const denied = new RuntimeClient.RuntimeClientError({
        operation: "observe-workspace",
        httpStatus: 401,
        cause: "Unauthorized fixture",
      });
      const client = {
        ...createExecutionClient({
          endpoint: "http://worker.test",
          token: "fixture",
          identity: {
            workspaceId: "metadata-workspace",
            allocationId: "one",
            generation: 1,
            incarnation: "one",
            podUid: "one",
            protocolVersion: 1,
          },
        }),
        call: async () => {
          metadataReads++;
          return null;
        },
      };
      const cached: ReadonlyArray<ServerProvider> = [];
      const scanned: ReadonlyArray<ServerProvider> = [];
      const routes = yield* WorkspaceRouting.WorkspaceRouting.pipe(
        Effect.provide(
          WorkspaceRouting.layer.pipe(
            Layer.provide(
              Layer.mock(RuntimeClient.RuntimeClient)({
                enabled: true,
                forWorkspace: () =>
                  withWorkspaceActivity(
                    "metadata-workspace",
                    Effect.sync(() => {
                      ensures++;
                      running = true;
                      return client;
                    }),
                  ),
                observeWorkspace: () =>
                  mode === "denied"
                    ? Effect.fail(denied)
                    : Effect.sync(() =>
                        running
                          ? { kind: "running" as const, client }
                          : { kind: "stopped" as const },
                      ),
              }),
            ),
          ),
        ),
      );
      const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(cached),
        refreshWorkspaceSnapshot: ({ cwd }) =>
          Effect.gen(function* () {
            if (mode === "running")
              assert.isTrue((yield* WorkspaceActivity).has("metadata-workspace"));
            const destination = yield* routes.clientForCwd(cwd);
            yield* Effect.promise(() => destination.call("provider.snapshotForCwd", cwd));
            return scanned;
          }).pipe(Effect.orDie),
      });
      const recent = yield* WorkspaceRecentActivity;
      yield* withWorkspaceActivity("metadata-workspace", Effect.void);
      const previous = recent.get("metadata-workspace");
      yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
      const request = refreshProviderWorkspaceSnapshot({
        instanceId: ProviderInstanceId.make("pi"),
        cwd: "/workspace/metadata/repo",
        fresh: mode === "fresh",
      }).pipe(
        Effect.provide(registry),
        Effect.provideService(WorkspaceRouting.WorkspaceRouting, routes),
      );
      if (mode === "denied") {
        const error = yield* request.pipe(Effect.flip);
        assert.equal(error._tag, "ProviderSetupError");
        if (!isWorkspaceRoutingError(error.cause))
          return assert.fail("Missing typed routing cause");
        assert.strictEqual(error.cause.cause, denied);
        assert.equal(ensures, 0);
        assert.equal(metadataReads, 0);
        assert.equal(recent.get("metadata-workspace"), previous);
        return;
      }
      const result = yield* request;
      assert.strictEqual(result, mode === "stopped" ? cached : scanned);
      assert.equal(ensures, mode === "fresh" ? 1 : 0);
      assert.equal(metadataReads, mode === "stopped" ? 0 : 1);
      assert.equal((yield* WorkspaceActivity).has("metadata-workspace"), false);
      if (mode === "fresh") assert.isAbove(recent.get("metadata-workspace")!, previous!);
      else assert.equal(recent.get("metadata-workspace"), previous);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
);

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when endpoint discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveDirectEndpointsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);
