import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import * as WorkspaceRouting from "../agentRuntime/WorkspaceRouting.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { ConfigureProvider, ProviderRequest } from "./WorkerProviders.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Settings from "../serverSettings.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";

const decodePollingRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

it.live(
  "central provider factory needs no process or filesystem services and fails closed without a sandbox",
  () =>
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
          const drivers = yield* makeRemoteDrivers;
          const driver = drivers.find((driver) => driver.driverKind === "codex");
          if (!driver) throw new Error("Codex driver missing");
          const instance = yield* driver.create({
            instanceId: ProviderInstanceId.make("codex"),
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
    const drivers = yield* makeRemoteDrivers;
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

it.live(
  "keeps configured instance environment across roots and invalidates connected Cursor copies on logout",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("cursor-account");
      const snapshot = yield* buildUnavailableProviderSnapshot({
        instanceId,
        driverKind: C.ProviderDriverKind.make("cursor"),
        reason: "test",
      });
      const encodedSnapshot = yield* Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider))(
        snapshot,
      );
      let ownerKey: unknown = {
        version: 1,
        backendUrl: "https://api.cursor.com",
        apiKey: "fake-account-key",
        createdAtMs: 100,
      };
      const copies = new Map<string, unknown>();
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
              if (request.method === "auth.executionCredentials") value = ownerKey;
              else if (request.method === "auth.importExecutionCredentials")
                copies.set(workspaceId, input.input);
              else if (request.method === "provider.snapshotForCwd") value = encodedSnapshot;
              else if (request.method === "auth.logout") {
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
        const drivers = yield* makeRemoteDrivers;
        const driver = drivers.find((driver) => driver.driverKind === "cursor");
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
        yield* instance.snapshotForCwd("first");
        yield* instance.snapshotForCwd("second");
        expect(copies.get("root-one")).toEqual(ownerKey);
        expect(copies.get("root-two")).toEqual(ownerKey);
        expect(environments.get("root-one")).toEqual(configuredEnvironment);
        expect(environments.get("root-two")).toEqual(configuredEnvironment);
        expect(environments.get("utility")).toEqual(configuredEnvironment);
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
        const drivers = yield* makeRemoteDrivers;
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
