// @effect-diagnostics nodeBuiltinImport:off -- Transport verifies bounded chunks with incremental SHA-256 before durable admission.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import * as Worker from "../execution/WorkerUsage.ts";
import * as H from "../usage/UsageHistorySources.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(H.History));
const encode = Schema.encodeSync(Schema.fromJsonString(H.History));
const decodeExport = Schema.decodeUnknownEffect(Worker.Export);
const decodeChunk = Schema.decodeUnknownEffect(Worker.Chunk);
const failure = (cause: unknown) =>
  new C.UsageReadError({
    reason: "scanFailed",
    detail: "Sandbox usage history could not be collected.",
    cause,
  });
const sourceKey = (source: H.HistorySource) =>
  JSON.stringify([source.provider, source.dir, source.hostId ?? null]);

export function mergeHistory(previous: H.History, incoming: H.History, cutoff: number): H.History {
  const sources = new Map(previous.map((source) => [sourceKey(source), source]));
  for (const source of incoming) {
    const key = sourceKey(source);
    const old = sources.get(key);
    const files = new Map((old?.files ?? []).map((file) => [file.path, file]));
    for (const file of source.files ?? []) {
      const oldFile = files.get(file.path);
      if (
        source.status === "failed" ||
        (source.status === "partial" &&
          oldFile &&
          file.records.length <
            oldFile.records.filter((record) => record.timestampMs >= cutoff).length)
      )
        continue;
      files.set(file.path, file);
    }
    sources.set(key, { ...source, files: files.size > 0 ? [...files.values()] : source.files });
  }
  return [...sources.values()].map((source) => ({
    ...source,
    files:
      source.files
        ?.map((file) => ({
          ...file,
          records: file.records.filter((record) => record.timestampMs >= cutoff),
        }))
        .filter((file) => file.records.length > 0) ?? null,
  }));
}

export class UsageHistory extends Context.Service<
  UsageHistory,
  {
    readonly read: Effect.Effect<H.History, C.UsageReadError>;
    readonly collect: <E>(
      client: ExecutionClient,
      current: Effect.Effect<ExecutionIdentity | null, E>,
      force?: boolean,
    ) => Effect.Effect<void, C.UsageReadError>;
  }
>()("t3/agentRuntime/UsageHistory") {}

export const layer = Layer.effect(
  UsageHistory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locks = yield* KeyedLock.make<string>();
    const transfers = yield* Semaphore.make(2);
    const last = new Map<string, { at: number; incarnation: string }>();
    const read = Effect.gen(function* () {
      const cutoff = (yield* Clock.currentTimeMillis) - H.RETENTION_MS;
      yield* sql`DELETE FROM agent_runtime_usage_history WHERE updated_at < ${cutoff}`;
      const rows = yield* sql<{
        workspace_id: string;
        sources_json: string;
      }>`SELECT workspace_id,sources_json FROM agent_runtime_usage_history ORDER BY workspace_id`;
      const sources: H.HistorySource[] = [];
      for (const row of rows) {
        const retained = mergeHistory([], yield* decode(row.sources_json), cutoff);
        const pruned = encode(retained);
        if (pruned !== row.sources_json)
          yield* sql`UPDATE agent_runtime_usage_history SET sources_json=${pruned} WHERE workspace_id=${row.workspace_id} AND sources_json=${row.sources_json}`;
        for (const source of retained) {
          const prefix = `sandbox:${row.workspace_id}:`;
          sources.push({
            ...source,
            hostId: source.hostId ?? row.workspace_id,
            dir: source.hostId ? source.dir : prefix + source.dir,
            files: source.files?.map((file) => ({ ...file, path: prefix + file.path })) ?? null,
          });
        }
      }
      return sources;
    }).pipe(Effect.mapError(failure));
    const collect: UsageHistory["Service"]["collect"] = (client, current, force = false) =>
      locks.withLock(
        client.identity.workspaceId,
        transfers.withPermit(
          Effect.gen(function* () {
            const workspaceId = client.identity.workspaceId;
            const now = yield* Clock.currentTimeMillis;
            const prior = last.get(workspaceId);
            if (
              !force &&
              prior?.incarnation === client.identity.incarnation &&
              now - prior.at < 30_000
            )
              return;
            const rows = yield* sql<{
              revision: number;
            }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
            const revision = rows[0]?.revision;
            if (revision === undefined) return yield* failure("Workspace disappeared");
            const snapshot = yield* Effect.tryPromise(() => client.call("usage.history", {})).pipe(
              Effect.flatMap(decodeExport),
            );
            const incoming = yield* Effect.gen(function* () {
              const chunks: Buffer[] = [];
              let offset = 0;
              const digest = NodeCrypto.createHash("sha256");
              while (offset < snapshot.size) {
                const chunk = yield* Effect.tryPromise(() =>
                  client.call("usage.read", { exportId: snapshot.exportId, offset }),
                ).pipe(Effect.flatMap(decodeChunk));
                const bytes = Buffer.from(chunk.data, "base64");
                if (
                  chunk.offset !== offset ||
                  bytes.length === 0 ||
                  bytes.length > Worker.CHUNK_BYTES ||
                  offset + bytes.length > snapshot.size ||
                  bytes.toString("base64") !== chunk.data
                )
                  return yield* failure("Invalid history chunk");
                chunks.push(bytes);
                digest.update(bytes);
                offset += bytes.length;
              }
              if (digest.digest("hex") !== snapshot.digest)
                return yield* failure("History digest mismatch");
              return yield* decode(Buffer.concat(chunks).toString("utf8"));
            }).pipe(
              Effect.ensuring(
                Effect.tryPromise(() =>
                  client.call("usage.release", { exportId: snapshot.exportId }),
                ).pipe(Effect.timeout("5 seconds"), Effect.ignore),
              ),
            );
            const identity = yield* current.pipe(Effect.mapError(failure));
            if (!identity || !sameIdentity(identity, client.identity))
              return yield* failure("Worker changed during history collection");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{
                  revision: number;
                }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
                if (rows[0]?.revision !== revision)
                  return yield* failure("Workspace admission changed during history collection");
                const existing = yield* sql<{
                  sources_json: string;
                }>`SELECT sources_json FROM agent_runtime_usage_history WHERE workspace_id=${workspaceId}`;
                const previous = existing[0] ? yield* decode(existing[0].sources_json) : [];
                const sources = encode(mergeHistory(previous, incoming, now - H.RETENTION_MS));
                yield* sql`INSERT INTO agent_runtime_usage_history(workspace_id,sources_json,updated_at) VALUES (${workspaceId},${sources},${now}) ON CONFLICT(workspace_id) DO UPDATE SET sources_json=excluded.sources_json,updated_at=excluded.updated_at`;
              }),
            );
            last.set(workspaceId, { at: now, incarnation: client.identity.incarnation });
          }).pipe(Effect.timeout("2 minutes"), Effect.mapError(failure)),
        ),
      );
    return UsageHistory.of({ read, collect });
  }),
);

export const sourcesLayer = Layer.effect(
  H.UsageHistorySources,
  Effect.gen(function* () {
    const history = yield* UsageHistory;
    return H.UsageHistorySources.of({ read: history.read });
  }),
);
