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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "worker-workspace-test-" })),
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
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "later edit");
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
