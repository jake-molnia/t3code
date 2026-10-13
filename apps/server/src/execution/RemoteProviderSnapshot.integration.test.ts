import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
// @effect-diagnostics nodeBuiltinImport:off -- Test owns its temporary worker journal and HTTP listener.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Settings from "../serverSettings.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ConfigureProvider } from "./WorkerProviders.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

it.live("central snapshots and refresh use routes supported by existing execution workers", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-provider-status-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const journal = yield* Effect.acquireRelease(
      Effect.promise(() => openWorkerJournal(NodePath.join(root, "worker.jsonl"))),
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
      const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
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
      const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
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

const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String, input: Schema.Unknown })),
);
const decodeConfigure = Schema.decodeUnknownSync(Schema.toCodecJson(ConfigureProvider));

it.live.each(["grok", "opencode", "pi"])(
  "preserves resolved %s enablement across central and worker registry hydration",
  (kind) =>
    Effect.gen(function* () {
      const instanceId = C.ProviderInstanceId.make(kind);
      const snapshot = yield* buildUnavailableProviderSnapshot({
        instanceId,
        driverKind: C.ProviderDriverKind.make(kind),
        reason: "probe fixture",
      });
      const encodedSnapshot = yield* Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider))(
        snapshot,
      );
      const sent: C.ProviderInstanceConfig[] = [];
      const client = createExecutionClient({
        identity: {
          workspaceId: "utility",
          allocationId: "one",
          generation: 1,
          podUid: "pod",
          incarnation: "process",
          protocolVersion: 1,
        },
        token: "provider-test-token",
        endpoint: "http://worker.test",
        fetch: async (_url, init) => {
          const frame = decodeFrame(init?.body);
          if (frame.method === "configureProvider") {
            sent.push(decodeConfigure(frame.input).config);
            return Response.json({ ok: true, value: null });
          }
          return Response.json({ ok: true, value: encodedSnapshot });
        },
      });
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
        const driver = drivers.find((d) => d.driverKind === kind);
        if (!driver) throw new Error("missing driver");
        const central = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: {
            [instanceId]: { driver: C.ProviderDriverKind.make(kind), enabled: true, config: {} },
          },
        });
        const instance = yield* central.registry.getInstance(instanceId);
        if (!instance) throw new Error("central instance missing");
        expect(instance.enabled).toBe(true);
        yield* instance.snapshot.refresh;
        expect(sent).toHaveLength(1);
        const transported = sent[0];
        if (!transported) throw new Error("configuration not transported");
        const worker = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [instanceId]: transported },
        });
        expect((yield* worker.registry.getInstance(instanceId))?.enabled).toBe(true);
        for (const disabled of [
          { enabled: false, config: { enabled: true } },
          { enabled: true, config: { enabled: false } },
        ]) {
          const registry = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [instanceId]: { driver: C.ProviderDriverKind.make(kind), ...disabled } },
          });
          const disabledInstance = yield* registry.registry.getInstance(instanceId);
          if (!disabledInstance) throw new Error("disabled instance missing");
          expect(disabledInstance.enabled).toBe(false);
          expect((yield* disabledInstance.snapshot.refresh).enabled).toBe(false);
        }
        expect(sent).toHaveLength(1);
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
