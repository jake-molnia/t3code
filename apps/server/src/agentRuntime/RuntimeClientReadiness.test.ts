import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import {
  SandboxLifecycle,
  SandboxLifecycleError,
  type WorkspaceResource,
} from "../sandbox/SandboxLifecycle.ts";
import { poolsLayer } from "./testkit/Sandbox.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as RuntimeSchema from "./Schema.ts";
import { WorkspaceActivity } from "./WorkspaceActivity.ts";

const services = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  FetchHttpClient.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.live.each([
  {
    scenario: "transient readiness",
    postStatus: 202,
    firstReadStatus: 503,
    superseded: false,
    succeeds: true,
    reads: 2,
  },
  {
    scenario: "authentication failure",
    postStatus: 202,
    firstReadStatus: 401,
    superseded: false,
    succeeds: false,
    reads: 1,
  },
  {
    scenario: "failed admission",
    postStatus: 403,
    firstReadStatus: 200,
    superseded: false,
    succeeds: false,
    reads: 0,
  },
  {
    scenario: "lifecycle failure",
    postStatus: 202,
    firstReadStatus: 200,
    superseded: false,
    succeeds: false,
    reads: 1,
  },
  {
    scenario: "superseded wake",
    postStatus: 202,
    firstReadStatus: 200,
    superseded: true,
    succeeds: false,
    reads: 1,
  },
])("handles $scenario without replaying admission", (testCase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* RuntimeSchema.migrate;
    yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id,admission_revision) VALUES ('readiness-workspace','readiness-owner',1)`;
    const activity = yield* WorkspaceActivity;
    const admissionEntered = yield* Deferred.make<void>();
    const allowAdmission = yield* Deferred.make<void>();
    let posts = 0;
    let reads = 0;
    let admitted = false;
    const identity = {
      workspaceId: "readiness-workspace",
      allocationId: "one",
      generation: 1,
      incarnation: "worker",
      podUid: "pod",
      protocolVersion: 1 as const,
    };
    const resource = (running: boolean, superseded = false): WorkspaceResource => ({
      id: identity.workspaceId,
      pool: "local",
      profile: "t3",
      desiredState: superseded || !running ? "released" : "running",
      state:
        running && testCase.scenario === "lifecycle failure"
          ? "failed"
          : running
            ? "running"
            : "released",
      version: running ? "active" : "registered",
      progress: null,
      error:
        running && testCase.scenario === "lifecycle failure"
          ? { code: "lifecycle_failed", message: "private controller diagnostics", retryable: true }
          : null,
      identity: running ? identity : null,
      execution: running
        ? { identity, endpoint: "http://worker.test", token: "test-worker-token" }
        : null,
    });
    const lifecycle = SandboxLifecycle.of({
      ensure: () =>
        Effect.sync(() => {
          expect(activity.has(identity.workspaceId)).toBe(true);
          admitted = false;
          return resource(false);
        }),
      setDesiredState: (_id, _placement, desiredState, version) =>
        Effect.gen(function* () {
          expect(activity.has(identity.workspaceId)).toBe(true);
          posts++;
          yield* Deferred.succeed(admissionEntered, undefined);
          yield* Deferred.await(allowAdmission);
          expect(desiredState).toBe("running");
          expect(version).toBe("registered");
          if (testCase.postStatus !== 202)
            return yield* new SandboxLifecycleError({
              operation: "setDesiredState",
              httpStatus: testCase.postStatus,
              cause: "admission failed",
            });
          admitted = true;
          return resource(true);
        }),
      observe: () =>
        Effect.gen(function* () {
          expect(activity.has(identity.workspaceId)).toBe(true);
          if (!admitted) return resource(false);
          reads++;
          if (reads === 1 && testCase.firstReadStatus !== 200)
            return yield* new SandboxLifecycleError({
              operation: "observe",
              httpStatus: testCase.firstReadStatus,
              cause: "observation failed",
            });
          return resource(true, testCase.superseded);
        }),
    });
    const runtime = yield* RuntimeClient.RuntimeClient.pipe(
      Effect.provide(RuntimeClient.layer.pipe(Layer.provide(poolsLayer()))),
      Effect.provideService(SandboxLifecycle, lifecycle),
    );
    const cancelledCaller = yield* runtime
      .forWorkspace("readiness-workspace")
      .pipe(Effect.forkChild({ startImmediately: true }));
    const waitingCallers = yield* Effect.all(
      Array.from({ length: 2 }, () =>
        runtime.forWorkspace("readiness-workspace").pipe(Effect.exit),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(admissionEntered);
    yield* Fiber.interrupt(cancelledCaller);
    yield* Deferred.succeed(allowAdmission, undefined);
    const results = yield* Fiber.join(waitingCallers);
    expect(results.map(Exit.isSuccess)).toEqual([testCase.succeeds, testCase.succeeds]);
    if (testCase.scenario === "lifecycle failure") {
      for (const result of results) {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
          expect(RuntimeClient.runtimeStartupMessage(error)).toBe(
            "Sandbox startup failed before the execution worker became ready. Retry the turn.",
          );
        }
      }
    }
    expect(posts).toBe(1);
    expect(reads).toBe(testCase.reads);
    expect(activity.has("readiness-workspace")).toBe(false);
    if (testCase.succeeds) {
      yield* runtime.forWorkspace("readiness-workspace");
      expect(posts).toBe(2);
      expect(reads).toBe(testCase.reads + 1);
    }
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "observing an unregistered workspace does not allocate, register, or call sandbox lifecycle",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      let requests = 0;
      const unexpected = () =>
        Effect.sync(() => {
          requests++;
          throw new Error("Unregistered workspace must not call lifecycle");
        });
      const runtime = yield* RuntimeClient.RuntimeClient.pipe(
        Effect.provide(RuntimeClient.layer.pipe(Layer.provide(poolsLayer()))),
        Effect.provideService(SandboxLifecycle, {
          ensure: unexpected,
          observe: unexpected,
          setDesiredState: unexpected,
        }),
      );
      const before = yield* sql`SELECT total_changes() AS writes`;
      expect(yield* runtime.observeWorkspace("t3:utility:never-started")).toEqual({
        kind: "stopped",
      });
      expect(yield* sql`SELECT total_changes() AS writes`).toEqual(before);
      expect(yield* sql`SELECT workspace_id FROM agent_runtime_workspaces`).toEqual([]);
      expect(requests).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("explicit acquisition resumes a worker that becomes ready after admission", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* RuntimeSchema.migrate;
    yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('delayed','owner')`;
    const identity = {
      workspaceId: "delayed",
      allocationId: "one",
      generation: 1,
      incarnation: "worker",
      podUid: "pod",
      protocolVersion: 1 as const,
    };
    let admissions = 0;
    const resource = (): WorkspaceResource => ({
      id: "delayed",
      pool: "local",
      profile: "t3",
      desiredState: "running",
      version: "1",
      state: admissions >= 2 ? "running" : "starting",
      progress: null,
      error: null,
      identity,
      execution:
        admissions >= 2 ? { identity, endpoint: "http://worker.test", token: "token" } : null,
    });
    const runtime = yield* RuntimeClient.RuntimeClient.pipe(
      Effect.provide(RuntimeClient.layer.pipe(Layer.provide(poolsLayer()))),
      Effect.provideService(SandboxLifecycle, {
        ensure: () => Effect.sync(resource),
        observe: () => Effect.sync(resource),
        setDesiredState: () =>
          Effect.sync(() => {
            admissions++;
            return resource();
          }),
      }),
    );
    const client = yield* runtime.forWorkspace("delayed");
    expect(client.identity).toEqual(identity);
    expect(admissions).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("explains retained workspace cutover without exposing controller diagnostics", () =>
  Effect.sync(() => {
    const error = new RuntimeClient.RuntimeClientError({
      operation: "ensure-running",
      cause: new SandboxLifecycleError({
        operation: "cutover",
        cause: {
          code: "workspace_cutover_required",
          message: "private diagnostic",
          retryable: false,
        },
      }),
    });
    expect(RuntimeClient.runtimeStartupMessage(error)).toBe(
      "Restore this workspace into its native sandbox volume before starting execution. See the native sandbox cutover guide.",
    );
  }),
);

it.effect("explicit startup retries pending compute deletion within its acquisition deadline", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* RuntimeSchema.migrate;
    yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('retry','owner')`;
    const pending = yield* Deferred.make<void>();
    const identity = {
      workspaceId: "retry",
      allocationId: "one",
      generation: 1,
      incarnation: "worker",
      podUid: "pod",
      protocolVersion: 1 as const,
    };
    let attempts = 0;
    const resource = (): WorkspaceResource => ({
      id: "retry",
      pool: "local",
      profile: "t3",
      desiredState: "running",
      version: "1",
      state: attempts >= 2 ? "running" : "starting",
      progress: null,
      error: null,
      identity,
      execution:
        attempts >= 2 ? { identity, endpoint: "http://worker.test", token: "token" } : null,
    });
    const runtime = yield* RuntimeClient.RuntimeClient.pipe(
      Effect.provide(RuntimeClient.layer.pipe(Layer.provide(poolsLayer()))),
      Effect.provideService(SandboxLifecycle, {
        ensure: () => Effect.sync(resource),
        observe: () => Effect.sync(resource),
        setDesiredState: () =>
          Effect.gen(function* () {
            attempts++;
            if (attempts === 1) {
              yield* Deferred.succeed(pending, undefined);
              return yield* new SandboxLifecycleError({
                operation: "set-state",
                httpStatus: 503,
                cause: "Previous compute is still releasing",
              });
            }
            return resource();
          }),
      }),
    );
    const acquiring = yield* runtime.forWorkspace("retry").pipe(Effect.forkChild);
    yield* Deferred.await(pending);
    yield* TestClock.adjust("250 millis");
    expect((yield* Fiber.join(acquiring)).identity).toEqual(identity);
    expect(attempts).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
