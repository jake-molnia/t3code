import {
  WorkspaceActivity,
  acquireWorkspaceActivity,
  withWorkspaceActivity,
} from "./WorkspaceActivity.ts";
import * as Pools from "./ExecutionPools.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import { ThreadId, type ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { createExecutionClient, type ExecutionClient } from "../execution/ExecutionClient.ts";
import * as Bindings from "./Bindings.ts";

class ReadinessKey extends Data.Class<{
  readonly workspaceId: string;
  readonly revision: number;
}> {}

const RuntimeFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export const WorkspaceResource = Schema.Struct({
  id: Schema.String,
  pool: Schema.String,
  profile: Schema.String,
  desiredState: Schema.Literals(["running", "suspended", "released"]),
  state: Schema.Literals([
    "running",
    "suspended",
    "released",
    "starting",
    "suspending",
    "releasing",
    "failed",
    "unavailable",
  ]),
  version: Schema.NonEmptyString,
  progress: Schema.NullOr(Schema.Struct({ step: Schema.String, startedAt: Schema.String })),
  error: Schema.NullOr(RuntimeFailure),
  identity: Schema.NullOr(ExecutionIdentity),
  execution: Schema.NullOr(
    Schema.Struct({ identity: ExecutionIdentity, endpoint: Schema.String, token: Schema.String }),
  ),
});

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

export class WorkerNotReady extends Schema.TaggedError<WorkerNotReady>()(
  "AgentRuntimeWorkerNotReady",
  {},
) {}

const isRuntimeClientError = Schema.is(RuntimeClientError);
const isWorkerNotReady = Schema.is(WorkerNotReady);

/** Only controller readiness failures permit acquisition after an observation. */
export function isWorkerObservationPending(error: RuntimeClientError): boolean {
  let cause: unknown = error;
  while (isRuntimeClientError(cause)) {
    if (cause.operation === "request" && cause.httpStatus === 503) return true;
    cause = cause.cause;
  }
  return isWorkerNotReady(cause);
}

export type CompletedStop = Pick<
  typeof LifecycleStopReceipt.Type,
  "operationId" | "revision" | "action"
>;

export type RuntimeObservation =
  | { readonly kind: "running"; readonly client: ExecutionClient }
  | {
      readonly kind: "stopped";
      readonly phase?: "suspended" | "released";
      readonly identity?: ExecutionIdentity | null;
      readonly completedStop?: CompletedStop;
    };

/** Local policy receipt. Only desiredState and the opaque version cross the runtime boundary. */
const SubmittedStopReceipt = Schema.Struct({
  operationId: Schema.String,
  revision: Schema.Number,
  action: Schema.Literals(["suspend", "release_compute"]),
  expectedIdentity: ExecutionIdentity,
  version: Schema.String,
  acceptedVersion: Schema.NullOr(Schema.String),
});
const LegacyStopReceipt = Schema.Struct({
  legacy: Schema.Literal(true),
  operationId: Schema.String,
  revision: Schema.Number,
  action: Schema.Literals(["suspend", "release_compute"]),
});
export const LifecycleStopReceipt = Schema.Union([SubmittedStopReceipt, LegacyStopReceipt]);
const decodeStopReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(LifecycleStopReceipt));
const encodeStopReceipt = Schema.encodeEffect(Schema.fromJsonString(LifecycleStopReceipt));
const decodeWorkspace = Schema.decodeUnknownEffect(WorkspaceResource);
const decodeRuntimeFailure = Schema.decodeUnknownEffect(Schema.Struct({ error: RuntimeFailure }));

