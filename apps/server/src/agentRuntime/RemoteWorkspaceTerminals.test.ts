import { WorkspaceActivity, WorkspaceRecentActivity } from "./WorkspaceActivity.ts";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as RemoteTerminals from "./RemoteWorkspaceTerminals.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProcessRunner from "../processRunner.ts";
import { makeTerminalExecutor } from "./worker/TerminalExecutor.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";

const layer = Layer.mergeAll(
  NodePtyAdapter.layer,
  ProcessRunner.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.layer(layer, { excludeTestServices: true })("remote native terminal", (it) => {
  it.effect(
    "runs a real PTY through HTTP, reconnects history, and closes only the selected thread",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-terminal-" });
        yield* fs.makeDirectory(path.join(root, "repo"));
        yield* RuntimeSchema.migrate;
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('terminal-workspace','parent')`;
        yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id,workspace_id) VALUES ('parent','terminal-workspace'),('child','terminal-workspace')`;
        yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,thread_id) VALUES ('/workspace/test/repo','terminal-workspace','repo','parent')`;
        const ptyAdapter = yield* PtyAdapter.PtyAdapter;
        const native = yield* TerminalManager.makeWithOptions({
          logsDir: path.join(root, "logs"),
          ptyAdapter,
          shellResolver: () => "/bin/sh",
        });
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(path.join(root, "journal.jsonl"))),
          (value) => Effect.promise(() => value.close()),
        );
        let worker: ReturnType<typeof createExecutionWorker> | undefined;
        const terminalExecutor = yield* makeTerminalExecutor({
          resolve: (cwd) => Effect.succeed(path.join(root, cwd)),
          publish: (event) =>
            Effect.promise(() =>
              worker
                ? worker.publish(`terminal:${event.threadId}`, event)
                : Promise.reject(new Error("worker not ready")),
            ),
        }).pipe(Effect.provideService(TerminalManager.TerminalManager, native));
        const identity = {
          workspaceId: "terminal-workspace",
          allocationId: "1",
          generation: 1,
          incarnation: "one",
          podUid: "pod",
          protocolVersion: 1,
        } satisfies Parameters<typeof createExecutionWorker>[0]["identity"];
        const token = "terminal-test-token-more-than-thirty-two-characters";
        const runPromise = yield* captureRunPromise;
        worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: (method, input) => runPromise(terminalExecutor.execute(method, input)),
          activity: () => runPromise(terminalExecutor.activity),
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(() => value.close()),
        );
        const client = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
        });
        let wakes = 0;
        let ready = false;
        const runtime = RuntimeClient.RuntimeClient.of({
          enabled: true,
          forThread: () =>
            Effect.sync(() => {
              wakes++;
              ready = true;
              return client;
            }),
          forWorkspace: () => Effect.succeed(client),
          forUtility: () => Effect.succeed(client),
          observeThread: () =>
            ready
              ? Effect.succeed({ kind: "running", client })
              : Effect.fail(
                  new RuntimeClient.RuntimeClientError({
                    operation: "observe",
                    cause: "Worker status is not established",
                  }),
                ),
          observeWorkspace: () => Effect.succeed({ kind: "running", client }),
          sessionResidency: () => Effect.succeed(identity),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        const remoteContext = yield* Layer.build(
          RemoteTerminals.layer.pipe(Layer.provide(Routing.layer)),
        ).pipe(Effect.provideService(RuntimeClient.RuntimeClient, runtime));
        const remote = Context.get(remoteContext, TerminalManager.TerminalManager);
        const observeFailure = yield* remote
          .observeStream({ threadId: "parent", terminalId: "shell" }, () => Effect.void)
          .pipe(Effect.flip);
        expect(observeFailure._tag).toBe("TerminalSessionLookupError");
        expect(wakes).toBe(0);
        const initialDetach = yield* remote.attachStream(
          {
            threadId: "parent",
            terminalId: "shell",
            cwd: "/workspace/test/repo",
          },
          () => Effect.void,
        );
        initialDetach();
        yield* remote.open({ threadId: "child", terminalId: "shell", cwd: "/workspace/test/repo" });
        const received = yield* Deferred.make<void>();
        let output = "";
        const unsubscribe = yield* remote.attachStream(
          { threadId: "child", terminalId: "shell" },
          (event) =>
            Effect.gen(function* () {
              if (event.type === "output") {
                output += event.data;
                if (output.includes("REMOTE_" + "SUCCESS"))
                  yield* Deferred.succeed(received, undefined);
              }
            }),
        );
        const recentActivity = yield* WorkspaceRecentActivity;
        const activeRequests = yield* WorkspaceActivity;
        recentActivity.delete("terminal-workspace");
        yield* remote.write({
          threadId: "child",
          terminalId: "shell",
          data: "printf 'REMOTE_%s\\n' SUCCESS\n",
        });
        expect(recentActivity.has("terminal-workspace")).toBe(true);
        expect(activeRequests.has("terminal-workspace")).toBe(false);
        const inputAt = recentActivity.get("terminal-workspace");
        yield* Deferred.await(received).pipe(Effect.timeout("10 seconds"));
        unsubscribe();
        let replay = "";
        const detach = yield* remote.observeStream(
          { threadId: "child", terminalId: "shell" },
          (event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") replay = event.snapshot.history;
            }),
        );
        expect(replay).toContain("REMOTE_SUCCESS");
        expect(recentActivity.get("terminal-workspace")).toBe(inputAt);
        detach();
        // A retained terminal tab outlives its process and must recover through
        // acquisition, even while observing its replacement is not yet possible.
        yield* native.close({ threadId: "child", terminalId: "shell" });
        ready = false;
        let recoveredHistory = "";
        const recovered = yield* remote.attachStream(
          { threadId: "child", terminalId: "shell", cwd: "/workspace/test/repo" },
          (event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") recoveredHistory = event.snapshot.history;
            }),
        );
        expect(recoveredHistory).toContain("REMOTE_SUCCESS");
        recovered();
        const exited = yield* Deferred.make<void>();
        const exitListener = yield* remote.attachStream(
          { threadId: "child", terminalId: "shell" },
          (event) =>
            event.type === "exited"
              ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* remote.write({ threadId: "child", terminalId: "shell", data: "exit\n" });
        yield* Deferred.await(exited).pipe(Effect.timeout("10 seconds"));
        exitListener();
        let reattachedStatus = "";
        let reattachedHistory = "";
        const unchanged = yield* remote.attachStream(
          { threadId: "child", terminalId: "shell", cwd: "/workspace/test/repo" },
          (event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") {
                reattachedStatus = event.snapshot.status;
                reattachedHistory = event.snapshot.history;
              }
            }),
        );
        expect(reattachedStatus).toBe("exited");
        expect(reattachedHistory).toContain("REMOTE_SUCCESS");
        unchanged();
        const restarted = yield* remote.attachStream(
          {
            threadId: "child",
            terminalId: "shell",
            cwd: "/workspace/test/repo",
            restartIfNotRunning: true,
          },
          (event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") {
                reattachedStatus = event.snapshot.status;
                reattachedHistory = event.snapshot.history;
              }
            }),
        );
        expect(reattachedStatus).toBe("running");
        expect(reattachedHistory).not.toContain("REMOTE_SUCCESS");
        restarted();
        const before = wakes;
        yield* remote.close({ threadId: "parent" });
        yield* remote.write({
          threadId: "child",
          terminalId: "shell",
          data: "printf 'still alive\\n'\n",
        });
        expect(wakes).toBe(before);
        expect((yield* terminalExecutor.activity).activeOperations).toBe(1);
        yield* remote.close({ threadId: "child" });
      }),
  );
});

it.effect("releases pending attach ownership on interruption and permits a fresh attach", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let observations = 0;
    let openings = 0;
    let interruptedDeliveries = 0;
    const snapshot = {
      threadId: "pending",
      terminalId: "shell",
      cwd: "/workspace/repo",
      worktreePath: null,
      status: "exited",
      pid: null,
      history: "retained",
      exitCode: 0,
      exitSignal: null,
      label: "shell",
      updatedAt: "2026-10-13T12:00:00.000Z",
    };
    const runtime = Layer.mock(RuntimeClient.RuntimeClient)({
      enabled: true,
      observeThread: () =>
        Effect.sync(() => {
          observations++;
          return { kind: "stopped" as const };
        }),
    });
    const routing = Layer.mock(Routing.WorkspaceRouting)({
      enabled: true,
      callThread: () =>
        Effect.gen(function* () {
          openings++;
          if (openings === 1) {
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }
          return snapshot;
        }),
    });
    yield* Effect.gen(function* () {
      const terminals = yield* TerminalManager.TerminalManager;
      const input = { threadId: "pending", terminalId: "shell", cwd: "/workspace/repo" };
      const pending = yield* terminals
        .attachStream(input, () =>
          Effect.sync(() => {
            interruptedDeliveries++;
          }),
        )
        .pipe(
          (acquire) => Effect.acquireRelease(acquire, (unsubscribe) => Effect.sync(unsubscribe)),
          Effect.scoped,
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      yield* TestClock.adjust("3 seconds");
      const stoppedAt = observations;
      yield* TestClock.adjust("10 seconds");
      expect(observations).toBe(stoppedAt);
      let received = "";
      const detach = yield* terminals.attachStream(input, (event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") received = event.snapshot.history;
        }),
      );
      expect(received).toBe("retained");
      expect(openings).toBe(2);
      expect(interruptedDeliveries).toBe(0);
      detach();
      yield* TestClock.adjust("3 seconds");
      const detachedAt = observations;
      yield* TestClock.adjust("10 seconds");
      expect(observations).toBe(detachedAt);
      const failedDelivery = yield* terminals
        .attachStream(input, () => Effect.die("snapshot delivery failed"))
        .pipe(Effect.exit);
      expect(failedDelivery._tag).toBe("Failure");
      yield* TestClock.adjust("3 seconds");
      const failedAt = observations;
      yield* TestClock.adjust("10 seconds");
      expect(observations).toBe(failedAt);
    }).pipe(
      Effect.provide(RemoteTerminals.layer.pipe(Layer.provide(runtime), Layer.provide(routing))),
      Effect.scoped,
    );
  }),
);
