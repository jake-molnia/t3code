import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cause from "effect/Cause";
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
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { harnessDefaults } from "./HarnessDefaults.ts";

const encodeProviderSnapshot = Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider));

const decodePollingRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

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
            config: driver.defaultConfig(),
          });
          expect(utilityRequests).toBe(0);
          const snapshot = yield* instance.snapshot.getSnapshot;
          expect(snapshot.availability).toBe("unavailable");
          expect(utilityRequests).toBe(1);
          yield* instance.snapshot.getSnapshot;
          yield* instance.snapshot.getSnapshot;
          expect(utilityRequests).toBe(1);
          yield* instance.snapshot.refresh;
          expect(utilityRequests).toBe(2);
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
        expect(allocations).toBe(1);
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

it.live("gateway deployment does not expose or copy native managed account controllers", () =>
  Effect.gen(function* () {
    const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
    for (const kind of ["codex", "cursor", "antigravity"]) {
      const driver = drivers.find((driver) => driver.driverKind === kind);
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
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        unavailableRuntime,
        Settings.layerTest(),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ T3_GATEWAY_API_KEY: "inference-key" })),
      ),
    ),
  ),
);

it.live.each([
  {
    resume: false,
    scenario: "retryable lifecycle failure",
    cause: { code: "lifecycle_failed", message: "private endpoint and token", retryable: true },
    message: "Sandbox startup failed before the execution worker became ready. Retry the turn.",
  },
  {
    resume: false,
    scenario: "non-retryable lifecycle failure",
    cause: { code: "lifecycle_failed", message: "private endpoint and token", retryable: false },
    message:
      "Sandbox startup failed before the execution worker became ready. Check the execution runtime.",
  },
  {
    resume: false,
    scenario: "readiness timeout",
    cause: new Cause.TimeoutError(),
    message:
      "Sandbox startup timed out waiting for the execution worker to become ready. Retry the turn.",
  },
  {
    resume: false,
    scenario: "unknown controller failure",
    cause: { code: "private", message: "private endpoint and token", retryable: true },
    message: undefined,
  },
  {
    resume: true,
    scenario: "retryable lifecycle failure observed during resume",
    cause: { code: "lifecycle_failed", message: "private endpoint and token", retryable: true },
    message: "The sandbox reports a failed lifecycle operation. Retry the turn.",
  },
  {
    resume: true,
    scenario: "non-retryable lifecycle failure observed during resume",
    cause: { code: "lifecycle_failed", message: "private endpoint and token", retryable: false },
    message: "The sandbox reports a failed lifecycle operation. Check the execution runtime.",
  },
  {
    resume: true,
    scenario: "unknown controller failure observed during resume",
    cause: { code: "private", message: "private endpoint and token", retryable: true },
    message: undefined,
  },
])("preserves safe $scenario in the provider error and progress", (testCase) =>
  Effect.gen(function* () {
    const tracker = yield* WorktreeSetupTracker.make;
    const drivers = yield* makeRemoteDrivers.pipe(
      Effect.provide(McpProviderSessions.layer),
      Effect.provideService(WorktreeSetupTracker.WorktreeSetupTracker, tracker),
    );
    const driver = drivers.find((driver) => driver.driverKind === "codex");
    if (!driver) return yield* Effect.die("Missing Codex");
    const instanceId = C.ProviderInstanceId.make("codex");
    const instance = yield* driver.create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: driver.defaultConfig(),
    });
    const threadId = C.ThreadId.make("failed-startup");
    const providerSessionId = C.ProviderSessionId.make("failed-session");
    const error = yield* instance.orchestrationAdapter
      .openSession({
        threadId,
        providerSessionId,
        ...(testCase.resume
          ? {
              resumeFromSession: {
                id: providerSessionId,
                driver: C.ProviderDriverKind.make("codex"),
                providerInstanceId: instanceId,
                status: "ready" as const,
                cwd: "/workspace/repo",
                model: "test",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
                updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
                lastError: null,
              },
            }
          : {}),
        modelSelection: { instanceId, model: "test" },
        runtimePolicy: {
          cwd: "/workspace/repo",
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      })
      .pipe(Effect.flip);
    expect(error.message).toBe(
      `codex provider protocol error: ${testCase.message ?? "Remote provider unavailable."}`,
    );
    expect((yield* tracker.get(threadId))?.error).toBe(
      testCase.message ?? "Sandbox execution could not start. Retry the turn.",
    );
    expect(error.message).not.toContain("private");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Settings.layerTest(),
        Layer.mock(Runtime.RuntimeClient)({
          enabled: true,
          observeThread: () =>
            Effect.fail(
              new Runtime.RuntimeClientError({
                operation: "observe-thread",
                cause: new Runtime.RuntimeClientError({
                  operation: "observe",
                  cause: new Runtime.RuntimeClientError({
                    operation: "observe",
                    cause: testCase.cause,
                  }),
                }),
              }),
            ),
          forThread: () =>
            testCase.resume
              ? Effect.die("Failed observations must not acquire a replacement worker")
              : Effect.fail(
                  new Runtime.RuntimeClientError({
                    operation: "ensure-running",
                    cause: new Runtime.RuntimeClientError({
                      operation: "ensure-running",
                      cause: testCase.cause,
                    }),
                  }),
                ),
        }),
      ),
    ),
  ),
);

