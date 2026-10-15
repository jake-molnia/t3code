import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import * as WorkspaceRouting from "../agentRuntime/WorkspaceRouting.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { ConfigureProvider, ProviderRequest, ReviewGuideInput } from "./WorkerProviders.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Settings from "../serverSettings.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { harnessDefaults } from "./HarnessDefaults.ts";
import { hydrateCachedProvider } from "../provider/providerStatusCache.ts";
import { mergeProviderSnapshot } from "../provider/ProviderRegistry.ts";

const decodePollingRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);
const decodeCodexConfig = Schema.decodeSync(C.CodexSettings);

it.live.each([
  { name: "omitted Codex launch arguments", driver: "codex", config: { setupMode: "existing" } },
  {
    name: "explicit empty Codex launch arguments",
    driver: "codex",
    config: { setupMode: "existing", launchArgs: "" },
  },
  {
    name: "explicit Codex launch arguments",
    driver: "codex",
    config: { setupMode: "existing", launchArgs: "-c model_provider=native" },
  },
  { name: "absent Codex config", driver: "codex", config: undefined },
  {
    name: "native OpenCode overrides",
    driver: "opencode",
    config: { binaryPath: "/native/opencode", serverUrl: "" },
  },
  {
    name: "native Antigravity credentials",
    driver: "antigravity",
    config: {
      binaryPath: "/native/agy_acp_server.par",
      authMethod: "gemini-api-key",
      apiKey: "fixture-key",
    },
  },
  { name: "native Cursor binary", driver: "cursor", config: { binaryPath: "/native/cursor" } },
  { name: "native Grok binary", driver: "grok", config: { binaryPath: "/native/grok" } },
  {
    name: "native Pi launch arguments",
    driver: "pi",
    config: { binaryPath: "/native/pi", launchArgs: "" },
  },
] as const)("preserves $name through registry, transport, and worker defaults", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("transport-config-test");
      const driverKind = C.ProviderDriverKind.make(testCase.driver);
      const operatorConfig = {
        ...(testCase.driver === "codex"
          ? { setupMode: "existing", launchArgs: "-c model_provider=aperture" }
          : { binaryPath: "/operator/provider" }),
        ...(testCase.driver === "opencode" ? { serverUrl: "http://operator.invalid" } : {}),
        ...(testCase.driver === "pi" ? { launchArgs: "--operator" } : {}),
      };
      const apply = harnessDefaults(
        JSON.stringify({ [testCase.driver]: { config: operatorConfig } }),
      );
      const received: C.ProviderInstanceConfig[] = [];
      const configured: C.ProviderInstanceConfig[] = [];
      const requestSchema = Schema.fromJsonString(
        Schema.Struct({ method: Schema.String, input: Schema.Unknown }),
      );
      const capabilities = yield* Schema.encodeEffect(
        Schema.toCodecJson(C.OrchestrationV2ProviderCapabilities),
      )(CodexProviderCapabilitiesV2);
      const client = createExecutionClient({
        identity: {
          workspaceId: "utility",
          allocationId: "allocation",
          podUid: "pod",
          generation: 1,
          incarnation: "one",
          protocolVersion: 1,
        },
        endpoint: "http://worker.test",
        token: "fake-token",
        fetch: async (_url, init) => {
          const request = Schema.decodeUnknownSync(requestSchema)(init?.body);
          if (request.method === "configureProvider") {
            const payload = Schema.decodeUnknownSync(Schema.toCodecJson(ConfigureProvider))(
              request.input,
            );
            expect(payload.settings.sourceControlHosts).toEqual({});
            received.push(payload.config);
            configured.push(apply(payload.config));
            return Response.json({ ok: true, value: null });
          }
          if (request.method === "getCapabilities")
            return Response.json({ ok: true, value: capabilities });
          throw new Error(`Unexpected request: ${request.method}`);
        },
      });
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers;
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers,
          configMap: {
            [instanceId]: {
              driver: driverKind,
              enabled: true,
              ...(testCase.config === undefined ? {} : { config: testCase.config }),
            },
          },
        });
        const instance = yield* registry.getInstance(instanceId);
        if (!instance) return yield* Effect.die("Configured instance was not materialized");
        yield* instance.orchestrationAdapter.getCapabilities();
        expect(received).toHaveLength(1);
        expect(received[0]?.config).toEqual(testCase.config ?? {});
        expect(configured[0]?.config).toEqual({ ...operatorConfig, ...testCase.config });
        const driver = drivers.find((candidate) => candidate.driverKind === driverKind);
        if (!driver) return yield* Effect.die("Configured driver was not registered");
        const native = yield* Schema.decodeUnknownEffect(driver.configSchema)(
          configured[0]?.config,
        );
        expect(native).toMatchObject({ ...operatorConfig, ...testCase.config });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            McpProviderSessions.layer,
            Settings.layerTest({
              sourceControlHosts: {
                github: {
                  tokens: { "github.com": "fixture-github-token" },
                  hosts: { "github.com": { account: "alice" } },
                },
              },
            }),
            Layer.mock(Runtime.RuntimeClient)({
              enabled: true,
              forUtility: () => Effect.succeed(client),
            }),
          ),
        ),
      );
    }),
  ),
);