export class RuntimeStopRetry extends Schema.TaggedError<RuntimeStopRetry>()(
  "AgentRuntimeStopRetry",
  {
    receipt: SubmittedStopReceipt,
    error: Schema.NullOr(RuntimeFailure),
  },
) {}
const isRuntimeStopRetry = Schema.is(RuntimeStopRetry);
export function retryableStop(error: RuntimeClientError): RuntimeStopRetry | null {
  let cause: unknown = error;
  while (isRuntimeClientError(cause)) cause = cause.cause;
  return isRuntimeStopRetry(cause) ? cause : null;
}

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
      activityScope?: Scope.Scope,
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
    const pathFor = (workspaceId: string) => `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    const request = (pool: Pools.PoolConnection, path: string, body?: unknown, version?: string) =>
      Effect.gen(function* () {
        if (!enabled)
          return yield* new RuntimeClientError({
            operation: "request",
            cause: "Remote execution is not configured",
          });
        const target = new URL(path.replace(/^\//, ""), pool.url.replace(/\/?$/, "/")).toString();
        let base = (
          body === undefined ? HttpClientRequest.get(target) : HttpClientRequest.put(target)
        ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${pool.token}`));
        if (version !== undefined)
          base = base.pipe(HttpClientRequest.setHeader("if-match", `"${version}"`));
        const outgoing = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
        const result = yield* httpClient.execute(outgoing);
        if (result.status < 200 || result.status >= 300) {
          const detail = yield* result.json.pipe(
            Effect.flatMap(decodeRuntimeFailure),
            Effect.map((body) => body.error),
            Effect.catch(() => Effect.succeed(null)),
          );
          return yield* new RuntimeClientError({
            operation: "request",
            cause: detail ?? `Runtime HTTP ${result.status}`,
            httpStatus: result.status,
          });
        }
        const resource = yield* result.json.pipe(Effect.flatMap(decodeWorkspace));
        if (result.headers.etag !== `"${resource.version}"`)
          return yield* new RuntimeClientError({
            operation: "request",
            cause: "Runtime resource ETag mismatch",
          });
        return resource;
      });
    const readWorkspace = (pool: Pools.PoolConnection, workspaceId: string) =>
      request(pool, pathFor(workspaceId)).pipe(
        Effect.flatMap((resource) =>
          resource.id === workspaceId &&
          resource.pool === pool.id &&
          resource.profile === pool.profile
            ? Effect.succeed(resource)
            : Effect.fail(
                new RuntimeClientError({
                  operation: "identity",
                  cause: "Runtime workspace binding mismatch",
                }),
              ),
        ),
      );
    const ensureUncached = (workspaceId: string, revision: number) =>
      Effect.gen(function* () {
        const pool = yield* placement(workspaceId);
        const admitted = yield* sql<{ revision: number }>`UPDATE agent_runtime_workspaces
          SET admission_revision=admission_revision+CASE WHEN lifecycle_request_json IS NULL THEN 0 ELSE 1 END, execution_requested=1, lifecycle_request_json=NULL
          WHERE workspace_id=${workspaceId} AND admission_revision=${revision}
          RETURNING admission_revision AS revision`;
        const admittedRevision = admitted[0]?.revision;
        if (admittedRevision === undefined)
          return yield* new RuntimeClientError({
            operation: "ensure-running",
            cause: "Local admission superseded",
          });
        yield* request(pool, pathFor(workspaceId), { pool: pool.id, profile: pool.profile });
        let accepted = false;
        for (let attempt = 0; attempt < 4 && !accepted; attempt++) {
          const current = yield* readWorkspace(pool, workspaceId);
          accepted = yield* request(
            pool,
            `${pathFor(workspaceId)}/state`,
            { desiredState: "running" },
            current.version,
          ).pipe(
            Effect.as(true),
            Effect.catchTags({
              AgentRuntimeClientError: (error) =>
                error.httpStatus === 412 ? Effect.succeed(false) : Effect.fail(error),
            }),
          );
        }
        if (!accepted)
          return yield* new RuntimeClientError({
            operation: "ensure-running",
            cause: "Concurrent runtime admission did not settle",
          });
        const access = yield* Effect.gen(function* () {
          for (;;) {
            const current = yield* readWorkspace(pool, workspaceId).pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "AgentRuntimeClientError" && error.httpStatus === 503,
                schedule: Schedule.spaced("250 millis"),
              }),
            );
            if (current.desiredState !== "running")
              return yield* new RuntimeClientError({
                operation: "ensure-running",
                cause: "Runtime request superseded",
              });
            if (current.state === "running" && current.execution) return current.execution;
            if (current.state === "failed")
              return yield* new RuntimeClientError({
                operation: "ensure-running",
                cause: current.error ?? "Runtime allocation failed",
              });
            yield* Effect.sleep("250 millis");
          }
        }).pipe(Effect.timeout("5 minutes"));
        if (access.identity.workspaceId !== workspaceId)
          return yield* new RuntimeClientError({
            operation: "identity",
            cause: "Runtime returned another workspace",
          });
        yield* sql`UPDATE agent_runtime_workspaces SET execution_requested=1 WHERE workspace_id=${workspaceId} AND admission_revision=${admittedRevision}`;
        return createExecutionClient(access);
      }).pipe(
        (effect) => withWorkspaceActivity(workspaceId, effect),
        Effect.mapError(failure("ensure-running")),
      );
    // Concurrent Git, file, and provider operations share readiness, not their results.
    // A newer admission revision must never join an older wake or stop transition.
    const readiness = yield* Cache.makeWith(
      (input: ReadinessKey) => ensureUncached(input.workspaceId, input.revision),
      { capacity: 256, timeToLive: () => 0, requireServicesAt: "lookup" },
    );
    const ensure = (workspaceId: string, revision: number) =>
      Cache.get(readiness, new ReadinessKey({ workspaceId, revision }));
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
    const forThread = (
      threadId: ThreadId,
      driver?: ProviderDriverKind,
      activityScope?: Scope.Scope,
    ) =>
      Bindings.read(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(failure("resolve-binding")),
        Effect.flatMap((binding) =>
          Effect.gen(function* () {
            if (activityScope)
              yield* acquireWorkspaceActivity(binding.workspaceId).pipe(
                Effect.provideService(Scope.Scope, activityScope),
              );
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
        const current = yield* readWorkspace(pool, workspaceId);
        const desiredState = action === "suspend" ? "suspended" : "released";
        const receipt = yield* sql.withTransaction(
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
              const previous = yield* decodeStopReceipt(row.receipt);
              if (
                "version" in previous &&
                previous.operationId === options.operationId &&
                previous.revision === row.revision &&
                previous.action === action &&
                sameIdentity(previous.expectedIdentity, options.expectedIdentity)
              )
                return previous;
            }
            if (row.revision !== options.expectedRevision)
              return yield* new RuntimeClientError({
                operation: "stop",
                cause: "Admission revision changed",
              });
            if (!current.identity || !sameIdentity(current.identity, options.expectedIdentity))
              return yield* new RuntimeClientError({
                operation: "stop",
                cause: "Execution identity changed",
              });
            const next = {
              operationId: options.operationId,
              revision: row.revision + 1,
              action,
              expectedIdentity: options.expectedIdentity,
              version: current.version,
              acceptedVersion: null,
            };
            const encoded = yield* encodeStopReceipt(next);
            yield* sql`UPDATE agent_runtime_workspaces SET admission_revision=${next.revision}, lifecycle_request_json=${encoded}, execution_requested=1 WHERE workspace_id=${workspaceId}`;
            return next;
          }),
        );
        if (
          receipt.acceptedVersion !== null &&
          current.version === receipt.acceptedVersion &&
          current.desiredState === desiredState &&
          current.state !== "failed" &&
          current.progress?.step !== "queued"
        )
          return;
        const latest = yield* sql<{
          revision: number;
        }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
        if (latest[0]?.revision !== receipt.revision || activity.has(workspaceId))
          return yield* new RuntimeClientError({
            operation: "stop",
            cause: "Admission changed before submission",
          });
        // A lost response may have accepted this intent. Observing the same stopped
        // identity is sufficient; a running resource must pass the original ETag.
        const accepted =
          current.desiredState === desiredState &&
          current.state !== "failed" &&
          current.progress?.step !== "queued" &&
          ((current.identity === null && current.state === "released") ||
            (current.identity !== null && sameIdentity(current.identity, receipt.expectedIdentity)))
            ? current
            : yield* request(
                pool,
                `${pathFor(workspaceId)}/state`,
                { desiredState },
                (current.state === "failed" || current.progress?.step === "queued") &&
                  current.desiredState === desiredState &&
                  current.identity !== null &&
                  sameIdentity(current.identity, receipt.expectedIdentity) &&
                  (receipt.acceptedVersion === null || receipt.acceptedVersion === current.version)
                  ? current.version
                  : (receipt.acceptedVersion ?? receipt.version),
              ).pipe(
                Effect.catchTags({
                  AgentRuntimeClientError: (error) =>
                    Effect.gen(function* () {
                      if (error.httpStatus === 412)
                        yield* sql`UPDATE agent_runtime_workspaces SET lifecycle_request_json=NULL WHERE workspace_id=${workspaceId} AND admission_revision=${receipt.revision}`;
                      return yield* error;
                    }),
                }),
              );
        const encoded = yield* encodeStopReceipt({
          ...receipt,
          acceptedVersion: accepted.version,
        });
        yield* sql`UPDATE agent_runtime_workspaces SET lifecycle_request_json=${encoded} WHERE workspace_id=${workspaceId} AND admission_revision=${receipt.revision}`;
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
        const rows = yield* sql<{
          receipt: string | null;
          revision: number;
        }>`SELECT lifecycle_request_json AS receipt, admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${workspaceId}`;
        const row = rows[0];
        const receipt = row?.receipt ? yield* decodeStopReceipt(row.receipt) : null;
        const access = yield* readWorkspace(pool, workspaceId);
        if (
          (access.state === "released" || access.state === "suspended") &&
          access.desiredState === access.state
        ) {
          const action = access.state === "released" ? "release_compute" : "suspend";
          return {
            kind: "stopped",
            phase: access.state,
            identity: access.identity,
            ...(receipt !== null &&
            receipt.action === action &&
            row?.revision === receipt.revision &&
            access.desiredState === access.state &&
            ("legacy" in receipt ||
              receipt.acceptedVersion === access.version ||
              (receipt.acceptedVersion === null &&
                access.version !== receipt.version &&
                (access.state === "released" ||
                  (access.identity !== null &&
                    sameIdentity(access.identity, receipt.expectedIdentity)))))
              ? {
                  completedStop: {
                    operationId: receipt.operationId,
                    revision: receipt.revision,
                    action,
                  } satisfies CompletedStop,
                }
              : {}),
          } as const;
        }
        if (
          (access.progress?.step === "queued" ||
            (access.state === "failed" && access.error?.retryable)) &&
          access.desiredState !== "running" &&
          access.identity
        ) {
          if (
            receipt &&
            "version" in receipt &&
            row?.revision === receipt.revision &&
            sameIdentity(receipt.expectedIdentity, access.identity) &&
            (receipt.action === "suspend" ? "suspended" : "released") === access.desiredState &&
            (receipt.acceptedVersion === access.version ||
              (receipt.acceptedVersion === null && receipt.version !== access.version))
          )
            return yield* new RuntimeClientError({
              operation: "observe",
              cause: new RuntimeStopRetry({ receipt, error: access.error }),
            });
        }
        if (access.state !== "running" || !access.execution)
          return yield* new RuntimeClientError({
            operation: "observe",
            cause:
              ["starting", "suspending", "releasing", "unavailable"].includes(access.state) ||
              ((access.state === "suspended" || access.state === "released") &&
                access.state !== access.desiredState)
                ? new WorkerNotReady({})
                : (access.error ?? "Worker status is not established"),
          });
        if (access.execution.identity.workspaceId !== workspaceId)
          return yield* new RuntimeClientError({
            operation: "observe",
            cause: "Worker identity mismatch",
          });
        return { kind: "running", client: createExecutionClient(access.execution) } as const;
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
