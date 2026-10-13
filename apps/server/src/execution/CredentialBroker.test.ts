import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
// @effect-diagnostics nodeBuiltinImport:off -- Tests own isolated worker HTTP servers and disk journals.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Broker from "./CredentialBroker.ts";
import { makeRemoteDrivers } from "./RemoteProviderDrivers.ts";
import { createExecutionClient, type ExecutionClient } from "./ExecutionClient.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

it.live(
  "broker wakes the current credential owner, follows replacement, and rejects revoked or mismatched scopes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "credential-broker-" });
      const id = C.ProviderInstanceId.make("codex");
      const threadId = C.ThreadId.make("root-thread");
      const clients: ExecutionClient[] = [];
      const journals: string[] = [];
      const configured: number[] = [];
      for (const generation of [1, 2]) {
        const path = `${root}/owner-${generation}.jsonl`;
        journals.push(path);
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(path)),
          (value) => Effect.promise(value.close),
        );
        const identity = {
          workspaceId: "owner",
          allocationId: `owner-${generation}`,
          generation,
          incarnation: `owner-${generation}`,
          podUid: `owner-${generation}`,
          protocolVersion: 1 as const,
        };
        const token = "worker-test-credential-broker-token-with-enough-characters";
        const worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: async (method) => {
            if (method === "configureProvider") {
              configured.push(generation);
              return null;
            }
            if (method !== "auth.executionCredentials") throw new Error("Unexpected operation");
            return {
              clientId: "test",
              accessToken: `access-generation-${generation}`,
              refreshToken: null,
              expiresAt: 9999999999999,
              earliestRefreshAt: null,
              scopes: [],
              subject: "account",
              email: null,
            };
          },
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(value.close),
        );
        clients.push(
          createExecutionClient({ endpoint: `http://127.0.0.1:${server.port}`, identity, token }),
        );
      }
      let generation = 0;
      let stopped = true;
      let resolutions = 0;
      const runtime = Layer.mock(Runtime.RuntimeClient)({
        enabled: true,
        forUtility: (instanceId) =>
          Effect.sync(() => {
            expect(instanceId).toBe(id);
            resolutions++;
            stopped = false;
            const client = clients[generation];
            if (!client) throw new Error("Missing worker");
            return client;
          }),
      });
      const provider = yield* Effect.gen(function* () {
        const drivers = yield* makeRemoteDrivers.pipe(Effect.provide(McpProviderSessions.layer));
        const driver = drivers.find((driver) => driver.driverKind === "codex");
        if (!driver) throw new Error("Missing Codex driver");
        return yield* driver.create({
          instanceId: id,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: driver.defaultConfig(),
        });
      }).pipe(Effect.provide(Layer.merge(runtime, Settings.layerTest())));
      const registry = yield* Sessions.__testing.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Environment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(C.EnvironmentId.make("environment")),
            }),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 8080),
            }),
          ),
        ),
      );
      const http = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            Broker.layer.pipe(
              Layer.provide(Layer.succeed(Sessions.McpSessionRegistry, registry)),
              Layer.provide(
                Layer.mock(Registry.ProviderInstanceRegistry)({
                  getInstance: (requested) =>
                    Effect.succeed(requested === id ? provider : undefined),
                }),
              ),
              Layer.provide(runtime),
              Layer.provide(Settings.layerTest()),
            ),
            { disableLogger: true },
          ),
        ),
        (server) => Effect.promise(server.dispose),
      );
      const call = (authorization: string, body: unknown = { threadId, instanceId: id }) =>
        Effect.tryPromise(async () => {
          const response = await http.handler(
            new Request(`http://central${Broker.PATH}`, {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          );
          if (!response.headers.has("cache-control"))
            throw new Error(
              `Unexpected broker response ${response.status}: ${await response.text()}`,
            );
          expect(response.headers.get("cache-control")).toBe("no-store");
          return { status: response.status, body: await response.json() };
        });
      const first = yield* registry.issue({ threadId, providerInstanceId: id });
      expect(stopped).toBe(true);
      expect((yield* call(first.config.authorizationHeader)).body).toHaveProperty(
        "accessToken",
        "access-generation-1",
      );
      expect(stopped).toBe(false);
      generation = 1;
      stopped = true;
      expect((yield* call(first.config.authorizationHeader)).body).toHaveProperty(
        "accessToken",
        "access-generation-2",
      );
      expect(stopped).toBe(false);
      expect(resolutions).toBe(2);
      expect(configured).toEqual([1, 2]);
      expect(
        (yield* call(first.config.authorizationHeader, { threadId, instanceId: "other" })).status,
      ).toBe(403);
      expect(
        (yield* call(first.config.authorizationHeader, {
          threadId: "other-thread",
          instanceId: id,
        })).status,
      ).toBe(403);
      yield* registry.revokeAll;
      expect((yield* call(first.config.authorizationHeader)).status).toBe(401);
      const refreshed = yield* registry.issue({ threadId, providerInstanceId: id });
      expect((yield* call(refreshed.config.authorizationHeader)).status).toBe(200);
      expect(resolutions).toBe(3);
      for (const path of journals) {
        const text = yield* fs.readFileString(path);
        expect(text).not.toContain("access-generation");
        expect(text).not.toContain("configureProvider");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
