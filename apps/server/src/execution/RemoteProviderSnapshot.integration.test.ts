// @effect-diagnostics nodeBuiltinImport:off -- Test owns its temporary worker journal and HTTP listener.
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Settings from "../serverSettings.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

it.live("central snapshots and refresh use routes supported by existing execution workers", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-provider-status-"))),
      (root) => Effect.promise(() => Fs.rm(root, { recursive: true, force: true })),
    );
    const journal = yield* Effect.acquireRelease(
      Effect.promise(() => openWorkerJournal(Path.join(root, "worker.jsonl"))),
      (journal) => Effect.promise(journal.close),
    );
    const instanceId = C.ProviderInstanceId.make("codex");
    const snapshot = yield* buildUnavailableProviderSnapshot({
      instanceId,
      driverKind: C.ProviderDriverKind.make("codex"),
      reason: "worker snapshot reached",
    });
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider))(snapshot);
    const identity = {
      workspaceId: "utility",
      allocationId: "one",
      generation: 1,
      podUid: "pod",
      incarnation: "process",
      protocolVersion: 1,
    } satisfies ExecutionIdentity;
    const methods: string[] = [];
    const worker = createExecutionWorker({
      identity,
      token: "worker-token-for-provider-status-test",
      journal,
      execute: async (method) => {
        methods.push(method);
        if (method === "configureProvider") return null;
        if (method === "provider.snapshot" || method === "provider.refresh") return encoded;
        throw new Error("unexpected method");
      },
    });
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle })),
      (server) => Effect.promise(server.close),
    );
    const client = createExecutionClient({
      identity,
      token: "worker-token-for-provider-status-test",
      endpoint: `http://127.0.0.1:${server.port}`,
    });
    yield* Effect.gen(function* () {
      const drivers = yield* makeRemoteDrivers;
      const driver = drivers.find((d) => d.driverKind === "codex");
      if (!driver) throw new Error("missing driver");
      const instance = yield* driver.create({
        instanceId,
        enabled: true,
        displayName: undefined,
        environment: [],
        config: yield* Schema.decodeUnknownEffect(C.CodexSettings)({ setupMode: "existing" }),
      });
      expect((yield* instance.snapshot.getSnapshot).message).toBe("worker snapshot reached");
      expect((yield* instance.snapshot.refresh).message).toBe("worker snapshot reached");
      expect(methods.filter((m) => m.startsWith("provider."))).toEqual([
        "provider.snapshot",
        "provider.refresh",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Settings.layerTest(),
          Layer.mock(Runtime.RuntimeClient)({
            enabled: true,
            forUtility: () => Effect.succeed(client),
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.live("disabled instances do not allocate or probe utility or project workspaces", () =>
  Effect.gen(function* () {
    let requests = 0;
    yield* Effect.gen(function* () {
      const drivers = yield* makeRemoteDrivers;
      for (const name of ["codex", "claudeAgent", "cursor", "muse"]) {
        const driver = drivers.find((d) => d.driverKind === name);
        if (!driver) throw new Error("missing driver");
        const instance = yield* driver.create({
          instanceId: C.ProviderInstanceId.make(name),
          enabled: false,
          displayName: undefined,
          environment: [],
          config: driver.defaultConfig(),
        });
        if (!instance.snapshotForCwd) throw new Error("missing workspace snapshot method");
        for (const snapshot of [
          yield* instance.snapshot.getSnapshot,
          yield* instance.snapshot.refresh,
          yield* instance.snapshotForCwd("/workspace"),
        ]) {
          expect(snapshot.enabled).toBe(false);
          expect(snapshot.status).toBe("disabled");
          expect(snapshot.models).toEqual([]);
        }
      }
      expect(requests).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Settings.layerTest(),
          Layer.mock(Runtime.RuntimeClient)({
            enabled: true,
            forUtility: () =>
              Effect.sync(() => {
                requests++;
                throw new Error("disabled provider allocated");
              }),
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
