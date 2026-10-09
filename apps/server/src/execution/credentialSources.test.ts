import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as FileSystem from "effect/FileSystem";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { listenWorker } from "./WorkerHttpServer.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Cursor from "../provider/CursorCredentialStore.ts";
import * as Credentials from "./credentialSources.ts";

it.effect(
  "shares a Cursor SDK login between isolated secret stores and propagates logout without touching another account",
  () =>
    Effect.gen(function* () {
      const ownerConfig = yield* Layer.build(
        ServerConfig.layerTest(process.cwd(), { prefix: "credential-owner-" }),
      );
      const ownerSecrets = yield* SecretStore.make.pipe(Effect.provide(ownerConfig));
      const rootConfig = yield* Layer.build(
        ServerConfig.layerTest(process.cwd(), { prefix: "credential-root-" }),
      );
      const rootSecrets = yield* SecretStore.make.pipe(Effect.provide(rootConfig));
      const id = C.ProviderInstanceId.make("cursor-personal");
      const owner = yield* Cursor.makeCursorCredentialStore(id).pipe(
        Effect.provideService(SecretStore.ServerSecretStore, ownerSecrets),
      );
      const root = yield* Cursor.makeCursorCredentialStore(id).pipe(
        Effect.provideService(SecretStore.ServerSecretStore, rootSecrets),
      );
      const other = yield* Cursor.makeCursorCredentialStore(
        C.ProviderInstanceId.make("cursor-work"),
      ).pipe(Effect.provideService(SecretStore.ServerSecretStore, rootSecrets));
      const value = {
        version: 1 as const,
        backendUrl: "https://api.cursor.com",
        apiKey: "fake-key",
        createdAtMs: 100,
        apiKeyExpiresAtMs: 999999,
      };
      yield* Effect.tryPromise(() => owner.store.save(value));
      yield* Effect.tryPromise(() => other.store.save({ ...value, apiKey: "other-fake-key" }));
      assert.isUndefined(yield* Effect.tryPromise(() => root.store.load()));
      const exported = yield* Effect.tryPromise(() => owner.store.load());
      const decoded = yield* Schema.decodeUnknownEffect(Cursor.ExecutionCredentials)(
        JSON.parse(JSON.stringify(exported)),
      );
      yield* Effect.tryPromise(() => root.store.save(decoded));
      assert.deepStrictEqual(yield* Effect.tryPromise(() => root.store.load()), value);
      assert.strictEqual(root.binding.key, owner.binding.key);
      yield* Effect.tryPromise(() => owner.store.clear());
      if (!(yield* Effect.tryPromise(() => owner.store.load())))
        yield* Effect.tryPromise(() => root.store.clear());
      assert.isUndefined(yield* Effect.tryPromise(() => root.store.load()));
      assert.strictEqual(
        (yield* Effect.tryPromise(() => other.store.load()))?.apiKey,
        "other-fake-key",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps Codex owner refresh behavior dynamic and refuses refresh tokens in the execution schema",
  () =>
    Effect.gen(function* () {
      const sources = yield* Credentials.CredentialSources;
      const id = C.ProviderInstanceId.make("codex-personal");
      let accessCount = 0;
      const access = Effect.sync(() => ({
        clientId: "client",
        accessToken: `fake-${++accessCount}`,
        refreshToken: null,
        expiresAt: 999999,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "subject",
        email: null,
      }));
      sources.register(id, access);
      assert.isTrue(Option.isNone(sources.access(id)));
      const exported = Option.getOrThrow(sources.export(id));
      assert.strictEqual((yield* exported).accessToken, "fake-1");
      assert.strictEqual((yield* exported).accessToken, "fake-2");
      assert.isFalse(
        Schema.is(Credentials.CodexAccess)({
          ...(yield* exported),
          refreshToken: "must-stay-with-owner",
        }),
      );
      assert.isTrue(Option.isNone(sources.export(C.ProviderInstanceId.make("different"))));
    }).pipe(Effect.provide(Credentials.layer)),
);

it.live(
  "root workers fetch current Codex access over authenticated HTTP without journaling tokens",
  () =>
    Effect.gen(function* () {
      const sources = yield* Credentials.CredentialSources;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const journalPath = `${directory}/worker.jsonl`;
      const journal = yield* Effect.acquireRelease(
        Effect.tryPromise(() => openWorkerJournal(journalPath)),
        (value) => Effect.promise(value.close),
      );
      const identity = {
        allocationId: "owner",
        podUid: "owner-pod",
        workspaceId: "owner-workspace",
        generation: 1,
        incarnation: "one",
        protocolVersion: 1 as const,
      };
      const token = "fake-worker-authentication-token-for-test";
      let accessToken = "fake-access-one";
      const worker = createExecutionWorker({
        identity,
        token,
        journal,
        execute: async (method) => {
          assert.strictEqual(method, "auth.executionCredentials");
          return {
            clientId: "client",
            accessToken,
            refreshToken: null,
            expiresAt: 999999,
            earliestRefreshAt: null,
            scopes: ["chatgpt.tokens.use.direct"],
            subject: "subject",
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
      const source = { endpoint: `http://127.0.0.1:${server.port}`, identity, token };
      const rootA = C.ProviderInstanceId.make("root-a");
      const rootB = C.ProviderInstanceId.make("root-b");
      sources.configure(rootA, source);
      sources.configure(rootB, source);
      assert.strictEqual(
        (yield* Option.getOrThrow(sources.access(rootA))).accessToken,
        "fake-access-one",
      );
      accessToken = "fake-access-two";
      assert.strictEqual(
        (yield* Option.getOrThrow(sources.access(rootB))).accessToken,
        "fake-access-two",
      );
      assert.strictEqual(
        (yield* Option.getOrThrow(sources.access(rootA))).accessToken,
        "fake-access-two",
      );
      sources.configure(rootA, { ...source, token: "incorrect" });
      assert.isTrue(
        Option.isNone(yield* Option.getOrThrow(sources.access(rootA)).pipe(Effect.option)),
      );
      sources.configure(rootA, { ...source, identity: { ...identity, incarnation: "stale" } });
      assert.isTrue(
        Option.isNone(yield* Option.getOrThrow(sources.access(rootA)).pipe(Effect.option)),
      );
      sources.configureBroker(rootA, () => undefined);
      const closedSessionAccess = Option.getOrThrow(sources.access(rootA));
      sources.configure(rootA, source);
      assert.strictEqual(
        (yield* Option.getOrThrow(sources.access(rootA))).accessToken,
        "fake-access-two",
      );
      assert.isTrue(Option.isNone(yield* closedSessionAccess.pipe(Effect.option)));
      const persisted = yield* fs.readFileString(journalPath);
      assert.isFalse(persisted.includes("fake-access"));
      assert.isFalse(persisted.includes(token));
    }).pipe(
      Effect.scoped,
      Effect.provide(Credentials.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.live(
  "an existing root access effect follows the current central MCP bearer and stops after session removal",
  () =>
    Effect.gen(function* () {
      const sources = yield* Credentials.CredentialSources;
      const id = C.ProviderInstanceId.make("managed-codex");
      let expectedBearer = "Bearer first-central-session";
      let accessToken = "first-access";
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          listenWorker({
            host: "127.0.0.1",
            port: 0,
            handle: async (request) => {
              assert.strictEqual(
                new URL(request.url).pathname,
                "/internal/execution/provider-access",
              );
              if (request.headers.get("authorization") !== expectedBearer)
                return new Response(null, { status: 401 });
              assert.deepStrictEqual(await request.json(), {
                threadId: "root-thread",
                instanceId: id,
              });
              return Response.json({
                clientId: "client",
                accessToken,
                refreshToken: null,
                expiresAt: 999999,
                earliestRefreshAt: null,
                scopes: ["chatgpt.tokens.use.direct"],
                subject: "subject",
                email: null,
              });
            },
          }),
        ),
        (server) => Effect.promise(server.close),
      );
      let current: McpProviderSessionConfig | undefined = {
        endpoint: `http://127.0.0.1:${server.port}/mcp`,
        authorizationHeader: expectedBearer,
        threadId: C.ThreadId.make("root-thread"),
        providerSessionId: "session",
        providerInstanceId: id,
        environmentId: C.EnvironmentId.make("environment"),
        browserToolsAvailable: false,
      };
      sources.configureBroker(id, () => current);
      const access = Option.getOrThrow(sources.access(id));
      assert.strictEqual((yield* access).accessToken, "first-access");
      expectedBearer = "Bearer replacement-central-session";
      accessToken = "refreshed-access";
      assert.isTrue(Option.isNone(yield* access.pipe(Effect.option)));
      current = { ...current, authorizationHeader: expectedBearer };
      assert.strictEqual((yield* access).accessToken, "refreshed-access");
      current = undefined;
      assert.isTrue(Option.isNone(yield* access.pipe(Effect.option)));
    }).pipe(Effect.scoped, Effect.provide(Credentials.layer)),
);