it.live.each([
  "not-ready",
  "status-503",
  "unauthorized",
  "gateway-error",
  "gateway-unavailable",
  "worker-quiescent",
  "stale-identity",
  "worker-gone",
  "snapshot-unauthorized",
  "malformed-json",
  "malformed-envelope",
  "configure-quiescent",
  "configure-gone",
  "configure-unauthorized",
  "configure-malformed",
  "queued-stop",
  "queued-stop-receipt",
  "snapshot-stopped-401",
  "snapshot-stopping-401",
  "snapshot-suspending-401",
  "snapshot-not-ready-401",
  "snapshot-controller-401",
] as const)(
  "handles %s during passive gateway provider polling without waking a utility",
  (scenario) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("gateway-idle");
      const available: C.ServerProvider = {
        instanceId,
        driver: C.ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-17T00:00:00.000Z",
        models: [{ slug: "gateway/gpt", name: "GPT", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
        availability: "available",
      };
      const encoded = yield* encodeProviderSnapshot(available);
      const unavailable = yield* encodeProviderSnapshot({
        ...available,
        status: "error",
        availability: "unavailable",
        unavailableReason: "Gateway account revoked",
        models: [],
      });
      let stage: "ready" | "transition" | "stopped" = "ready";
      let allocations = 0;
      let snapshots = 0;
      let rejected = false;
      const makeClient = (generation: number) =>
        createExecutionClient({
          identity: {
            workspaceId: `t3:utility:${instanceId}`,
            allocationId: "allocation",
            generation,
            incarnation: `worker-${generation}`,
            podUid: "worker",
            protocolVersion: 1,
          },
          endpoint: "http://worker.test",
          token: "test-token",
          fetch: async (_url, init) => {
            const { method } = decodePollingRequest(init?.body);
            if (method === "configureProvider") {
              if (stage === "transition") {
                if (scenario === "configure-quiescent")
                  return Response.json(
                    { ok: false, code: "worker_not_admitting" },
                    { status: 409 },
                  );
                if (scenario === "configure-unauthorized")
                  return new Response(null, { status: 403 });
                if (scenario === "configure-gone" || scenario === "configure-malformed") {
                  stage = "stopped";
                  if (scenario === "configure-malformed")
                    return Response.json({ unexpected: true });
                  throw new Error("Worker connection closed");
                }
              }
              return Response.json({ ok: true, value: null });
            }
            snapshots++;
            if (stage === "transition") {
              if (scenario.startsWith("snapshot-") && scenario.endsWith("-401")) {
                rejected = true;
                if (scenario === "snapshot-stopped-401") stage = "stopped";
                return new Response(null, { status: 401 });
              }
              if (scenario === "malformed-json" || scenario === "malformed-envelope") {
                stage = "stopped";
                return scenario === "malformed-json"
                  ? new Response("private malformed JSON")
                  : Response.json({ unexpected: true });
              }
              if (scenario === "gateway-unavailable")
                return Response.json({ ok: true, value: unavailable });
              if (scenario === "worker-quiescent")
                return Response.json({ ok: false, code: "worker_quiescent" });
              if (scenario === "stale-identity")
                return Response.json({ ok: false, code: "stale_identity" });
              if (scenario === "snapshot-unauthorized") return new Response(null, { status: 401 });
              if (scenario === "worker-gone") {
                stage = "stopped";
                throw new Error("Worker connection closed");
              }
            }
            if (scenario === "gateway-error" && stage === "transition")
              throw new Error("Gateway account unavailable");
            return Response.json({ ok: true, value: encoded });
          },
        });
      const client = makeClient(1);
      const replacement = makeClient(2);
      yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
        const driver = drivers.find((entry) => entry.driverKind === "codex");
        if (!driver) throw new Error("Missing Codex");
        const instance = yield* driver.create({
          instanceId,
          displayName: undefined,
          environment: [],
          enabled: true,
          config: driver.defaultConfig(),
        });
        const initial = yield* instance.snapshot.getSnapshot;
        expect(initial.availability).toBe("available");
        stage = "transition";
        const transition = yield* instance.snapshot.getSnapshot;
        stage = "stopped";
        const stopped = yield* instance.snapshot.getSnapshot;
        if (
          scenario === "not-ready" ||
          scenario === "status-503" ||
          scenario === "worker-quiescent" ||
          scenario === "stale-identity" ||
          scenario === "worker-gone" ||
          scenario === "configure-quiescent" ||
          scenario === "configure-gone" ||
          scenario === "queued-stop" ||
          scenario === "queued-stop-receipt" ||
          scenario === "snapshot-stopped-401" ||
          scenario === "snapshot-stopping-401" ||
          scenario === "snapshot-suspending-401"
        ) {
          expect(transition).toEqual(initial);
          expect(stopped).toEqual(initial);
        } else {
          expect(transition.availability).toBe("unavailable");
          expect(stopped.availability).toBe("unavailable");
        }
        expect(allocations).toBe(1);
        expect(snapshots).toBe(
          scenario === "not-ready" ||
            scenario === "status-503" ||
            scenario === "unauthorized" ||
            scenario.startsWith("queued-stop") ||
            scenario.startsWith("configure-")
            ? 1
            : 2,
        );
        if (
          scenario === "worker-quiescent" ||
          scenario === "stale-identity" ||
          scenario === "worker-gone" ||
          scenario === "configure-quiescent" ||
          scenario === "configure-gone" ||
          scenario === "snapshot-stopped-401" ||
          scenario === "snapshot-stopping-401" ||
          scenario === "snapshot-suspending-401"
        ) {
          stage = "transition";
          const refreshed = yield* instance.snapshot.refresh;
          expect(refreshed.availability).toBe("unavailable");
          expect(allocations).toBe(2);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Settings.layerTest(),
            ConfigProvider.layer(ConfigProvider.fromUnknown({ T3_GATEWAY_API_KEY: "gateway-key" })),
            Layer.mock(Runtime.RuntimeClient)({
              enabled: true,
              forUtility: () =>
                Effect.sync(() => {
                  allocations++;
                  return stage === "transition" && scenario.startsWith("configure-")
                    ? replacement
                    : client;
                }),
              observeWorkspace: () =>
                Effect.suspend(
                  (): Effect.Effect<Runtime.RuntimeObservation, Runtime.RuntimeClientError> => {
                    if (stage === "stopped") return Effect.succeed({ kind: "stopped" as const });
                    if (stage === "transition") {
                      if (rejected && scenario === "snapshot-suspending-401")
                        return Effect.fail(
                          new Runtime.RuntimeClientError({
                            operation: "observe",
                            cause: new Runtime.WorkerNotReady({ desiredState: "suspended" }),
                          }),
                        );
                      if (
                        scenario.startsWith("queued-stop") ||
                        (rejected && scenario === "snapshot-stopping-401")
                      )
                        return Effect.fail(
                          new Runtime.RuntimeClientError({
                            operation: "observe",
                            cause:
                              scenario === "queued-stop-receipt"
                                ? new Runtime.RuntimeStopRetry({
                                    receipt: {
                                      operationId: "stop",
                                      revision: 1,
                                      action: "suspend",
                                      expectedIdentity: client.identity,
                                      version: "before",
                                      acceptedVersion: "queued",
                                    },
                                    error: null,
                                  })
                                : new Runtime.WorkerStopping(),
                          }),
                        );
                      if (
                        rejected &&
                        (scenario === "snapshot-not-ready-401" ||
                          scenario === "snapshot-controller-401")
                      )
                        return Effect.fail(
                          new Runtime.RuntimeClientError({
                            operation: "observe",
                            cause:
                              scenario === "snapshot-not-ready-401"
                                ? new Runtime.WorkerNotReady()
                                : new Runtime.RuntimeClientError({
                                    operation: "request",
                                    httpStatus: 401,
                                    cause: "Controller unauthorized",
                                  }),
                          }),
                        );
                    }
                    if (stage === "transition" && scenario.startsWith("configure-"))
                      return Effect.succeed({ kind: "running" as const, client: replacement });
                    if (
                      stage !== "transition" ||
                      !["not-ready", "status-503", "unauthorized"].includes(scenario)
                    )
                      return Effect.succeed({ kind: "running" as const, client });
                    return Effect.fail(
                      new Runtime.RuntimeClientError({
                        operation: "observe-workspace",
                        cause:
                          scenario === "not-ready"
                            ? new Runtime.WorkerNotReady()
                            : new Runtime.RuntimeClientError({
                                operation: "request",
                                httpStatus: scenario === "status-503" ? 503 : 401,
                                cause: "Controller unavailable",
                              }),
                      }),
                    );
                  },
                ),
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
