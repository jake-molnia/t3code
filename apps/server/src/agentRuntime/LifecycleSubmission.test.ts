import { withWorkspaceActivity } from "./WorkspaceActivity.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  SandboxLifecycle,
  SandboxLifecycleError,
  type WorkspaceResource,
} from "../sandbox/SandboxLifecycle.ts";
import { poolsLayer } from "./testkit/Sandbox.ts";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as Enrollment from "./LifecycleEnrollment.ts";
import * as Policy from "./LifecyclePolicy.ts";

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
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* RuntimeSchema.migrate;
  yield* sql`DELETE FROM agent_runtime_workspaces`;
  yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision) VALUES ('utility-workspace','utility:catalog',10)`;
  const requests: Array<{ version: string; desiredState: string }> = [];
  let resource: WorkspaceResource = {
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
  const control = {
    fail: false,
    loseResponse: false,
    race: false,
    failAccepted: false,
    failSubmission: false,
  };
  const lifecycle = SandboxLifecycle.of({
    ensure: () => Effect.sync(() => resource),
    observe: () => Effect.sync(() => resource),
    setDesiredState: (_workspaceId, _placement, desiredState, version) =>
      Effect.gen(function* () {
        requests.push({ version, desiredState });
        const failure = () =>
          new SandboxLifecycleError({
            operation: "setDesiredState",
            httpStatus: 503,
            cause: "unavailable",
          });
        if (control.fail) return yield* failure();
        if (control.race) {
          resource = {
            ...resource,
            version: "newer-wake",
            desiredState: "running",
            state: "running",
          };
          control.race = false;
        }
        if (version !== resource.version)
          return yield* new SandboxLifecycleError({
            operation: "setDesiredState",
            httpStatus: 412,
            cause: "Workspace changed",
          });
        if (control.failSubmission) {
          resource = {
            ...resource,
            desiredState,
            version: "queued-version",
            progress: { step: "queued", startedAt: "2026-10-15T00:00:00Z" },
            execution: null,
          };
          return yield* failure();
        }
        resource = {
          ...resource,
          desiredState,
          progress: null,
          state: control.failAccepted ? "failed" : desiredState,
          error: control.failAccepted
            ? { code: "worker_busy", message: "Worker is busy", retryable: true }
            : null,
          version: `version-${requests.length}`,
          execution:
            desiredState === "running"
              ? { identity, endpoint: "http://worker.test", token: "worker-token" }
              : null,
        };
        if (control.loseResponse) {
          control.loseResponse = false;
          return yield* failure();
        }
        return resource;
      }),
  });
  const construct = () =>
    RuntimeClient.RuntimeClient.pipe(
      Effect.provide(RuntimeClient.layer.pipe(Layer.provide(poolsLayer()))),
      Effect.provideService(SandboxLifecycle, lifecycle),
    );
  return {
    sql,
    requests,
    control,
    construct,
    setResource: (next: Partial<typeof resource>) => {
      resource = { ...resource, ...next };
    },
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
  it.effect(
    "replays the persisted resource version after a failed submission and central restart",
    () =>
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
          { version: "initial", desiredState: "suspended" },
          { version: "initial", desiredState: "suspended" },
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
      expect(f.requests.map((request) => request.version)).toEqual(["initial"]);
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
      expect(RuntimeClient.retryableStop(failed)?.error?.code).toBe("worker_busy");
      f.control.failAccepted = false;
      yield* runtime.stop(f.owner, "suspend", { ...f.options, expectedRevision: 11 });
      expect(f.requests).toEqual([
        { version: "initial", desiredState: "suspended" },
        { version: "version-1", desiredState: "suspended" },
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
  it.effect.each(["suspended", "released"] as const)(
    "retires an upgraded %s workspace and fences its proof from a later wake",
    (state) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const action = state === "suspended" ? "suspend" : "release_compute";
        const operationId =
          state === "suspended" ? "idle:legacy" : "release:utility-workspace:1000:legacy";
        const legacy = JSON.stringify({
          operationId,
          revision: 10,
          action,
          profile: "old",
          expectedIncarnation: "old-worker",
        });
        yield* f.sql`UPDATE agent_runtime_workspaces SET lifecycle_request_json=${legacy},execution_requested=0`;
        yield* RuntimeSchema.migrate;
        f.setResource({ state, desiredState: state, execution: null });
        const runtime = yield* f.construct();
        const observed = yield* runtime.observeWorkspace(identity.workspaceId);
        if (observed.kind !== "stopped" || !observed.completedStop)
          throw new Error("Missing legacy completion proof");
        expect(observed.completedStop).toEqual({ operationId, revision: 10, action });
        yield* Enrollment.retire(identity.workspaceId, 10, observed.completedStop);
        expect(yield* Enrollment.roots).toEqual([]);
        yield* RuntimeSchema.migrate;
        expect(yield* Enrollment.roots).toEqual([]);
        yield* runtime.forWorkspace(identity.workspaceId);
        yield* Enrollment.retire(identity.workspaceId, 10, observed.completedStop);
        expect(yield* Enrollment.roots).toEqual([f.owner]);
        expect(f.requests).toEqual([{ version: "initial", desiredState: "running" }]);
      }),
  );
  it.effect("replays a queued stop after submission failed and central service restarted", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = yield* f.construct();
      f.control.failSubmission = true;
      yield* runtime.stop(f.owner, "suspend", f.options).pipe(Effect.flip);
      const restarted = yield* f.construct();
      const observationError = yield* restarted
        .observeWorkspace(identity.workspaceId)
        .pipe(Effect.flip);
      const retry = RuntimeClient.retryableStop(observationError);
      expect(retry?.error).toBeNull();
      const read = Effect.gen(function* () {
        const rows = yield* f.sql<{
          revision: number;
        }>`SELECT admission_revision AS revision FROM agent_runtime_workspaces WHERE workspace_id=${identity.workspaceId}`;
        return {
          ownerThreadId: f.owner,
          workspaceId: identity.workspaceId,
          revision: rows[0]!.revision,
          kind: "utility" as const,
          members: [],
          pendingEffects: false,
          settleScript: null,
        };
      });
      const policy = yield* Policy.makePolicy({
        enabled: true,
        idleMs: 0,
        roots: Effect.succeed([f.owner]),
        recoverSettlements: Effect.void,
        enroll: () => Effect.void,
        retire: () => Effect.void,
        read: () => read.pipe(Effect.orDie),
        observe: () =>
          restarted.observeWorkspace(identity.workspaceId).pipe(
            Effect.catchTags({
              AgentRuntimeClientError: (error) => {
                const failure = RuntimeClient.retryableStop(error);
                return failure
                  ? Effect.succeed({ kind: "retryable-stop" as const, failure })
                  : Effect.die(error);
              },
            }),
          ),
        resume: () => Effect.die("Recovery must not wake execution"),
        collectUsage: () => Effect.die("No worker credentials during queued stop"),
        stop: (snapshot, action, operationId, expectedIdentity) =>
          restarted
            .stop(f.owner, action, {
              operationId,
              expectedIdentity,
              expectedRevision: snapshot.revision,
            })
            .pipe(Effect.orDie),
      });
      f.control.failSubmission = false;
      expect(yield* policy.reconcileThread(f.owner)).toBe("suspend-submitted");
      expect(f.requests).toEqual([
        { version: "initial", desiredState: "suspended" },
        { version: "queued-version", desiredState: "suspended" },
      ]);
    }).pipe(Effect.scoped),
  );
});
