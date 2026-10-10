import * as C from "@t3tools/contracts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { createExecutionWorker } from "../../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../../execution/ExecutionClient.ts";
import { openWorkerJournal } from "../../execution/WorkerJournal.ts";
import { seedWorkspace } from "../SeedWorkspace.ts";
import { makeForkExecutor } from "./ForkExecutor.ts";
import { makeAssetExecutor } from "./AssetExecutor.ts";
import { captureRunPromise } from "../../execution/EffectHttpBoundary.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { makeWorkspaceExecutor } from "./WorkspaceExecutor.ts";

const project = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);
const registry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer));
const services = Layer.mergeAll(
  project,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  GitVcsDriver.layer,
  CheckpointStore.layer.pipe(Layer.provide(registry)),
  ProcessRunner.layer,
).pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provide(registry),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "worker-workspace-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "worker-workspace-" });
  yield* fs.makeDirectory(path.join(root, "repo"));
  const worker = yield* makeWorkspaceExecutor({
    root,
    incarnation: "first",
    canRestore: Effect.succeed(true),
  });
  return { fs, path, root, worker };
});
const Oid = Schema.Struct({ oid: Schema.String });

it.layer(services, { excludeTestServices: true })("sandbox workspace operations", (it) => {
  it.effect(
    "reads and writes through upstream services while rejecting absolute paths and symlink checkout escape",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, worker } = yield* fixture;
        yield* worker.execute("files.write", {
          cwd: "repo",
          relativePath: "src/hello.txt",
          contents: "hello",
        });
        const read = yield* worker.execute("files.read", {
          cwd: "repo",
          relativePath: "src/hello.txt",
        });
        expect(read).toMatchObject({ contents: "hello" });
        expect(
          yield* worker
            .execute("files.read", { cwd: "repo", relativePath: "/etc/passwd" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_path_escape" });
        expect(
          yield* worker
            .execute("files.read", { cwd: "../outside", relativePath: "file" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_path_escape" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "outside-worker-" });
        const report = path.join(outside, "report.md");
        yield* fs.writeFileString(report, "sandbox temporary report");
        expect(
          yield* worker.execute("files.read", { cwd: "repo", relativePath: report }),
        ).toMatchObject({ contents: "sandbox temporary report" });
        yield* fs.symlink(outside, path.join(root, "escaped"));
        expect(
          yield* worker
            .execute("files.list", { cwd: "escaped", directoryPath: "" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_symlink_escape" });
        const listed = yield* worker.execute("files.list", { cwd: "repo", directoryPath: "src" });
        expect(listed).toMatchObject({ entries: [{ path: "src/hello.txt", kind: "file" }] });
      }),
  );
  it.effect.each([false, true])(
    "copies project files into independent roots and preserves edits on retry (committed remote: %s)",
    (remote) =>
      Effect.gen(function* () {
        const { fs, path, root, worker } = yield* fixture;
        yield* worker.execute("git.init", { cwd: "repo" });
        const git = yield* GitVcsDriver.GitVcsDriver;
        if (remote) {
          yield* fs.writeFileString(path.join(root, "repo/README.md"), "committed base");
          for (const args of [
            ["config", "user.name", "Test"],
            ["config", "user.email", "test@example.com"],
            ["add", "README.md"],
            ["commit", "-m", "base"],
            ["remote", "add", "origin", "https://github.com/example/seed.git"],
          ])
            yield* git.execute({ operation: "seed-test", cwd: path.join(root, "repo"), args });
        }
        yield* worker.execute("files.write", {
          cwd: "repo",
          relativePath: "README.md",
          contents: "named project",
        });
        yield* worker.execute("files.write", {
          cwd: "repo",
          relativePath: "assets/design.txt",
          contents: "untracked design",
        });
        const config = yield* ServerConfig.ServerConfig;
        const run = yield* captureRunPromise;
        const makeClient = (workspaceRoot: string, failMethod?: "asset.stage" | "git.importFork") =>
          Effect.gen(function* () {
            const workspace = yield* makeWorkspaceExecutor({
              root: workspaceRoot,
              incarnation: "seed-test",
              canRestore: Effect.succeed(true),
            });
            const workerConfig = {
              ...config,
              cwd: workspaceRoot,
              stateDir: path.join(workspaceRoot, ".state"),
            };
            const fork = yield* makeForkExecutor({ resolve: workspace.resolve }).pipe(
              Effect.provideService(ServerConfig.ServerConfig, workerConfig),
            );
            const assets = yield* makeAssetExecutor.pipe(
              Effect.provideService(ServerConfig.ServerConfig, workerConfig),
            );
            const journal = yield* Effect.acquireRelease(
              Effect.tryPromise(() =>
                openWorkerJournal(path.join(workerConfig.stateDir, "operations.jsonl")),
              ),
              (journal) => Effect.promise(journal.close),
            );
            let rejectNext = failMethod !== undefined;
            const execute = (method: string, input: unknown) =>
              Effect.gen(function* () {
                if (method.startsWith("asset.")) return yield* assets.execute(method, input);
                if (["git.bundleFork", "git.importFork", "git.cleanupFork"].includes(method))
                  return yield* fork.execute(method, input);
                return yield* workspace.execute(method, input);
              });
            const identity = {
              workspaceId: workspaceRoot,
              generation: 1,
              allocationId: "test",
              podUid: "test",
              incarnation: "test",
              protocolVersion: 1 as const,
            };
            const token = "seed-test-token-000000000000000000000000";
            const handler = createExecutionWorker({
              identity,
              token,
              journal,
              execute: (method, input) => {
                if (method === failMethod && rejectNext) {
                  rejectNext = false;
                  return Promise.reject(new Error("Interrupted asset transfer"));
                }
                return run(execute(method, input));
              },
            });
            return createExecutionClient({
              endpoint: "http://worker.invalid",
              token,
              identity,
              fetch: (url, init) => handler.handle(new Request(url, init)),
            });
          });
        let sourceScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(sourceScope, Exit.void));
        let source = yield* makeClient(root).pipe(Effect.provideService(Scope.Scope, sourceScope));
        const firstRoot = yield* fs.makeTempDirectoryScoped({ prefix: "seed-first-" });
        const secondRoot = yield* fs.makeTempDirectoryScoped({ prefix: "seed-second-" });
        const first = yield* makeClient(firstRoot);
        const second = yield* makeClient(secondRoot);
        for (const [key, destination] of [
          ["first", first],
          ["second", second],
        ] as const) {
          expect(
            yield* Effect.tryPromise(() => destination.call("git.isRepository", { cwd: "repo" })),
          ).toBe(false);
          yield* seedWorkspace({
            source,
            destination,
            sourceCwd: "repo",
            destinationCwd: "repo",
            key,
          });
          expect(
            yield* Effect.tryPromise(() => destination.call("git.isRepository", { cwd: "repo" })),
          ).toBe(true);
          yield* Effect.tryPromise(() =>
            destination.call("workspace.prepare", {
              cwd: "repo",
              branch: `thread-${key}`,
              ...(remote ? { sourceUrl: "https://github.com/example/seed.git" } : {}),
            }),
          );
          expect(
            yield* Effect.tryPromise(() =>
              destination.call("files.read", { cwd: "repo", relativePath: "README.md" }),
            ),
          ).toMatchObject({ contents: "named project" });
          const gitStatus = yield* Effect.tryPromise(() =>
            destination.call("git.status", { cwd: "repo" }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(C.VcsStatusResult))));
          expect(gitStatus.isRepo).toBe(true);
          expect(gitStatus.hasPrimaryRemote).toBe(remote);

          expect(
            yield* Effect.tryPromise(() =>
              destination.call("files.read", { cwd: "repo", relativePath: "assets/design.txt" }),
            ),
          ).toMatchObject({ contents: "untracked design" });
        }
        const interruptedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "seed-interrupted-" });
        const interrupted = yield* makeClient(
          interruptedRoot,
          remote ? "git.importFork" : "asset.stage",
        );
        const interruptedInput = {
          source,
          destination: interrupted,
          sourceCwd: "repo",
          destinationCwd: "repo",
          key: "interrupted",
        };
        expect((yield* seedWorkspace(interruptedInput).pipe(Effect.exit))._tag).toBe("Failure");
        // Blob storage and temporary exports can disappear independently of durable receipts.
        yield* fs.remove(path.join(root, ".state/worker-blobs"), { recursive: true, force: true });
        yield* fs.writeFileString(
          path.join(root, "repo/README.md"),
          "source changed after interruption",
        );
        yield* Scope.close(sourceScope, Exit.void);
        sourceScope = yield* Scope.make();
        source = yield* makeClient(root).pipe(Effect.provideService(Scope.Scope, sourceScope));
        yield* seedWorkspace({ ...interruptedInput, source });
        expect(yield* fs.readFileString(path.join(interruptedRoot, "repo/README.md"))).toBe(
          "named project",
        );
        yield* fs.writeFileString(path.join(root, "repo/README.md"), "named project");
        yield* Effect.tryPromise(() =>
          first.call("files.write", {
            cwd: "repo",
            relativePath: "README.md",
            contents: "first root edit",
          }),
        );
        yield* seedWorkspace({
          source,
          destination: first,
          sourceCwd: "repo",
          destinationCwd: "repo",
          key: "first",
        });
        expect(yield* fs.readFileString(path.join(firstRoot, "repo/README.md"))).toBe(
          "first root edit",
        );
        expect(yield* fs.readFileString(path.join(secondRoot, "repo/README.md"))).toBe(
          "named project",
        );
        expect(yield* fs.readFileString(path.join(root, "repo/README.md"))).toBe("named project");
      }),
  );
  it.effect("keeps the original checkpoint on retry and restores its actual files", () =>
    Effect.gen(function* () {
      const { fs, path, root, worker } = yield* fixture;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const cwd = path.join(root, "repo");
      for (const args of [
        ["init"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* git.execute({ operation: "test.init", cwd, args });
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "base");
      yield* git.execute({ operation: "test.commit", cwd, args: ["add", "."] });
      yield* git.execute({ operation: "test.commit", cwd, args: ["commit", "-m", "base"] });
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "checkpoint");
      const input = { cwd: "repo", checkpointRef: "refs/t3/test/immutable" };
      const first = yield* Schema.decodeUnknownEffect(Oid)(
        yield* worker.execute("git.captureCheckpoint", input),
      );
      expect(
        yield* worker.execute("git.listAuthoredPaths", {
          cwd: "repo",
          fromCheckpointRef: input.checkpointRef,
          toCheckpointRef: input.checkpointRef,
        }),
      ).toBeNull();
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "later edit");
      yield* git.execute({
        operation: "test.commit",
        cwd,
        args: ["commit", "-am", "authored change"],
      });
      const nextRef = "refs/t3/test/authored";
      yield* worker.execute("git.captureCheckpoint", { cwd: "repo", checkpointRef: nextRef });
      expect(
        yield* worker.execute("git.listAuthoredPaths", {
          cwd: "repo",
          fromCheckpointRef: input.checkpointRef,
          toCheckpointRef: nextRef,
        }),
      ).toEqual(["file.txt"]);
      expect(
        yield* worker.execute("git.diffCheckpoints", {
          cwd: "repo",
          fromCheckpointRef: input.checkpointRef,
          toCheckpointRef: nextRef,
          ignoreWhitespace: false,
          format: "numstat",
          filePaths: [],
        }),
      ).toBe("");
      const retry = yield* Schema.decodeUnknownEffect(Oid)(
        yield* worker.execute("git.captureCheckpoint", input),
      );
      expect(retry.oid).toBe(first.oid);
      expect(yield* worker.execute("git.restore", { ...input, isolated: true })).toBe(true);
      expect(yield* fs.readFileString(path.join(cwd, "file.txt"))).toBe("checkpoint");
      expect(
        yield* worker
          .execute("git.captureCheckpoint", { ...input, checkpointRef: "refs/heads/main" })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_checkpoint_namespace" });
      const denied = yield* makeWorkspaceExecutor({ root, incarnation: "second" });
      expect(
        yield* denied.execute("git.restore", { ...input, isolated: true }).pipe(Effect.flip),
      ).toMatchObject({
        code: "shared_workspace_restore_denied",
      });
    }),
  );
  it.effect(
    "retains script receipts across worker reconstruction without rerunning side effects",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, worker } = yield* fixture;
        const input = {
          cwd: "repo",
          operationId: "setup-one",
          command: "/bin/sh",
          args: ["-c", "printf x >> count.txt"],
          timeoutMs: 10_000,
        };
        yield* worker.execute("scripts.run", input);
        yield* worker.execute("scripts.run", input);
        const next = yield* makeWorkspaceExecutor({ root, incarnation: "replacement" });
        yield* next.execute("scripts.run", input);
        expect(yield* fs.readFileString(path.join(root, "repo", "count.txt"))).toBe("x");
        expect(
          yield* next
            .execute("scripts.run", { ...input, args: ["-c", "printf y >> count.txt"] })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "script_operation_conflict" });
        expect(yield* next.activity).toEqual({ activeOperations: 0, pendingCallbacks: 0 });
      }),
  );
  it.effect("refuses to replay a script with an uncertain accepted outcome", () =>
    Effect.gen(function* () {
      const { root, worker } = yield* fixture;
      const input = {
        cwd: "repo",
        operationId: "uncertain",
        command: "/nonexistent-worker-test-executable",
        args: [],
        timeoutMs: 1000,
      };
      yield* worker.execute("scripts.run", input).pipe(Effect.flip);
      const replacement = yield* makeWorkspaceExecutor({ root, incarnation: "replacement" });
      expect(yield* replacement.execute("scripts.run", input).pipe(Effect.flip)).toMatchObject({
        code: "script_outcome_unknown",
      });
    }),
  );
  it.effect("creates worktrees inside the allocation and rejects external targets", () =>
    Effect.gen(function* () {
      const { fs, path, root, worker } = yield* fixture;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const cwd = path.join(root, "repo");
      for (const args of [
        ["init"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
        ["commit", "--allow-empty", "-m", "base"],
      ])
        yield* git.execute({ operation: "test.init", cwd, args });
      yield* worker.execute("git.createWorktree", {
        cwd: "repo",
        refName: "HEAD",
        newRefName: "child-work",
        path: "checkouts/child",
      });
      expect(yield* fs.exists(path.join(root, "checkouts", "child", ".git"))).toBe(true);
      expect(
        yield* worker
          .execute("git.createWorktree", {
            cwd: "repo",
            refName: "HEAD",
            newRefName: "outside",
            path: "../outside",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_path_escape" });
    }),
  );
  it.effect(
    "prepares and discards clone contents inside the worker while protecting unrelated files and its root",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, worker } = yield* fixture;
        yield* worker.execute("workspace.prepareClone", { cwd: "clone" });
        expect(yield* fs.readDirectory(path.join(root, "clone"))).toEqual([]);
        yield* fs.writeFileString(path.join(root, "clone", "keep.txt"), "user data");
        expect(
          (yield* worker.execute("workspace.prepareClone", { cwd: "clone" }).pipe(Effect.flip))
            ._tag,
        ).toBe("WorkspaceExecutionError");
        expect(
          (yield* worker.execute("workspace.discardClone", { cwd: "clone" }).pipe(Effect.flip))
            ._tag,
        ).toBe("WorkspaceExecutionError");
        expect(yield* fs.readFileString(path.join(root, "clone", "keep.txt"))).toBe("user data");
        yield* fs.makeDirectory(path.join(root, "clone", ".git"));
        yield* worker.execute("workspace.discardClone", { cwd: "clone" });
        expect(yield* fs.readDirectory(path.join(root, "clone"))).toEqual([]);
        yield* worker.execute("workspace.discardClone", { cwd: "missing" });
        expect(yield* fs.exists(path.join(root, "missing"))).toBe(true);
        expect(
          (yield* worker.execute("workspace.discardClone", { cwd: "." }).pipe(Effect.flip))._tag,
        ).toBe("WorkspaceExecutionError");
      }),
  );
});