it.live.each(["codex", "antigravity"])(
  "%s central factory needs no local execution services and fails closed without a sandbox",
  (driverKind) =>
    Effect.gen(function* () {
      let utilityRequests = 0;
      const runtime = Layer.succeed(
        Runtime.RuntimeClient,
        Runtime.RuntimeClient.of({
          enabled: false,
          forUtility: () =>
            Effect.suspend(() => {
              utilityRequests++;
              return Effect.fail(
                new Runtime.RuntimeClientError({ operation: "disabled", cause: null }),
              );
            }),
          forThread: () =>
            Effect.fail(new Runtime.RuntimeClientError({ operation: "disabled", cause: null })),
          stop: () => Effect.void,
          forWorkspace: () =>
            Effect.fail(new Runtime.RuntimeClientError({ operation: "disabled", cause: null })),
          getEventCursor: () => Effect.succeed(0),
          observeThread: () => Effect.succeed({ kind: "stopped" }),
          observeWorkspace: () => Effect.succeed({ kind: "stopped" }),
          sessionResidency: () => Effect.succeed(null),
          rememberSession: () => Effect.void,
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
          const driver = drivers.find((driver) => driver.driverKind === driverKind);
          if (!driver) throw new Error("Codex driver missing");
          const instance = yield* driver.create({
            instanceId: ProviderInstanceId.make(driverKind),
            displayName: undefined,
            environment: [],
            enabled: true,
            config:
              driverKind === "codex"
                ? decodeCodexConfig({
                    setupMode: "existing",
                    customModels: ["configured-model"],
                  })
                : driver.defaultConfig(),
          });
          expect(utilityRequests).toBe(0);
          const snapshot = yield* instance.snapshot.getSnapshot;
          expect(snapshot.availability).not.toBe("unavailable");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.status).toBe("warning");
          expect(utilityRequests).toBe(0);
          if (driverKind === "codex") {
            expect(snapshot.models.map((model) => model.slug)).toEqual(["configured-model"]);
            const cached: C.ServerProvider = {
              ...snapshot,
              installed: true,
              status: "ready",
              models: [
                ...snapshot.models,
                {
                  slug: "cached-model",
                  name: "Cached model",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            };
            const hydrated = hydrateCachedProvider({
              cachedProvider: cached,
              fallbackProvider: snapshot,
            });
            expect(
              mergeProviderSnapshot(hydrated, snapshot).models.map((model) => model.slug),
            ).toEqual(["configured-model", "cached-model"]);
          }
          yield* instance.snapshot.getSnapshot;
          yield* instance.snapshot.getSnapshot;
          expect(utilityRequests).toBe(0);
          yield* instance.snapshot.refresh;
          expect(utilityRequests).toBe(1);
        }),
      ).pipe(Effect.provide(Layer.merge(runtime, Settings.layerTest())));
    }),
);

const unavailableRuntime = Layer.succeed(
  Runtime.RuntimeClient,
  Runtime.RuntimeClient.of({
    enabled: false,
    forUtility: () =>
      Effect.fail(new Runtime.RuntimeClientError({ operation: "disabled", cause: null })),
    forThread: () =>
      Effect.fail(new Runtime.RuntimeClientError({ operation: "disabled", cause: null })),
    forWorkspace: () =>
      Effect.fail(new Runtime.RuntimeClientError({ operation: "disabled", cause: null })),
    stop: () => Effect.void,
    getEventCursor: () => Effect.succeed(0),
    observeThread: () => Effect.succeed({ kind: "stopped" }),
    observeWorkspace: () => Effect.succeed({ kind: "stopped" }),
    sessionResidency: () => Effect.succeed(null),
    rememberSession: () => Effect.void,
  }),
);

it.live("does not expose invented central auth controllers for CLI-owned accounts", () =>
  Effect.gen(function* () {
    const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
    for (const kind of ["claudeAgent", "grok", "opencode", "pi", "muse"]) {
      const driver = drivers.find((driver) => driver.driverKind === kind);
      expect(driver).toBeDefined();
      if (!driver) throw new Error("Missing provider");
      const instance = yield* driver.create({
        instanceId: ProviderInstanceId.make(kind),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: driver.defaultConfig(),
      });
      expect(instance.auth).toBeUndefined();
      expect((yield* instance.snapshot.getSnapshot).setup?.canAuthenticate).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(unavailableRuntime, Settings.layerTest()))),
);

it.live.each(["cursor", "antigravity"])(
  "keeps %s instance credentials separate across roots and clears copies on logout",
  (driverKind) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(`${driverKind}-account`);
      const snapshot = yield* buildUnavailableProviderSnapshot({
        instanceId,
        driverKind: C.ProviderDriverKind.make(driverKind),
        reason: "test",
      });
      const encodedSnapshot = yield* Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider))(
        snapshot,
      );
      let ownerKey: unknown =
        driverKind === "antigravity"
          ? { personal: "native-oauth-fixture", business: null }
          : {
              version: 1,
              backendUrl: "https://api.cursor.com",
              apiKey: "fake-account-key",
              createdAtMs: 100,
            };
      const copies = new Map<string, unknown>();
      const reviewRequests: Array<{ workspaceId: string; input: typeof ReviewGuideInput.Type }> =
        [];
      const environments = new Map<string, C.ProviderInstanceConfig["environment"]>();
      const requestSchema = Schema.fromJsonString(
        Schema.Struct({ method: Schema.String, input: Schema.Unknown }),
      );
      const client = (workspaceId: string) =>
        createExecutionClient({
          identity: {
            workspaceId,
            allocationId: workspaceId,
            podUid: workspaceId,
            generation: 1,
            incarnation: "one",
            protocolVersion: 1,
          },
          endpoint: "http://worker.test",
          token: "fake-token",
          fetch: async (_url, init) => {
            const request = Schema.decodeUnknownSync(requestSchema)(init?.body);
            let value: unknown = null;
            if (request.method === "configureProvider") {
              const input = Schema.decodeUnknownSync(Schema.toCodecJson(ConfigureProvider))(
                request.input,
              );
              environments.set(workspaceId, input.config.environment);
            } else {
              const input = Schema.decodeUnknownSync(ProviderRequest)(request.input);
              if (request.method === "provider.refreshModels") value = null;
              else if (request.method === "provider.refresh") value = encodedSnapshot;
              else if (request.method === "auth.executionCredentials") value = ownerKey;
              else if (request.method === "auth.importExecutionCredentials")
                copies.set(workspaceId, input.input);
              else if (request.method === "provider.snapshotForCwd") value = encodedSnapshot;
              else if (request.method === "text.reviewGuide") {
                reviewRequests.push({
                  workspaceId,
                  input: Schema.decodeUnknownSync(Schema.toCodecJson(ReviewGuideInput))(
                    input.input,
                  ),
                });
                value = { stops: [] };
              } else if (request.method === "auth.logout") {
                ownerKey = null;
                value = {
                  instanceId,
                  phase: "idle",
                  flowId: null,
                  authorizationUrl: null,
                  expiresAt: null,
                  message: null,
                };
              } else throw new Error(`Unexpected test request: ${request.method}`);
            }
            return Response.json({ ok: true, value });
          },
        });
      const utility = client("utility");
      const first = client("root-one");
      const second = client("root-two");
      const configuredEnvironment = [
        { name: "CURSOR_BACKEND_URL", value: "https://example.invalid", sensitive: false },
      ];
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
        const driver = drivers.find((driver) => driver.driverKind === driverKind);
        if (!driver) throw new Error("Missing Cursor");
        const instance = yield* driver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: configuredEnvironment,
          config: driver.defaultConfig(),
        });
        if (!instance.snapshotForCwd || !instance.auth)
          throw new Error("Missing Cursor capabilities");
        if (instance.refreshModels) yield* instance.refreshModels();
        yield* instance.snapshotForCwd("first");
        yield* instance.snapshotForCwd("second");
        expect(copies.get("root-one")).toEqual(ownerKey);
        expect(copies.get("root-two")).toEqual(ownerKey);
        expect(environments.get("root-one")).toEqual(configuredEnvironment);
        expect(environments.get("root-two")).toEqual(configuredEnvironment);
        expect(environments.get("utility")).toEqual(configuredEnvironment);
        const reviewInput = {
          cwd: "first",
          number: 42,
          title: "Review",
          description: "Intent",
          baseBranch: "main",
          baseCommit: "abc",
          settledReview: "Already addressed",
          instructions: "Read only",
          stack: [{ number: 41, title: null, headSha: null, state: "open" as const }],
          modelSelection: { instanceId, model: "test-model" },
        };
        expect(yield* instance.textGeneration.generateReviewGuide(reviewInput)).toEqual({
          stops: [],
        });
        expect(reviewRequests).toEqual([{ workspaceId: "root-one", input: reviewInput }]);
        if (driverKind === "antigravity") {
          expect(instance.auth.isLogoutPrompt?.(" /logout ", false)).toBe(true);
          expect(instance.auth.isLogoutPrompt?.("/logout", true)).toBe(false);
          expect(instance.auth.isLogoutPrompt?.("Explain /logout", false)).toBe(false);
        }
        yield* instance.auth.logout(Effect.void);
        expect(ownerKey).toBeNull();
        expect(copies.get("root-one")).toBeNull();
        expect(copies.get("root-two")).toBeNull();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Runtime.RuntimeClient)({
              enabled: true,
              forUtility: () => Effect.succeed(utility),
            }),
            Layer.mock(WorkspaceRouting.WorkspaceRouting)({
              enabled: true,
              clientForCwd: (cwd) => Effect.succeed(cwd === "first" ? first : second),
            }),
            Settings.layerTest(),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.live(
  "reconfigures a replaced utility once without waking stopped utilities during polling",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("cursor-replacement");
      const snapshot = yield* buildUnavailableProviderSnapshot({
        instanceId,
        driverKind: C.ProviderDriverKind.make("cursor"),
        reason: "test",
      });
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider))(snapshot);
      const calls: string[] = [];
      const client = (incarnation: string) => {
        let configured = false;
        return createExecutionClient({
          identity: {
            workspaceId: `t3:utility:${instanceId}`,
            allocationId: "allocation",
            generation: 1,
            incarnation,
            podUid: incarnation,
            protocolVersion: 1,
          },
          endpoint: "http://worker.test",
          token: "test-token",
          fetch: async (_url, init) => {
            const { method } = decodePollingRequest(init?.body);
            calls.push(`${incarnation}:${method}`);
            if (method === "configureProvider") configured = true;
            else if (method !== "provider.snapshot" || !configured)
              throw new Error("Provider must be configured before snapshot");
            return Response.json({
              ok: true,
              value: method === "configureProvider" ? null : encoded,
            });
          },
        });
      };
      const first = client("first");
      const replacement = client("replacement");
      let active = first;
      let stopped = false;
      let allocations = 0;
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
        const driver = drivers.find((entry) => entry.driverKind === "cursor");
        if (!driver) throw new Error("Missing Cursor");
        const instance = yield* driver.create({
          instanceId,
          displayName: undefined,
          environment: [],
          enabled: true,
          config: driver.defaultConfig(),
        });
        yield* instance.snapshot.getSnapshot;
        yield* instance.snapshot.getSnapshot;
        active = replacement;
        yield* instance.snapshot.getSnapshot;
        yield* instance.snapshot.getSnapshot;
        stopped = true;
        yield* instance.snapshot.getSnapshot;
        expect(allocations).toBe(0);
        expect(calls).toEqual([
          "first:configureProvider",
          "first:provider.snapshot",
          "first:provider.snapshot",
          "replacement:configureProvider",
          "replacement:provider.snapshot",
          "replacement:provider.snapshot",
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Settings.layerTest(),
            Layer.mock(Runtime.RuntimeClient)({
              enabled: true,
              forUtility: () =>
                Effect.sync(() => {
                  allocations++;
                  return active;
                }),
              observeWorkspace: () =>
                Effect.sync(() =>
                  stopped
                    ? { kind: "stopped" as const, phase: "suspended" as const }
                    : { kind: "running" as const, client: active },
                ),
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.live.each([
  "live",
  "stopped",
  "replaced",
  "pending-live",
  "pending-replaced",
  "pending-status",
  "pending-nested-status",
  "unauthorized",
  "profile-error",
  "identity-mismatch",
] as const)("reattaches only to a surviving worker session (%s)", (state) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let acquisitions = 0;
    const identity = {
      workspaceId: "thread-workspace",
      allocationId: "one",
      podUid: "pod",
      generation: 1,
      incarnation: "current",
      protocolVersion: 1 as const,
    };
    const client = createExecutionClient({
      identity,
      endpoint: "http://worker.test",
      token: "test-token",
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1/identity"))
          return Response.json(
            state === "identity-mismatch" ? { ...identity, incarnation: "unexpected" } : identity,
          );
        const { method } = decodePollingRequest(init?.body);
        calls.push(method);
        return method === "configureProvider"
          ? Response.json({ ok: true, value: null })
          : Response.json({ ok: false, code: "test_open_boundary" });
      },
    });
    yield* Effect.gen(function* () {
      const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
      const driver = drivers.find((entry) => entry.driverKind === "grok");
      if (!driver) throw new Error("Missing Grok");
      const instanceId = C.ProviderInstanceId.make("grok");
      const instance = yield* driver.create({
        instanceId,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: driver.defaultConfig(),
      });
      const providerSessionId = C.ProviderSessionId.make("resume-session");
      yield* instance.orchestrationAdapter
        .openSession({
          threadId: C.ThreadId.make("root"),
          providerSessionId,
          modelSelection: { instanceId, model: "test" },
          runtimePolicy: {
            cwd: "/workspace/repo",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          resumeFromSession: {
            id: providerSessionId,
            driver: C.ProviderDriverKind.make("grok"),
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/workspace/repo",
            model: "test",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            lastError: null,
          },
        })
        .pipe(Effect.flip);
      if (state === "unauthorized" || state === "profile-error" || state === "identity-mismatch") {
        expect(calls).toEqual([]);
        expect(acquisitions).toBe(0);
      } else {
        expect(calls.at(-1)).toBe(
          state === "live" ||
            state === "pending-live" ||
            state === "pending-status" ||
            state === "pending-nested-status"
            ? "attachSession"
            : "openSession",
        );
        expect(acquisitions).toBe(state.startsWith("pending") || state === "stopped" ? 1 : 0);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Settings.layerTest(),
          Layer.mock(Runtime.RuntimeClient)({
            enabled: true,
            forUtility: () => Effect.succeed(client),
            forThread: () =>
              Effect.sync(() => {
                acquisitions++;
                return client;
              }),
            observeThread: () =>
              state.startsWith("pending") || state === "unauthorized" || state === "profile-error"
                ? Effect.fail(
                    new Runtime.RuntimeClientError({
                      operation: "observe-thread",
                      cause:
                        state === "pending-nested-status"
                          ? new Runtime.RuntimeClientError({
                              operation: "observe",
                              cause: new Runtime.RuntimeClientError({
                                operation: "observe",
                                cause: new Runtime.WorkerNotReady({}),
                              }),
                            })
                          : state === "pending-status"
                            ? new Runtime.WorkerNotReady({})
                            : new Runtime.RuntimeClientError({
                                operation: "request",
                                httpStatus:
                                  state === "unauthorized"
                                    ? 401
                                    : state === "profile-error"
                                      ? 409
                                      : 503,
                                cause: "controller rejected observation",
                              }),
                    }),
                  )
                : Effect.succeed(
                    state === "stopped"
                      ? { kind: "stopped" as const }
                      : { kind: "running" as const, client },
                  ),
            sessionResidency: () =>
              Effect.succeed(
                state === "replaced" || state === "pending-replaced"
                  ? { ...identity, incarnation: "previous" }
                  : identity,
              ),
            rememberSession: () => Effect.void,
          }),
        ),
      ),
    );
  }),
);
