import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import { SandboxLifecycle } from "../sandbox/SandboxLifecycle.ts";
import { poolsLayer } from "../agentRuntime/testkit/Sandbox.ts";
import { FetchHttpClient } from "effect/http";
import * as RuntimeSchema from "../agentRuntime/Schema.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as C from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { createModelCapabilities } from "@t3tools/shared/model";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import {
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../provider/providerStatusCache.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { ConfigureProvider } from "./WorkerProviders.ts";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String, input: Schema.Unknown })),
);
const decodeConfiguration = Schema.decodeUnknownSync(Schema.toCodecJson(ConfigureProvider));
const encodeSnapshot = Schema.encodeSync(Schema.toCodecJson(C.ServerProvider));
const decodeConfig = Schema.decodeEffect(C.CodexSettings);

const capabilities = createModelCapabilities({ optionDescriptors: [] });
const cached: C.ServerProvider = {
  instanceId: C.ProviderInstanceId.make("cached-codex"),
  driver: C.ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  displayName: "Previous name",
  accentColor: "#123456",
  supportsConversationRollback: false,
  supportedRuntimeModes: ["approval-required", "full-access"],
  requiresNewThreadForModelChange: true,
  reportsContextWindow: true,
  showInteractionModeToggle: false,
  models: [
    { slug: "built-in", name: "Built in", isCustom: false, capabilities },
    { slug: "retained", name: "Retained", isCustom: true, capabilities },
    { slug: "removed", name: "Removed", isCustom: true, capabilities },
  ],
  slashCommands: [],
  skills: [],
};

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeSqliteClient.layer({ filename: ":memory:" }),
    FetchHttpClient.layer,
  ),
)("remote provider persisted status", (it) => {
  it.effect.each([
    "native",
    "complete",
    "gateway",
    "missing",
    "malformed",
    "identity",
    "driver",
    "enabled",
    "disabled",
  ] as const)("%s cache on cold factory creation", (scenario) =>
    Effect.gen(function* () {
      const passiveRuntime =
        scenario === "gateway"
          ? yield* Effect.gen(function* () {
              yield* RuntimeSchema.migrate;
              return yield* Runtime.RuntimeClient.pipe(
                Effect.provide(
                  Runtime.layer.pipe(
                    Layer.provide(poolsLayer()),
                    Layer.provide(Layer.mock(SandboxLifecycle)({})),
                  ),
                ),
              );
            })
          : undefined;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "remote-provider-status-cache-" });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(root, root)),
      );
      const filePath = yield* resolveProviderStatusCachePath({
        cacheDir: config.providerStatusCacheDir,
        instanceId: cached.instanceId,
      });
      const stored = {
        ...cached,
        ...(scenario === "identity"
          ? { instanceId: C.ProviderInstanceId.make("another-instance") }
          : {}),
        ...(scenario === "driver" ? { driver: C.ProviderDriverKind.make("grok") } : {}),
        ...(scenario === "enabled" ? { enabled: false } : {}),
        ...(scenario === "complete" || scenario === "gateway" ? { modelsComplete: true } : {}),
      };
      if (scenario !== "missing") yield* writeProviderStatusCache({ filePath, provider: stored });
      if (scenario === "malformed") yield* fs.writeFileString(filePath, "not-json");
      let allocations = 0;
      const configured: C.ProviderInstanceConfig[] = [];
      const client = createExecutionClient({
        identity: {
          workspaceId: "utility",
          allocationId: "one",
          incarnation: "one",
          podUid: "one",
          generation: 1,
          protocolVersion: 1,
        },
        endpoint: "http://worker.test",
        token: "test-token",
        fetch: async (_url, init) => {
          const request = decodeRequest(init?.body);
          if (request.method === "configureProvider") {
            const payload = decodeConfiguration(request.input);
            configured.push(payload.config);
            return Response.json({ ok: true, value: null });
          }
          return Response.json({
            ok: true,
            value: encodeSnapshot({
              ...cached,
              models: [],
            }),
          });
        },
      });
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown(
                scenario === "gateway" ? { T3_GATEWAY_API_KEY: "gateway-test-key" } : {},
              ),
            ),
          ),
        );
        const driver = drivers.find((entry) => entry.driverKind === "codex");
        if (!driver) return yield* Effect.die("Missing Codex driver");
        const instance = yield* driver.create({
          instanceId: cached.instanceId,
          enabled: scenario !== "disabled",
          displayName: "Current name",
          accentColor: "#abcdef",
          environment: [{ name: "CUSTOM_SETTING", value: "current", sensitive: false }],
          config: yield* decodeConfig({
            setupMode: "existing",
            binaryPath: "/current/codex",
            customModels: ["retained", "added"],
          }),
        });
        expect(allocations).toBe(0);
        const snapshot = yield* instance.snapshot.getSnapshot;
        const reusable = scenario === "native" || scenario === "complete" || scenario === "gateway";
        expect(allocations).toBe(reusable || scenario === "disabled" ? 0 : 1);
        if (scenario === "disabled") {
          expect(snapshot.enabled).toBe(false);
          yield* instance.snapshot.refresh;
          expect(allocations).toBe(0);
          return;
        }
        if (reusable) {
          expect(snapshot).toMatchObject({
            displayName: "Current name",
            accentColor: "#abcdef",
            enabled: true,
            supportsConversationRollback: false,
            supportedRuntimeModes: cached.supportedRuntimeModes,
            requiresNewThreadForModelChange: true,
            reportsContextWindow: true,
            showInteractionModeToggle: false,
            installed: true,
            auth: { status: "authenticated" },
          });
          if (scenario === "complete" || scenario === "gateway")
            expect(snapshot.models).toEqual(cached.models);
          else {
            expect(snapshot.models.map((model) => model.slug)).toEqual([
              "built-in",
              "retained",
              "added",
            ]);
            expect(
              snapshot.models.find((model) => model.slug === "retained")?.capabilities,
            ).toEqual(capabilities);
          }
          expect(configured).toEqual([]);
          yield* instance.snapshot.getSnapshot;
          expect(allocations).toBe(0);
        }
        const beforeRefresh = allocations;
        yield* instance.snapshot.refresh;
        expect(allocations).toBe(beforeRefresh + 1);
        expect(configured.at(-1)?.config).toMatchObject({
          binaryPath: "/current/codex",
          customModels: ["retained", "added"],
        });
        expect(configured.at(-1)?.environment).toContainEqual({
          name: "CUSTOM_SETTING",
          value: "current",
          sensitive: false,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            McpProviderSessions.layer,
            Settings.layerTest(),
            Layer.succeed(ServerConfig.ServerConfig, config),
            Layer.mock(Runtime.RuntimeClient)({
              enabled: true,
              observeWorkspace: (workspaceId) =>
                passiveRuntime
                  ? passiveRuntime.observeWorkspace(workspaceId)
                  : Effect.succeed({ kind: "stopped" }),
              forUtility: () =>
                Effect.sync(() => {
                  allocations++;
                  return client;
                }),
            }),
          ),
        ),
      );
    }),
  );
  it.effect.each(["ready", "native-error", "disabled"] as const)(
    "replaces old Antigravity gateway cache on explicit refresh: %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antigravity-cache-upgrade-" });
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(root, root)),
        );
        const instanceId = C.ProviderInstanceId.make("antigravity");
        const oldSnapshot: C.ServerProvider = {
          ...cached,
          instanceId,
          driver: C.ProviderDriverKind.make("antigravity"),
          enabled: scenario !== "disabled",
          models: [],
          modelsComplete: true,
          setup: { canAuthenticate: false },
          availability: "unavailable",
          unavailableReason: "antigravity does not support model gateway credentials.",
        };
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId,
        });
        yield* writeProviderStatusCache({ filePath, provider: oldSnapshot });
        const { unavailableReason: _oldReason, ...native } = oldSnapshot;
        const refreshed: C.ServerProvider = {
          ...native,
          availability: scenario === "native-error" ? "unavailable" : "available",
          ...(scenario === "native-error"
            ? { unavailableReason: "Native account requires sign-in." }
            : {}),
          setup: { canAuthenticate: true },
          models:
            scenario === "native-error"
              ? []
              : [{ slug: "native-model", name: "Native model", isCustom: false, capabilities }],
        };
        let allocations = 0;
        const methods: string[] = [];
        const client = createExecutionClient({
          identity: {
            workspaceId: "utility",
            allocationId: "one",
            incarnation: "one",
            podUid: "one",
            generation: 1,
            protocolVersion: 1,
          },
          endpoint: "http://worker.test",
          token: "test-token",
          fetch: async (_url, init) => {
            const request = decodeRequest(init?.body);
            methods.push(request.method);
            return Response.json({
              ok: true,
              value: request.method === "configureProvider" ? null : encodeSnapshot(refreshed),
            });
          },
        });
        yield* Effect.gen(function* () {
          const drivers = yield* makeRemoteDrivers;
          const driver = drivers.find((entry) => entry.driverKind === "antigravity");
          if (!driver) return yield* Effect.die("Missing Antigravity driver");
          const instance = yield* driver.create({
            instanceId,
            enabled: scenario !== "disabled",
            displayName: undefined,
            environment: [],
            config: driver.defaultConfig(),
          });
          const initial = yield* instance.snapshot.getSnapshot;
          expect(allocations).toBe(0);
          if (scenario === "disabled") {
            expect(initial.status).toBe("disabled");
            expect((yield* instance.snapshot.refresh).enabled).toBe(false);
            expect(allocations).toBe(0);
            expect(methods).toEqual([]);
            return;
          }
          expect(initial.unavailableReason).toBe(oldSnapshot.unavailableReason);
          const next = yield* instance.snapshot.refresh;
          expect(next).toEqual(refreshed);
          expect(next.unavailableReason).not.toBe(oldSnapshot.unavailableReason);
          expect(next.setup?.canAuthenticate).toBe(true);
          expect(yield* instance.snapshot.getSnapshot).toEqual(refreshed);
          expect(allocations).toBe(1);
          expect(methods).toEqual(["configureProvider", "provider.refresh"]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              McpProviderSessions.layer,
              Settings.layerTest(),
              Layer.succeed(ServerConfig.ServerConfig, config),
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ T3_GATEWAY_API_KEY: "gateway-test-key" }),
              ),
              Layer.mock(Runtime.RuntimeClient)({
                enabled: true,
                observeWorkspace: () => Effect.succeed({ kind: "stopped" }),
                forUtility: () =>
                  Effect.sync(() => {
                    allocations++;
                    return client;
                  }),
              }),
            ),
          ),
        );
      }),
  );
});
