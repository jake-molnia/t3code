import { WorkspaceActivity, WorkspaceRecentActivity } from "./WorkspaceActivity.ts";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
        worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: (method, input) => Effect.runPromise(terminalExecutor.execute(method, input)),
          activity: () => Effect.runPromise(terminalExecutor.activity),
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
        const runtime = RuntimeClient.RuntimeClient.of({
          ideOrigin: () => Effect.die("IDE origin is not used by this test"),
          enabled: true,
          forThread: () =>
            Effect.sync(() => {
              wakes++;
              return client;
            }),
          forWorkspace: () => Effect.succeed(client),
          forUtility: () => Effect.succeed(client),
          observeThread: () => Effect.succeed({ kind: "running", client }),
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
        yield* remote.open({
          threadId: "parent",
          terminalId: "shell",
          cwd: "/workspace/test/repo",
        });
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
