import { WorkspaceActivity, withWorkspaceActivity } from "./WorkspaceActivity.ts";
import * as Pools from "./ExecutionPools.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import { ThreadId, type ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { createExecutionClient, type ExecutionClient } from "../execution/ExecutionClient.ts";
import * as Bindings from "./Bindings.ts";

const RuntimeState = Schema.Struct({
  request: Schema.Struct({
    operationId: Schema.String,
    revision: Schema.Number,
    action: Schema.String,
  }),
  epoch: Schema.Number,
  phase: Schema.String,
  completedOperation: Schema.optionalKey(Schema.String),
  identity: Schema.optionalKey(ExecutionIdentity),
  endpoint: Schema.optionalKey(Schema.String),
});
const Access = Schema.Struct({ state: RuntimeState, token: Schema.optionalKey(Schema.String) });

export class RuntimeClientError extends Schema.TaggedError<RuntimeClientError>()(
  "AgentRuntimeClientError",
  {
    operation: Schema.String,
    httpStatus: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Agent runtime ${this.operation} failed.`;
  }
}

export type RuntimeObservation =
  | { readonly kind: "running"; readonly client: ExecutionClient }
  | {
      readonly kind: "stopped";
      readonly phase?: "suspended" | "released";
      readonly identity?: ExecutionIdentity | null;
    };

export const LifecycleStopRequest = Schema.Struct({
  workspaceId: Schema.String,
  operationId: Schema.String,
  revision: Schema.Number,
  action: Schema.Literals(["suspend", "release_compute"]),
  profile: Schema.String,
  expectedAllocationId: Schema.String,
  expectedGeneration: Schema.Number,
  expectedIncarnation: Schema.String,
});
export type LifecycleStopOptions = {
  operationId: string;
  expectedRevision: number;
  expectedIdentity: ExecutionIdentity;
};

export class RuntimeClient extends Context.Service<
  RuntimeClient,
  {
    readonly enabled: boolean;
    readonly observeWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<RuntimeObservation, RuntimeClientError>;
    readonly observeThread: (
      threadId: ThreadId,
    ) => Effect.Effect<RuntimeObservation, RuntimeClientError>;
    readonly sessionResidency: (
      providerSessionId: string,
    ) => Effect.Effect<ExecutionIdentity | null, RuntimeClientError>;
    readonly rememberSession: (
      providerSessionId: string,
      threadId: ThreadId,
      identity: ExecutionIdentity,
    ) => Effect.Effect<void, RuntimeClientError>;
    readonly forThread: (
      threadId: ThreadId,
      driver?: ProviderDriverKind,
    ) => Effect.Effect<ExecutionClient, RuntimeClientError>;
    readonly forWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<ExecutionClient, RuntimeClientError>;
    readonly getEventCursor: (
      identity: ExecutionIdentity,
      sessionId: string,
    ) => Effect.Effect<number, RuntimeClientError>;
    readonly forUtility: (instanceId: string) => Effect.Effect<ExecutionClient, RuntimeClientError>;
    readonly stop: (
      threadId: ThreadId,
      action: "suspend" | "release_compute",
      options: LifecycleStopOptions,
    ) => Effect.Effect<void, RuntimeClientError>;
  }
>()("t3/agentRuntime/RuntimeClient") {}

export const layer = Layer.effect(
  RuntimeClient,
  Effect.gen(function* () {
    const pools = yield* Pools.ExecutionPools;
    const sql = yield* SqlClient.SqlClient;
    const httpClient = yield* HttpClient.HttpClient;
    const enabled = pools.enabled;
    const placement = (workspaceId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            poolId: string | null;
            profile: string | null;
          }>`SELECT pool_id AS poolId, profile_id AS profile FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
          const row = rows[0];
          if (!row)
            return yield* new RuntimeClientError({
              operation: "placement",
              cause: "Unknown execution workspace",
            });
          const pool = yield* pools.get(row.poolId);
          const profile = row.profile ?? pool.profile;
          yield* sql`UPDATE agent_runtime_workspaces SET pool_id=${pool.id}, profile_id=${profile} WHERE workspace_id=${workspaceId} AND (pool_id IS NULL OR profile_id IS NULL)`;
          return { ...pool, profile };
        }),
      );
    const failure = (operation: string) => (cause: unknown) =>
      new RuntimeClientError({ operation, cause });
    const request = (pool: Pools.PoolConnection, path: string, body?: unknown) =>
      Effect.gen(function* () {
        if (!enabled)
          return yield* new RuntimeClientError({
            operation: "request",
            cause: "Remote execution is not configured",
          });
        const target = new URL(path.replace(/^\//, ""), pool.url.replace(/\/?$/, "/")).toString();
        const base = (
          body === undefined ? HttpClientRequest.get(target) : HttpClientRequest.post(target)
        ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${pool.token}`));
        const outgoing = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
        const result = yield* httpClient.execute(outgoing);
        if (result.status < 200 || result.status >= 300)
          return yield* new RuntimeClientError({
            operation: "request",
            cause: `Runtime HTTP ${result.status}`,
            httpStatus: result.status,
          });
        return yield* result.json;
      });
    const ensure = (workspaceId: string, revision: number) =>
      Effect.gen(function* () {
        const pool = yield* placement(workspaceId);
        const profile = pool.profile;
        yield* sql`UPDATE agent_runtime_workspaces SET execution_requested = 1 WHERE workspace_id = ${workspaceId} AND execution_requested = 0`;
        let admittedRevision = revision;
        let admitted = false;
        for (let attempt = 0; attempt < 4 && !admitted; attempt++) {
          admitted = yield* request(pool, "/v1/operations", {
            workspaceId,
            operationId: `ensure:${workspaceId}:${admittedRevision}`,
            revision: admittedRevision,
            action: "ensure_running",
            profile,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({
              AgentRuntimeClientError: (error) =>
                error.httpStatus === 409 ? Effect.succeed(false) : Effect.fail(error),
            }),
          );
          if (!admitted) {
            const rows = yield* sql<{ revision: number }>`UPDATE agent_runtime_workspaces
              SET admission_revision = admission_revision + 1 WHERE workspace_id = ${workspaceId}
              RETURNING admission_revision AS revision`;
            const next = rows[0];
            if (!next)
              return yield* new RuntimeClientError({
                operation: "ensure-running",
                cause: "Workspace disappeared during admission",
              });
            admittedRevision = next.revision;
          }
        }
        if (!admitted)
          return yield* new RuntimeClientError({
            operation: "ensure-running",
            cause: "Concurrent runtime admission did not settle",
          });
        const access = yield* Effect.gen(function* () {
          for (;;) {
            const current = yield* request(
              pool,
              `/v1/workspaces/${encodeURIComponent(workspaceId)}?profile=${encodeURIComponent(profile)}`,
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Access)));
            if (
              current.state.request.revision > admittedRevision &&
              current.state.request.action !== "ensure_running"
            )
              return yield* new RuntimeClientError({
                operation: "ensure-running",
                cause: "Runtime request superseded",
              });
            if (
              current.state.request.action === "ensure_running" &&
              current.state.request.revision >= admittedRevision &&
              current.state.completedOperation === current.state.request.operationId &&
              current.state.phase === "running" &&
              current.token &&
              current.state.identity &&
              current.state.endpoint
            ) {
              return {
                identity: current.state.identity,
                endpoint: current.state.endpoint,
                token: current.token,
              };
            }
            if (current.state.phase === "failed")
              return yield* new RuntimeClientError({
                operation: "ensure-running",
                cause: "Runtime allocation failed",
              });
            yield* Effect.sleep("250 millis");
          }
        }).pipe(Effect.timeout("5 minutes"));
        if (access.identity.workspaceId !== workspaceId)
          return yield* new RuntimeClientError({
            operation: "identity",
            cause: "Runtime returned another workspace",
          });
        return createExecutionClient(access);
      }).pipe(
        (effect) => withWorkspaceActivity(workspaceId, effect),
        Effect.mapError(failure("ensure-running")),
      );
    const forWorkspace = (workspaceId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          revision: number;
        }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id = ${workspaceId}`;
        const row = rows[0];
        if (!row)
          return yield* new RuntimeClientError({
            operation: "resolve-workspace",
            cause: "Unknown workspace",
          });
        return yield* ensure(workspaceId, row.revision);
      }).pipe(Effect.mapError(failure("workspace")));
    const getEventCursor = (identity: ExecutionIdentity, sessionId: string) =>
      Bindings.cursor(identity.workspaceId, identity.incarnation, sessionId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(failure("cursor")),
      );
    const forThread = (threadId: ThreadId, driver?: ProviderDriverKind) =>
      Bindings.read(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(failure("resolve-binding")),
        Effect.flatMap((binding) =>
          Effect.gen(function* () {
            if (driver !== undefined) {
              const pool = yield* placement(binding.workspaceId);
              if (pool.providerDrivers.length > 0 && !pool.providerDrivers.includes(driver))
                return yield* new RuntimeClientError({
                  operation: "provider-placement",
                  cause: "The selected pool does not support this provider",
                });
            }
            return yield* ensure(binding.workspaceId, binding.revision);
          }),
        ),
        Effect.mapError(failure("provider-placement")),
      );
    const forUtility = (instanceId: string) =>
      Effect.gen(function* () {
        const workspaceId = `t3:utility:${instanceId}`;
        const owner = `utility:${instanceId}`;
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id, owner_thread_id)
      VALUES (${workspaceId}, ${owner}) ON CONFLICT(workspace_id) DO NOTHING`;
        const rows = yield* sql<{
          revision: number;
        }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id = ${workspaceId}`;
        return yield* ensure(workspaceId, rows[0]?.revision ?? 1);
      }).pipe(Effect.mapError(failure("utility")));
    const stop = (
      threadId: ThreadId,
      action: "suspend" | "release_compute",
      options: LifecycleStopOptions,
    ) =>
      Effect.gen(function* () {
        const workspaceId = options.expectedIdentity.workspaceId;
        const activity = yield* WorkspaceActivity;
        if (activity.has(workspaceId))
          return yield* new RuntimeClientError({
            operation: "stop",
            cause: "Workspace request is in progress",
          });
        const pool = yield* placement(workspaceId);
        const profile = pool.profile;
        const current = yield* request(
          pool,
          `/v1/workspaces/${encodeURIComponent(workspaceId)}?profile=${encodeURIComponent(profile)}`,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Access)));
        if (
          current.state.phase === "released" ||
          (current.state.phase === "suspended" && action === "suspend")
        )
          return;
        if (
          !current.state.identity ||
          !sameIdentity(current.state.identity, options.expectedIdentity)
        )
          return yield* new RuntimeClientError({
            operation: "stop",
            cause: "Execution identity changed",
          });
        const payload = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              owner: string;
              revision: number;
              receipt: string | null;
            }>`SELECT owner_thread_id AS owner, admission_revision AS revision, lifecycle_request_json AS receipt FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
            const row = rows[0];
            if (!row || row.owner !== threadId)
              return yield* new RuntimeClientError({
                operation: "stop",
                cause: "Not the workspace owner",
              });
            if (row.receipt !== null) {
              const previous = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(LifecycleStopRequest),
              )(row.receipt);
              if (
                (previous.operationId === options.operationId ||
                  previous.operationId ===
                    `${options.operationId}:admission:${previous.revision}`) &&
                previous.revision === row.revision
              ) {
                if (
                  previous.action !== action ||
                  previous.expectedAllocationId !== options.expectedIdentity.allocationId ||
                  previous.expectedGeneration !== options.expectedIdentity.generation ||
                  previous.expectedIncarnation !== options.expectedIdentity.incarnation
                )
                  return yield* new RuntimeClientError({
                    operation: "stop",
                    cause: "Stale lifecycle receipt",
                  });
                return previous;
              }
            }
            if (row.revision !== options.expectedRevision)
              return yield* new RuntimeClientError({
                operation: "stop",
                cause: "Admission revision changed",
              });
            const next = {
              workspaceId,
              operationId: `${options.operationId}:admission:${row.revision + 1}`,
              revision: row.revision + 1,
              action,
              profile,
              expectedAllocationId: options.expectedIdentity.allocationId,
              expectedGeneration: options.expectedIdentity.generation,
              expectedIncarnation: options.expectedIdentity.incarnation,
            };
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LifecycleStopRequest))(
              next,
            );
            const updated =
              yield* sql`UPDATE agent_runtime_workspaces SET admission_revision=${next.revision}, lifecycle_request_json=${encoded} WHERE workspace_id=${workspaceId} AND admission_revision=${row.revision} RETURNING workspace_id`;
            if (updated.length !== 1)
              return yield* new RuntimeClientError({
                operation: "stop",
                cause: "Admission revision changed",
              });
            return next;
          }),
        );
        const latest = yield* sql<{
          revision: number;
        }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
        if (latest[0]?.revision !== payload.revision)
          return yield* new RuntimeClientError({
            operation: "stop",
            cause: "Admission changed before submission",
          });
        if (activity.has(workspaceId))
          return yield* new RuntimeClientError({
            operation: "stop",
            cause: "Workspace request is in progress",
          });
        yield* request(pool, "/v1/operations", payload);
      }).pipe(Effect.mapError(failure("stop")));
    const identityJson = Schema.fromJsonString(ExecutionIdentity);
    const sessionResidency = (providerSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          identity_json: string;
        }>`SELECT identity_json FROM agent_runtime_session_residency WHERE provider_session_id = ${providerSessionId}`;
        return rows[0]
          ? yield* Schema.decodeUnknownEffect(identityJson)(rows[0].identity_json)
          : null;
      }).pipe(Effect.mapError(failure("session-residency")));
    const rememberSession = (
      providerSessionId: string,
      threadId: ThreadId,
      identity: ExecutionIdentity,
    ) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(identityJson)(identity);
        yield* sql`INSERT INTO agent_runtime_session_residency(provider_session_id, thread_id, identity_json)
      VALUES (${providerSessionId}, ${threadId}, ${encoded}) ON CONFLICT(provider_session_id) DO UPDATE
      SET thread_id = excluded.thread_id, identity_json = excluded.identity_json`;
      }).pipe(Effect.mapError(failure("remember-session")));
    const observeWorkspace = (workspaceId: string) =>
      Effect.gen(function* () {
        const pool = yield* placement(workspaceId);
        const profile = pool.profile;
        const access = yield* request(
          pool,
          `/v1/workspaces/${encodeURIComponent(workspaceId)}?profile=${encodeURIComponent(profile)}`,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Access)));
        if (access.state.phase === "released" || access.state.phase === "suspended")
          return {
            kind: "stopped",
            phase: access.state.phase,
            identity: access.state.identity ?? null,
          } as const;
        if (
          access.state.phase !== "running" ||
          !access.state.identity ||
          !access.state.endpoint ||
          !access.token
        )
          return yield* new RuntimeClientError({
            operation: "observe",
            cause: "Worker status is not established",
          });
        if (access.state.identity.workspaceId !== workspaceId)
          return yield* new RuntimeClientError({
            operation: "observe",
            cause: "Worker identity mismatch",
          });
        return {
          kind: "running",
          client: createExecutionClient({
            identity: access.state.identity,
            endpoint: access.state.endpoint,
            token: access.token,
          }),
        } as const;
      }).pipe(Effect.mapError(failure("observe")));
    const observeThread = (threadId: ThreadId) =>
      Bindings.read(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.flatMap((binding) => observeWorkspace(binding.workspaceId)),
        Effect.mapError(failure("observe-thread")),
      );
    return RuntimeClient.of({
      enabled,
      observeWorkspace,
      observeThread,
      sessionResidency,
      rememberSession,
      forThread,
      forWorkspace,
      forUtility,
      getEventCursor,
      stop,
    });
  }),
).pipe(Layer.provideMerge(Pools.layer));
