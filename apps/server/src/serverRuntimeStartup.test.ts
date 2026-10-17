import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkspaceRouting from "./agentRuntime/WorkspaceRouting.ts";
import * as RuntimeClient from "./agentRuntime/RuntimeClient.ts";
import * as RuntimeSchema from "./agentRuntime/Schema.ts";
import { createExecutionClient } from "./execution/ExecutionClient.ts";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.live("startup auto-pull observes remote projects without starting their stopped workers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* RuntimeSchema.migrate;
    const projects = [
      ...Array.from({ length: 10 }, (_, i) => `stopped-${i}`),
      "running",
      "unavailable",
    ].map((id) => ({
      id: ProjectId.make(id),
      workspaceRoot: `/workspace/${id}/repo`,
      autoPull: false,
    }));
    for (const project of projects) {
      yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id, owner_thread_id) VALUES (${project.id}, ${project.id})`;
      yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd, workspace_id, relative_cwd, utility_key)
        VALUES (${project.workspaceRoot}, ${project.id}, ${`${project.id}/repo`}, ${`project:${project.id}`})`;
    }
    let acquisitions = 0;
    const observations: string[] = [];
    const checked: string[] = [];
    const pulled: string[] = [];
    const client = createExecutionClient({
      identity: {
        workspaceId: "running",
        allocationId: "allocation",
        generation: 1,
        incarnation: "worker",
        podUid: "pod",
        protocolVersion: 1,
      },
      endpoint: "http://worker.invalid",
      token: "fixture-token",
    });
    const routes = yield* WorkspaceRouting.WorkspaceRouting.pipe(
      Effect.provide(
        WorkspaceRouting.layer.pipe(
          Layer.provide(
            Layer.mock(RuntimeClient.RuntimeClient)({
              enabled: true,
              forWorkspace: () =>
                Effect.sync(() => {
                  acquisitions++;
                  return client;
                }),
              observeWorkspace: (id) =>
                Effect.suspend(() => {
                  observations.push(id);
                  if (id === "unavailable")
                    return Effect.fail(
                      new RuntimeClient.RuntimeClientError({
                        operation: "observe",
                        cause: "fixture unavailable",
                      }),
                    );
                  return Effect.succeed(
                    id === "running"
                      ? { kind: "running" as const, client }
                      : { kind: "stopped" as const },
                  );
                }),
            }),
          ),
        ),
      ),
    );
    yield* ServerRuntimeStartup.autoPullProjects(projects, {
      ...DEFAULT_SERVER_SETTINGS,
      defaultAutoPull: true,
    }).pipe(
      Effect.provideService(WorkspaceRouting.WorkspaceRouting, routes),
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails: (cwd) =>
            routes.clientForCwd(cwd).pipe(
              Effect.orDie,
              Effect.map(() => {
                checked.push(cwd);
                return {
                  isRepo: true,
                  hasOriginRemote: true,
                  isDefaultBranch: true,
                  branch: "main",
                  upstreamRef: "origin/main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 1,
                  aheadOfDefaultCount: 0,
                };
              }),
            ),
          pullCurrentBranch: (cwd) =>
            routes.clientForCwd(cwd).pipe(
              Effect.orDie,
              Effect.map(() => {
                pulled.push(cwd);
                return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
              }),
            ),
        }),
      ),
    );
    assert.equal(acquisitions, 0);
    assert.deepStrictEqual(new Set(observations), new Set(projects.map((p) => p.id)));
    assert.deepStrictEqual(checked, ["/workspace/running/repo"]);
    assert.deepStrictEqual(pulled, ["/workspace/running/repo"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      NodeSqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
