import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import * as H from "../usage/UsageHistorySources.ts";
import * as ServerConfig from "../config.ts";
import * as UsageService from "../usage/UsageService.ts";
import { makeWorkerUsage } from "../execution/WorkerUsage.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as History from "./UsageHistory.ts";

const record = (timestampMs: number): typeof H.UsageRecord.Type => ({
  provider: "pi",
  timestampMs,
  model: "gpt-6-luna",
  sessionId: "native-session",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
  },
  reportedCostUsd: 0.01,
  speed: "standard",
  dedupeKey: "pi-native-entry",
});
const source = (timestampMs: number): H.HistorySource => ({
  provider: "pi",
  dir: "/workspace/.pi/sessions",
  volumeId: "retained-volume",
  files: [{ path: "/workspace/.pi/sessions/session.jsonl", records: [record(timestampMs)] }],
});
const nativeService = (readHistory: UsageService.UsageService["Service"]["readHistory"]) =>
  UsageService.UsageService.of({
    readHistory,
    readSummary: () => Effect.die("Worker export must not request pricing or summaries"),
    refreshRates: Effect.die("Worker export must not request pricing"),
  });

it.effect("preserves missing and partial files while pruning expired records", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const old = source(now);
    expect(
      History.mergeHistory([old], [{ ...old, status: "missing", files: null }], now - 1)[0]?.files,
    ).toEqual(old.files);
    expect(
      History.mergeHistory(
        [old],
        [
          {
            ...old,
            status: "partial",
            files: [{ path: "/workspace/.pi/sessions/session.jsonl", records: [] }],
          },
        ],
        now - 1,
      )[0]?.files,
    ).toEqual(old.files);
    expect(
      History.mergeHistory([old], [{ ...old, status: "failed", files: [] }], now - 1)[0]?.files,
    ).toEqual(old.files);
    expect(History.mergeHistory([old], [], now + 1)[0]?.files).toEqual([]);
    const replacement = {
      ...old,
      volumeId: "restored-volume",
      files: [
        {
          path: "/workspace/.pi/sessions/session.jsonl",
          records: [{ ...record(now), provider: "grok" as const, dedupeKey: null }],
        },
      ],
    };
    const priorVolume = { ...replacement, volumeId: "old-volume" };
    const merged = History.mergeHistory([priorVolume], [replacement], now - 1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.volumeId).toBe("restored-volume");
    expect(merged[0]?.files?.[0]?.records).toHaveLength(1);
  }),
);

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "durable sandbox usage history",
  (it) => {
    it.effect(
      "exports native records through fenced worker requests and serves them after restart without a worker",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usage-history-" });
          const now = yield* Clock.currentTimeMillis;
          let native: H.History = [source(now)];
          let calls = 0;
          const workerConfig = yield* Layer.build(
            ServerConfig.layerTest(directory, { prefix: "usage-worker-" }),
          );
          const workerUsage = yield* makeWorkerUsage.pipe(
            Effect.provideService(
              UsageService.UsageService,
              nativeService(Effect.sync(() => native)),
            ),
            Effect.provideContext(workerConfig),
          );
          const identity: ExecutionIdentity = {
            workspaceId: "workspace-a",
            allocationId: "1",
            generation: 1,
            incarnation: "first",
            podUid: "pod",
            protocolVersion: 1,
          };
          const run = yield* captureRunPromise;
          const journal = yield* Effect.tryPromise(() =>
            openWorkerJournal(`${directory}/journal.jsonl`),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => journal.close()));
          const worker = createExecutionWorker({
            identity,
            token: "t".repeat(32),
            journal,
            execute: (method, input) => {
              calls++;
              return run(workerUsage.execute(method, input));
            },
          });
          const client = createExecutionClient({
            identity,
            token: "t".repeat(32),
            endpoint: "http://worker",
            fetch: (url, init) => worker.handle(new Request(url, init)),
          });
          const database = `${directory}/central.sqlite`;
          const access = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
            operation.pipe(
              Effect.provide(
                History.layer.pipe(
                  Layer.provideMerge(NodeSqliteClient.layer({ filename: database })),
                ),
              ),
            );
          yield* Effect.gen(function* () {
            yield* RuntimeSchema.migrate;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('workspace-a','owner')`;
            const store = yield* History.UsageHistory;
            yield* store.collect(client, Effect.succeed(identity), true);
            expect((yield* workerUsage.activity).activeOperations).toBe(0);
            const before = calls;
            yield* store.collect(client, Effect.succeed(identity));
            expect(calls).toBe(before);
            native = [{ ...source(now), files: null, status: "missing" }];
            yield* store.collect(client, Effect.succeed(identity), true);
            expect((yield* store.read)[0]?.files?.[0]?.records).toEqual([record(now)]);
            native = [
              {
                ...source(now),
                status: "partial",
                files: [{ path: "/workspace/.pi/sessions/session.jsonl", records: [] }],
              },
            ];
            yield* store.collect(client, Effect.succeed(identity), true);
            expect((yield* store.read)[0]?.status).toBe("partial");
            expect((yield* store.read)[0]?.files?.[0]?.records).toEqual([record(now)]);
            expect(journal.operations.size).toBe(0);
          }).pipe(access);
          // New SQLite connection and service instance, with no RuntimeClient or reachable worker needed.
          const beforeRestart = calls;
          yield* Effect.gen(function* () {
            const store = yield* History.UsageHistory;
            const retained = yield* store.read;
            expect(calls).toBe(beforeRestart);
            expect(retained[0]?.files?.[0]?.records).toEqual([record(now)]);
            native = [
              {
                ...source(now),
                files: [
                  {
                    path: "/workspace/.pi/sessions/session.jsonl",
                    records: [
                      { ...record(now), totals: { ...record(now).totals, outputTokens: 999 } },
                    ],
                  },
                ],
              },
            ];
            const changed = { ...identity, incarnation: "replacement" };
            expect(
              (yield* store.collect(client, Effect.succeed(changed), true).pipe(Effect.exit))._tag,
            ).toBe("Failure");
            expect((yield* store.read)[0]?.files?.[0]?.records).toEqual([record(now)]);
            const sql = yield* SqlClient.SqlClient;
            const revisionChanged =
              sql`UPDATE agent_runtime_workspaces SET admission_revision=admission_revision+1 WHERE workspace_id='workspace-a'`.pipe(
                Effect.as(identity),
              );
            expect(
              (yield* store.collect(client, revisionChanged, true).pipe(Effect.exit))._tag,
            ).toBe("Failure");
            expect((yield* store.read)[0]?.files?.[0]?.records).toEqual([record(now)]);
            yield* sql`UPDATE agent_runtime_usage_history SET updated_at=${now - H.RETENTION_MS - 1}`;
            expect(yield* store.read).toEqual([]);
            expect(yield* sql`SELECT workspace_id FROM agent_runtime_usage_history`).toEqual([]);
          }).pipe(access);
          expect(calls).toBeGreaterThan(beforeRestart);
          expect((yield* workerUsage.activity).activeOperations).toBe(0);
        }).pipe(Effect.scoped),
    );
  },
);
