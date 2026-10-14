import { withWorkspaceActivity } from "./WorkspaceActivity.ts";
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

const identity = Schema.decodeUnknownSync(ExecutionIdentity)({
  workspaceId: "utility-workspace",
  allocationId: "allocation",
  generation: 1,
  incarnation: "incarnation",
  podUid: "pod",
  protocolVersion: 1,
});
const services = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const desired = Schema.Struct({
  desiredState: Schema.Literals(["running", "suspended", "released"]),
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* RuntimeSchema.migrate;
  yield* sql`DELETE FROM agent_runtime_workspaces`;
  yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision) VALUES ('utility-workspace','utility:catalog',10)`;
  const requests: Array<{ version: string; desiredState: string }> = [];
  let resource: typeof RuntimeClient.WorkspaceResource.Type = {
    id: identity.workspaceId,
    pool: "local",
    profile: "t3",
    desiredState: "running",
    state: "running",
    version: "initial",
    progress: null,
    error: null,
    identity,
    execution: { identity, endpoint: "http://worker.test", token: "worker-token" },
  };
  const control = { fail: false, loseResponse: false, race: false, failAccepted: false };
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "PUT" && request.url.endsWith("/state")) {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const update = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(desired))(body).pipe(
          Effect.orDie,
        );
        const version = request.headers["if-match"] ?? "";
        requests.push({ version, desiredState: update.desiredState });
        if (control.fail)
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }));
        if (control.race) {
          resource = {
            ...resource,
            version: "newer-wake",
            desiredState: "running",
            state: "running",
          };
          control.race = false;
        }
        if (version !== `"${resource.version}"`)
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                error: { code: "version_conflict", message: "Workspace changed", retryable: true },
              },
              { status: 412 },
            ),
          );
        resource = {
          ...resource,
          desiredState: update.desiredState,
          state: control.failAccepted ? "failed" : update.desiredState,
          error: control.failAccepted
            ? { code: "worker_busy", message: "Worker is busy", retryable: true }
            : null,
          version: `version-${requests.length}`,
          execution:
            update.desiredState === "running"
              ? { identity, endpoint: "http://worker.test", token: "worker-token" }
              : null,
        };
        if (control.loseResponse) {
          control.loseResponse = false;
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }));
        }
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(resource, { headers: { etag: `"${resource.version}"` } }),
      );
    }),
  );
  const construct = () =>
    RuntimeClient.RuntimeClient.pipe(
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
  return {
    sql,
    requests,
    control,
    construct,
    replaceWorker: () => {
      const replacement = {
        ...identity,
        generation: 2,
        incarnation: "replacement",
        podUid: "replacement-pod",
      };
      resource = {
        ...resource,
        version: "replacement",
        identity: replacement,
        execution: {
          identity: replacement,
          endpoint: "http://replacement.test",
          token: "new-token",
        },
      };
      return replacement;
    },
    owner: ThreadId.make("utility:catalog"),
    options: { operationId: "stable-stop", expectedRevision: 10, expectedIdentity: identity },
  };
});

it.layer(services, { excludeTestServices: true })("durable workspace state submission", (it) => {
  it.effect("replays the persisted ETag after a failed submission and central restart", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* f.construct();
      yield* withWorkspaceActivity(
        identity.workspaceId,
        runtime.stop(f.owner, "suspend", f.options),
      ).pipe(Effect.flip);
      expect(f.requests).toHaveLength(0);
      f.control.fail = true;
      yield* runtime.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
      f.control.fail = false;
      const restarted = yield* f.construct();
      yield* restarted.stop(f.owner, "suspend", { ...f.options, expectedRevision: 11 });
      expect(f.requests).toEqual([
        { version: '"initial"', desiredState: "suspended" },
        { version: '"initial"', desiredState: "suspended" },
      ]);
      const observed = yield* restarted.observeWorkspace(identity.workspaceId);
      expect(observed.kind === "stopped" && observed.completedStop).toEqual({
        operationId: "stable-stop",
        revision: 11,
        action: "suspend",
      });
    }),
  );
  it.effect("recovers a lost acceptance response without submitting another stop", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* f.construct();
      f.control.loseResponse = true;
      yield* runtime.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
      const restarted = yield* f.construct();
      const recovered = yield* restarted.observeWorkspace(identity.workspaceId);
      expect(recovered.kind === "stopped" && recovered.completedStop?.revision).toBe(11);
      yield* restarted.stop(f.owner, "suspend", { ...f.options, expectedRevision: 11 });
      expect(f.requests).toHaveLength(1);
      const observed = yield* restarted.observeWorkspace(identity.workspaceId);
      expect(observed.kind === "stopped" && observed.completedStop?.revision).toBe(11);
    }),
  );
  it.effect("rejects stale stops after a concurrent wake and allows a new policy decision", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* f.construct();
      f.control.race = true;
      yield* runtime.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
      yield* runtime.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
      expect(f.requests.map((request) => request.version)).toEqual(['"initial"']);
      yield* runtime.forWorkspace(identity.workspaceId);
      yield* runtime.stop(f.owner, "suspend", { ...f.options, expectedRevision: 11 });
      expect(f.requests.map((request) => request.desiredState)).toEqual([
        "suspended",
        "running",
        "suspended",
      ]);
    }),
  );
  it.effect("retries an accepted stop that failed because the worker was busy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* f.construct();
      f.control.failAccepted = true;
      yield* runtime.stop(f.owner, "suspend", f.options);
      const failed = yield* runtime.observeWorkspace(identity.workspaceId).pipe(Effect.flip);
      expect(RuntimeClient.failedStop(failed)?.error.code).toBe("worker_busy");
      f.control.failAccepted = false;
      yield* runtime.stop(f.owner, "suspend", { ...f.options, expectedRevision: 11 });
      expect(f.requests).toEqual([
        { version: '"initial"', desiredState: "suspended" },
        { version: '"version-1"', desiredState: "suspended" },
      ]);
    }),
  );
  it.effect(
    "observes a replacement worker after central restart and rejects stopping its predecessor",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const runtime = yield* f.construct();
        yield* runtime.rememberSession("session", f.owner, identity);
        const replacement = f.replaceWorker();
        const restarted = yield* f.construct();
        const observed = yield* restarted.observeWorkspace(identity.workspaceId);
        expect(observed.kind === "running" && observed.client.identity).toEqual(replacement);
        expect(yield* restarted.sessionResidency("session")).toEqual(identity);
        yield* restarted.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
        expect(f.requests).toHaveLength(0);
      }),
  );
  it.effect("drops legacy command receipts without replaying them", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE agent_runtime_workspaces SET lifecycle_request_json='{"operationId":"legacy","revision":10,"action":"suspend"}',execution_requested=0`;
      yield* RuntimeSchema.migrate;
      expect(
        yield* f.sql`SELECT lifecycle_request_json,execution_requested FROM agent_runtime_workspaces`,
      ).toEqual([{ lifecycle_request_json: null, execution_requested: 1 }]);
    }),
  );
});
