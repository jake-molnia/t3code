import { CommandId, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import { sameIdentity } from "./ExecutionWorker.ts";

const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionIdentity));
const decodeItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2TurnItem)),
);
export class RemoteCommandRecoveryError extends Schema.TaggedError<RemoteCommandRecoveryError>()(
  "RemoteCommandRecoveryError",
  { cause: Schema.Defect() },
) {}
export class RemoteCommandRecovery extends Context.Service<
  RemoteCommandRecovery,
  {
    readonly reconcile: Effect.Effect<void, RemoteCommandRecoveryError>;
  }
>()("t3/execution/RemoteCommandRecovery") {}

export const layer = Layer.effect(
  RemoteCommandRecovery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtime = yield* Runtime.RuntimeClient;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const commands = yield* ThreadCommands.ThreadCommandExecutor;
    const candidates = (threadId: string, itemIds?: ReadonlyArray<string>) => sql<{
      item_id: string;
      thread_id: string;
      identity_json: string;
      payload_json: string;
    }>`SELECT residency.item_id, residency.thread_id, residency.identity_json, item.payload_json
    FROM agent_runtime_command_residency AS residency
    JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = residency.item_id
    JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
    WHERE residency.thread_id = ${threadId}
      AND ${itemIds ? sql`residency.item_id IN ${sql.in(itemIds)}` : sql`1`} AND item.type = 'command_execution'
      AND item.status IN ('pending', 'running', 'waiting')
      AND run.status IN ('completed', 'failed', 'interrupted', 'cancelled')
    ORDER BY residency.checked_at, residency.item_id LIMIT 128`;
    const reconcile = Effect.gen(function* () {
      if (!runtime.enabled) return;
      // Only unresolved commands with captured execution provenance are eligible.
      // Terminal item events retire their rows; historical conversations are not scanned.
      const threads = yield* sql<{ thread_id: string }>`
      SELECT residency.thread_id FROM agent_runtime_command_residency AS residency
      JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = residency.item_id
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
      WHERE item.status IN ('pending', 'running', 'waiting')
        AND run.status IN ('completed', 'failed', 'interrupted', 'cancelled')
      GROUP BY residency.thread_id ORDER BY MIN(residency.checked_at) LIMIT 8`;
      yield* Effect.forEach(
        threads,
        ({ thread_id }) =>
          Effect.gen(function* () {
            const before = yield* candidates(thread_id);
            const checkedAt = yield* Clock.currentTimeMillis;
            if (before.length === 0) return;
            yield* sql`UPDATE agent_runtime_command_residency SET checked_at = ${checkedAt} WHERE item_id IN ${sql.in(before.map((row) => row.item_id))}`;
            const observed = yield* runtime.observeThread(ThreadId.make(thread_id));
            const currentIdentity =
              observed.kind === "running"
                ? yield* Effect.tryPromise(() => observed.client.inspectIdentity())
                : null;
            if (
              observed.kind === "running" &&
              (!currentIdentity || !sameIdentity(currentIdentity, observed.client.identity))
            )
              return;
            if (observed.kind === "stopped" && observed.completedStop?.action !== "release_compute")
              return;
            const lost = new Map<string, string>();
            for (const row of before) {
              const identity = yield* decodeIdentity(row.identity_json);
              if (currentIdentity && identity.workspaceId !== currentIdentity.workspaceId) continue;
              if (currentIdentity && sameIdentity(identity, currentIdentity)) continue;
              lost.set(row.item_id, row.identity_json);
            }
            if (lost.size === 0) return;
            yield* commands.withLock(
              ThreadId.make(thread_id),
              Effect.gen(function* () {
                // Re-read after observation: a completion or a newer incarnation may have won.
                for (const row of yield* candidates(thread_id, Array.from(lost.keys()))) {
                  if (lost.get(row.item_id) !== row.identity_json) continue;
                  const item = yield* decodeItem(row.payload_json);
                  if (item.type !== "command_execution") continue;
                  const now = yield* DateTime.now;
                  const identity = yield* decodeIdentity(row.identity_json);
                  const commandId = CommandId.make(
                    `remote-command-loss:${item.id}:${identity.incarnation}`,
                  );
                  yield* sink.write({
                    executionCommandGuard: {
                      itemId: row.item_id,
                      identityJson: row.identity_json,
                      payloadJson: row.payload_json,
                    },
                    events: [
                      {
                        id: yield* ids.allocate.event({
                          threadId: ThreadId.make(thread_id),
                          commandId,
                        }),
                        type: "turn-item.updated",
                        threadId: ThreadId.make(thread_id),
                        ...(item.runId ? { runId: item.runId } : {}),
                        occurredAt: now,
                        payload: {
                          ...item,
                          status: "interrupted",
                          completedAt: now,
                          updatedAt: now,
                        },
                      },
                    ],
                  });
                }
              }),
            );
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((cause) =>
              Effect.logWarning("Remote command recovery deferred", { threadId: thread_id, cause }),
            ),
          ),
        { concurrency: 2, discard: true },
      );
    }).pipe(Effect.mapError((cause) => new RemoteCommandRecoveryError({ cause })));
    return RemoteCommandRecovery.of({ reconcile });
  }),
);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const recovery = yield* RemoteCommandRecovery;
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("30 seconds");
        yield* recovery.reconcile.pipe(
          Effect.catch((cause) => Effect.logWarning("Remote command recovery failed", { cause })),
        );
      }
    }).pipe(Effect.forkScoped);
  }),
);
