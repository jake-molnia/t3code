import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeClient.LifecycleStopRequest),
);
const identity = Schema.decodeUnknownSync(ExecutionIdentity)({
  workspaceId: "utility-workspace",
  allocationId: "allocation",
  generation: 1,
  incarnation: "incarnation",
  podUid: "pod",
  protocolVersion: 1,
});
const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer, { excludeTestServices: true })("durable lifecycle submission", (it) => {
  it.effect("replays an immutable stop after CAS succeeded but POST failed before acceptance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision) VALUES ('utility-workspace','utility:catalog',10)`;
      const posts: Array<typeof RuntimeClient.LifecycleStopRequest.Type> = [];
      let fail = true;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.method === "POST") {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            posts.push(yield* decodeRequest(body).pipe(Effect.orDie));
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", { status: fail ? 503 : 200 }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              state: {
                request: { operationId: "old-ensure", revision: 10, action: "ensure_running" },
                epoch: 1,
                phase: "running",
                identity,
                endpoint: "http://worker.test",
              },
              token: "worker-token",
            }),
          );
        }),
      );
      const runtime = yield* RuntimeClient.RuntimeClient.pipe(
        Effect.provide(RuntimeClient.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { AGENT_RUNTIME_URL: "http://runtime.test", AGENT_RUNTIME_TOKEN: "test-token" },
            }),
          ),
        ),
      );
      const owner = ThreadId.make("utility:catalog");
      const options = {
        operationId: "stable-stop",
        expectedRevision: 10,
        expectedIdentity: identity,
      };
      yield* runtime.stop(owner, "suspend", options).pipe(Effect.flip);
      const rows = yield* sql<{
        revision: number;
      }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id='utility-workspace'`;
      expect(rows[0]?.revision).toBe(11);
      fail = false;
      yield* runtime.stop(owner, "suspend", { ...options, expectedRevision: 11 });
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(posts[0]);
      yield* sql`UPDATE agent_runtime_workspaces SET admission_revision=12 WHERE workspace_id='utility-workspace'`;
      yield* runtime.stop(owner, "suspend", options).pipe(Effect.flip);
      expect(posts).toHaveLength(2);
      yield* runtime.stop(owner, "suspend", { ...options, expectedRevision: 12 });
      expect(posts).toHaveLength(3);
      expect(posts[2]?.revision).toBe(13);
      expect(posts[2]?.operationId).not.toBe(posts[0]?.operationId);
    }),
  );
  it.effect("suspends again after a wake supersedes the previous stop on the same worker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      const workspaceId = "wake-workspace";
      const worker = { ...identity, workspaceId };
      const owner = ThreadId.make("utility:wake");
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision) VALUES (${workspaceId},${owner},10)`;
      const requestSchema = Schema.Struct({
        operationId: Schema.String,
        revision: Schema.Number,
        action: Schema.String,
      });
      let current = { operationId: "initial", revision: 10, action: "ensure_running" };
      const accepted: Array<typeof requestSchema.Type> = [];
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.method === "POST") {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            const next = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(requestSchema))(
              body,
            ).pipe(Effect.orDie);
            if (next.revision <= current.revision && next.operationId !== current.operationId)
              return HttpClientResponse.fromWeb(request, new Response("{}", { status: 409 }));
            current = next;
            accepted.push(next);
            return HttpClientResponse.fromWeb(request, Response.json({}));
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              state: {
                request: current,
                epoch: 1,
                phase: "running",
                identity: worker,
                endpoint: "http://worker.test",
                completedOperation:
                  current.action === "ensure_running" ? current.operationId : "initial",
              },
              token: "worker-token",
            }),
          );
        }),
      );
      const runtime = yield* RuntimeClient.RuntimeClient.pipe(
        Effect.provide(RuntimeClient.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { AGENT_RUNTIME_URL: "http://runtime.test", AGENT_RUNTIME_TOKEN: "test-token" },
            }),
          ),
        ),
      );
      const options = {
        operationId: "idle:wake-workspace:incarnation:unchanged-activity",
        expectedRevision: 10,
        expectedIdentity: worker,
      };
      yield* runtime.stop(owner, "suspend", options);
      const resumed = yield* runtime.forWorkspace(workspaceId);
      expect(resumed.identity).toEqual(worker);
      yield* runtime.stop(owner, "suspend", { ...options, expectedRevision: 12 });
      expect(accepted.map((request) => request.action)).toEqual([
        "suspend",
        "ensure_running",
        "suspend",
      ]);
      expect(accepted.map((request) => request.revision)).toEqual([11, 12, 13]);
      expect(accepted[2]?.operationId).not.toBe(accepted[0]?.operationId);
      yield* runtime.stop(owner, "suspend", { ...options, expectedRevision: 13 });
      expect(accepted[3]).toEqual(accepted[2]);
    }),
  );
});
