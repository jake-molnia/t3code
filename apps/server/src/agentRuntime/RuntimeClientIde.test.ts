import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as SandboxIde from "./SandboxIde.ts";
import { acquireWorkspaceActivity, WorkspaceActivity } from "./WorkspaceActivity.ts";

it.effect("cancels a hung origin HTTP request and releases the IDE bootstrap activity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* RuntimeSchema.migrate;
    yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('workspace','thread')`;
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(cancelled, undefined)),
      ),
    );
    const runtime = yield* RuntimeClient.RuntimeClient.pipe(
      Effect.provide(RuntimeClient.layer),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const client = createExecutionClient({
      identity: {
        workspaceId: "workspace",
        allocationId: "1",
        generation: 1,
        incarnation: "one",
        podUid: "pod",
        protocolVersion: 1,
      },
      endpoint: "http://worker:8083",
      token: "worker-token",
    });
    const service = RuntimeClient.RuntimeClient.of({
      ...runtime,
      forThread: (_id, _driver, scope) =>
        Effect.gen(function* () {
          if (scope)
            yield* acquireWorkspaceActivity("workspace").pipe(
              Effect.provideService(Scope.Scope, scope),
            );
          return client;
        }),
    });
    const context = yield* Layer.build(
      SandboxIde.layer.pipe(
        Layer.provide(Layer.succeed(RuntimeClient.RuntimeClient, service)),
        Layer.provide(NodeCrypto.layer),
      ),
    );
    const ide = Context.get(context, SandboxIde.SandboxIde);
    const pending = yield* ide
      .open({ threadId: ThreadId.make("thread"), cwd: "/workspace/repo" })
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* WorkspaceActivity).has("workspace")).toBe(true);
    yield* TestClock.adjust("3 minutes");
    expect((yield* Fiber.join(pending))._tag).toBe("Failure");
    yield* Deferred.await(cancelled);
    expect((yield* WorkspaceActivity).has("workspace")).toBe(false);
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        AGENT_RUNTIME_URL: "http://runtime",
        AGENT_RUNTIME_TOKEN: "runtime-control-token",
        T3CODE_SANDBOX_IDE_DOMAIN: "example.ts.net",
      }),
    ),
  ),
);
