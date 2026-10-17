import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
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
    postStatus: 503,
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
    const run = yield* captureRunPromise;
    const admissionEntered = yield* Deferred.make<void>();
    const allowAdmission = yield* Deferred.make<void>();
    let posts = 0;
    let reads = 0;
    let admitted = false;
    const controller = yield* Effect.acquireRelease(
      Effect.promise(() =>
        listenWorker({
          host: "127.0.0.1",
          port: 0,
          handle: async (request) => {
            expect(activity.has("readiness-workspace")).toBe(true);
            const identity = {
              workspaceId: "readiness-workspace",
              allocationId: "one",
              generation: 1,
              incarnation: "worker",
              podUid: "pod",
              protocolVersion: 1,
            };
            const response = (running: boolean, superseded = false) =>
              Response.json(
                {
                  id: "readiness-workspace",
                  pool: "local",
                  profile: "t3",
                  desiredState: superseded ? "released" : running ? "running" : "released",
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
                      ? {
                          code: "lifecycle_failed",
                          message: "private controller diagnostics",
                          retryable: true,
                        }
                      : null,
                  identity: running ? identity : null,
                  execution: running
                    ? { identity, endpoint: "http://worker.test", token: "test-worker-token" }
                    : null,
                },
                { headers: { etag: running ? '"active"' : '"registered"' } },
              );
            if (request.method === "PUT" && !new URL(request.url).pathname.endsWith("/state")) {
              expect(await request.json()).toEqual({ pool: "local", profile: "t3" });
              admitted = false;
              return response(false);
            }
            if (request.method === "PUT") {
              posts += 1;
              await run(Deferred.succeed(admissionEntered, undefined));
              await run(Deferred.await(allowAdmission));
              expect(await request.json()).toEqual({ desiredState: "running" });
              expect(request.headers.get("if-match")).toBe('"registered"');
              if (testCase.postStatus !== 202)
                return Response.json({}, { status: testCase.postStatus });
              admitted = true;
              return response(true);
            }
            if (!admitted) return response(false);
            reads += 1;
            if (reads === 1 && testCase.firstReadStatus !== 200)
              return new Response(null, { status: testCase.firstReadStatus });
            return response(true, testCase.superseded);
          },
        }),
      ),
      (server) => Effect.promise(server.close),
    );
    const runtime = yield* RuntimeClient.RuntimeClient.pipe(
      Effect.provide(
        RuntimeClient.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                AGENT_RUNTIME_URL: `http://127.0.0.1:${controller.port}`,
                AGENT_RUNTIME_TOKEN: "test-controller-token",
              }),
            ),
          ),
        ),
      ),
    );
    const cancelledCaller = yield* runtime
      .forWorkspace("readiness-workspace")
      .pipe(Effect.forkChild);
    const waitingCallers = yield* Effect.all(
      Array.from({ length: 2 }, () =>
        runtime.forWorkspace("readiness-workspace").pipe(Effect.exit),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
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
  "observing an unregistered workspace does not allocate, register, or call the controller",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* RuntimeSchema.migrate;
      let requests = 0;
      const controller = yield* Effect.acquireRelease(
        Effect.promise(() =>
          listenWorker({
            host: "127.0.0.1",
            port: 0,
            handle: async () => {
              requests++;
              return new Response(null, { status: 503 });
            },
          }),
        ),
        (server) => Effect.promise(server.close),
      );
      const runtime = yield* RuntimeClient.RuntimeClient.pipe(
        Effect.provide(
          RuntimeClient.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  AGENT_RUNTIME_URL: `http://127.0.0.1:${controller.port}`,
                  AGENT_RUNTIME_TOKEN: "test-controller-token",
                }),
              ),
            ),
          ),
        ),
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
