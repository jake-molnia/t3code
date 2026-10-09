import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as Option from "effect/Option";
import { validateCloneSourceUrl } from "../RepositoryUrl.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as C from "@t3tools/contracts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as P from "./Protocol.ts";

const decodeCloneDirectory = Schema.decodeUnknownEffect(
  Schema.Struct({ cwd: Schema.NonEmptyString }),
);

export const makeWorkspaceExecutor = (options: {
  root: string;
  incarnation: string;
  /** Must include provider/background work and shared-checkout ownership. */
  canRestore?: Effect.Effect<boolean>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const entries = yield* WorkspaceEntries.WorkspaceEntries;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const processes = yield* ProcessRunner.ProcessRunner;
    const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
    const root = yield* fs.realPath(options.root);
    const checkpointLock = yield* Semaphore.make(1);
    const scriptLock = yield* Semaphore.make(1);
    let activeOperations = 0;
    const hash = (value: unknown) =>
      crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))).pipe(
        Effect.map((bytes) =>
          Array.from(bytes)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ),
      );
    const relative = (value: string) =>
      Effect.gen(function* () {
        if (
          path.isAbsolute(value) ||
          /^[A-Za-z]:/.test(value) ||
          value.includes("\\") ||
          value.split("/").includes("..") ||
          value.split("/").includes(".t3-worker")
        )
          return yield* new P.WorkspaceExecutionError({ code: "workspace_path_escape" });
        return value;
      });
    const withinRoot = (value: string) => {
      const remainder = path.relative(root, value);
      return (
        remainder !== ".." && !remainder.startsWith(`..${path.sep}`) && !path.isAbsolute(remainder)
      );
    };
    const resolve = (value: string, allowMissing = false) =>
      Effect.gen(function* () {
        const requested = path.resolve(root, yield* relative(value));
        let existing = requested;
        if (allowMissing) while (!(yield* fs.exists(existing))) existing = path.dirname(existing);
        const canonical = yield* fs.realPath(existing);
        if (!withinRoot(canonical))
          return yield* new P.WorkspaceExecutionError({ code: "workspace_symlink_escape" });
        return requested;
      });
    const safeCheckpoint = (ref: C.CheckpointRef) =>
      Effect.gen(function* () {
        if (!ref.startsWith("refs/t3/") && !ref.startsWith("refs/t3code/"))
          return yield* new P.WorkspaceExecutionError({ code: "invalid_checkpoint_namespace" });
        return ref;
      });
    const capture = (input: typeof P.Checkpoint.Type) =>
      checkpointLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = yield* resolve(input.cwd);
          const checkpointRef = yield* safeCheckpoint(input.checkpointRef);
          if (!(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef })))
            yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
          const commit = yield* git.execute({
            operation: "worker.checkpoint.resolve",
            cwd,
            args: ["rev-parse", "--verify", `${checkpointRef}^{commit}`],
          });
          return { checkpointRef, oid: commit.stdout.trim() };
        }),
      );
    const script = (input: typeof P.Script.Type) =>
      scriptLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = yield* resolve(input.cwd);
          const directory = path.join(root, ".t3-worker", "script-receipts");
          yield* fs.makeDirectory(directory, { recursive: true });
          const receiptPath = path.join(directory, `${yield* hash(input.operationId)}.json`);
          const fingerprint = yield* hash(input);
          if (yield* fs.exists(receiptPath)) {
            const text = yield* fs.readFileString(receiptPath);
            const receipt = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(P.ScriptReceipt),
            )(text);
            if (receipt.fingerprint !== fingerprint)
              return yield* new P.WorkspaceExecutionError({ code: "script_operation_conflict" });
            if (receipt.kind === "started")
              return yield* new P.WorkspaceExecutionError({ code: "script_outcome_unknown" });
            return receipt.result;
          }
          yield* fs.writeFileString(
            receiptPath,
            yield* Schema.encodeEffect(Schema.fromJsonString(P.ScriptReceipt))({
              kind: "started",
              fingerprint,
              incarnation: options.incarnation,
            }),
            { flag: "wx", mode: 0o600 },
          );
          const result = yield* processes.run({
            command: input.command,
            args: input.args,
            ...(input.env ? { env: { ...input.env } } : {}),
            cwd,
            timeout: input.timeoutMs,
            maxOutputBytes: 1024 * 1024,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          });
          const temporary = `${receiptPath}.${yield* hash(options.incarnation)}.tmp`;
          yield* fs.writeFileString(
            temporary,
            yield* Schema.encodeEffect(Schema.fromJsonString(P.ScriptReceipt))({
              kind: "completed",
              fingerprint,
              result,
            }),
            { mode: 0o600 },
          );
          yield* fs.rename(temporary, receiptPath);
          return result;
        }),
      );
    const execute = (method: string, raw: unknown) =>
      Effect.gen(function* () {
        switch (method) {
          case "workspace.prepareClone":
          case "workspace.discardClone": {
            const input = yield* decodeCloneDirectory(raw);
            const target = yield* resolve(input.cwd, true);
            if (target === root)
              return yield* new P.WorkspaceExecutionError({ code: "workspace_root_protected" });
            const contents = (yield* fs.exists(target)) ? yield* fs.readDirectory(target) : [];
            if (method === "workspace.prepareClone") {
              if (contents.length)
                return yield* new P.WorkspaceExecutionError({
                  code: "clone_destination_not_empty",
                });
              yield* fs.makeDirectory(target, { recursive: true });
            } else {
              if (contents.length && !contents.includes(".git"))
                return yield* new P.WorkspaceExecutionError({
                  code: "clone_destination_has_foreign_files",
                });
              yield* fs
                .remove(target, { recursive: true, force: true })
                .pipe(
                  Effect.andThen(fs.makeDirectory(target, { recursive: true })),
                  Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
                );
            }
            return null;
          }
          case "workspace.isEmpty": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ cwd: Schema.NonEmptyString }),
            )(raw);
            return (yield* fs.readDirectory(yield* resolve(input.cwd))).every(
              (entry) => entry === ".git",
            );
          }
          case "workspace.prepare": {
            return yield* checkpointLock.withPermits(1)(
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(P.PrepareWorkspace)(raw);
                const target = yield* resolve(input.cwd, true);
                const sourceUrl = input.sourceUrl;
                if (sourceUrl) yield* Effect.try(() => validateCloneSourceUrl(sourceUrl));
                if (input.sourceUrl && !/^(https:\/\/|ssh:\/\/|git@[^:]+:)/.test(input.sourceUrl))
                  return yield* new P.WorkspaceExecutionError({
                    code: "remote_repository_url_required",
                  });
                if (!(yield* fs.exists(path.join(target, ".git")))) {
                  if (input.sourceUrl) {
                    const staging = path.join(root, ".t3-worker", "clones", yield* hash(input.cwd));
                    yield* fs.makeDirectory(path.dirname(staging), { recursive: true });
                    yield* fs.remove(staging, { recursive: true, force: true });
                    yield* git.execute({
                      operation: "worker.clone",
                      cwd: root,
                      args: ["clone", "--", input.sourceUrl, staging],
                      timeoutMs: 180_000,
                    });
                    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
                    yield* fs.rename(staging, target);
                  } else {
                    yield* fs.makeDirectory(target, { recursive: true });
                    yield* git.initRepo({ cwd: target });
                  }
                } else if (input.sourceUrl) {
                  const origin = yield* git.readConfigValue(target, "remote.origin.url");
                  if (origin !== input.sourceUrl)
                    return yield* new P.WorkspaceExecutionError({
                      code: "repository_source_conflict",
                    });
                }
                if (input.branch) {
                  const branches = yield* git.listLocalBranchNames(target);
                  if (!branches.includes(input.branch)) {
                    if (input.refName)
                      yield* git.switchRef({ cwd: target, refName: input.refName });
                    yield* git.createRef({ cwd: target, refName: input.branch });
                  }
                  yield* git.switchRef({ cwd: target, refName: input.branch });
                } else if (input.refName)
                  yield* git.switchRef({ cwd: target, refName: input.refName });
                if (yield* fs.exists(path.join(target, ".gitmodules"))) {
                  const file = yield* projectFiles.load(target);
                  const mode = resolveProjectFileBackedSetting(
                    "worktreeSubmodules",
                    input.submodules ?? null,
                    Option.getOrNull(file),
                  ).value;
                  if (mode !== "none")
                    yield* git
                      .execute({
                        operation: "worker.prepare.submodules",
                        cwd: target,
                        args:
                          mode === "recursive"
                            ? ["submodule", "update", "--init", "--recursive"]
                            : ["submodule", "update", "--init"],
                        timeoutMs: 180_000,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("Sandbox submodule initialization failed", { cause }),
                        ),
                      );
                }
                return { cwd: input.cwd };
              }),
            );
          }

          case "files.refresh": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ cwd: Schema.NonEmptyString }),
            )(raw);
            yield* entries.refresh(yield* resolve(input.cwd));
            return null;
          }
          case "files.browse": {
            const input = yield* Schema.decodeUnknownEffect(C.FilesystemBrowseInput)(raw);
            if (!input.cwd)
              return yield* new P.WorkspaceExecutionError({ code: "workspace_cwd_required" });
            yield* relative(input.partialPath);
            const cwd = yield* resolve(input.cwd);
            yield* resolve(path.join(input.cwd, input.partialPath), true);
            return yield* entries.browse({ ...input, cwd, partialPath: `./${input.partialPath}` });
          }
          case "git.isRepository": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ cwd: Schema.NonEmptyString }),
            )(raw);
            return yield* checkpoints.isGitRepository(yield* resolve(input.cwd));
          }
          case "git.hasCheckpoint": {
            const input = yield* Schema.decodeUnknownEffect(P.Checkpoint)(raw);
            return yield* checkpoints.hasCheckpointRef({
              cwd: yield* resolve(input.cwd),
              checkpointRef: yield* safeCheckpoint(input.checkpointRef),
            });
          }
          case "git.deleteCheckpoints": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                cwd: Schema.NonEmptyString,
                checkpointRefs: Schema.Array(C.CheckpointRef),
              }),
            )(raw);
            for (const ref of input.checkpointRefs) yield* safeCheckpoint(ref);
            yield* checkpoints.deleteCheckpointRefs({ ...input, cwd: yield* resolve(input.cwd) });
            return null;
          }
          case "files.read": {
            const input = yield* Schema.decodeUnknownEffect(C.ProjectReadFileInput)(raw);
            if (path.isAbsolute(input.relativePath)) {
              const canonical = yield* fs.realPath(input.relativePath);
              const temporary = yield* fs.realPath("/tmp");
              const rel = path.relative(temporary, canonical);
              if (
                !withinRoot(canonical) &&
                (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
              )
                return yield* new P.WorkspaceExecutionError({ code: "workspace_path_escape" });
            } else yield* relative(input.relativePath);
            return yield* files.readFile({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "files.write": {
            const input = yield* Schema.decodeUnknownEffect(C.ProjectWriteFileInput)(raw);
            yield* relative(input.relativePath);
            return yield* files.writeFile({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "files.list": {
            const input = yield* Schema.decodeUnknownEffect(C.ProjectListEntriesInput)(raw);
            if (input.directoryPath !== undefined) {
              yield* relative(input.directoryPath);
              yield* resolve(path.join(input.cwd, input.directoryPath));
            }
            return yield* entries.list({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "files.search": {
            const input = yield* Schema.decodeUnknownEffect(C.ProjectSearchEntriesInput)(raw);
            return yield* entries.search({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "files.searchContents": {
            const input = yield* Schema.decodeUnknownEffect(C.ProjectSearchContentsInput)(raw);
            return yield* entries.searchContents({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.listRefs": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsListRefsInput)(raw);
            return yield* git.listRefs({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.pull": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsStatusInput)(raw);
            return yield* git.pullCurrentBranch(yield* resolve(input.cwd));
          }
          case "git.createRef": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsCreateRefInput)(raw);
            return yield* git.createRef({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.switchRef": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsSwitchRefInput)(raw);
            return yield* git.switchRef({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.init": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsInitInput)(raw);
            yield* git.initRepo({ ...input, cwd: yield* resolve(input.cwd) });
            return null;
          }
          case "git.diffFileContents": {
            const input = yield* Schema.decodeUnknownEffect(C.ReviewDiffFileContentsInput)(raw);
            return yield* git.getReviewDiffFileContents({
              ...input,
              cwd: yield* resolve(input.cwd),
            });
          }
          case "git.status": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsStatusInput)(raw);
            return yield* git.status({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.diff": {
            const input = yield* Schema.decodeUnknownEffect(C.ReviewDiffPreviewInput)(raw);
            if (input.file) {
              yield* relative(input.file.path);
              if (input.file.previousPath) yield* relative(input.file.previousPath);
            }
            return yield* git.getReviewDiffPreview({ ...input, cwd: yield* resolve(input.cwd) });
          }
          case "git.removeWorktree": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsRemoveWorktreeInput)(raw);
            yield* git.removeWorktree({
              ...input,
              cwd: yield* resolve(input.cwd),
              path: yield* resolve(input.path),
            });
            return null;
          }
          case "git.createWorktree": {
            const input = yield* Schema.decodeUnknownEffect(C.VcsCreateWorktreeInput)(raw);
            if (input.path === null)
              return yield* new P.WorkspaceExecutionError({
                code: "explicit_worktree_path_required",
              });
            return yield* git.createWorktree({
              ...input,
              cwd: yield* resolve(input.cwd),
              path: yield* resolve(input.path, true),
            });
          }
          case "git.captureCheckpoint":
            return yield* capture(yield* Schema.decodeUnknownEffect(P.Checkpoint)(raw));
          case "git.restore": {
            const input = yield* Schema.decodeUnknownEffect(P.RestoreCheckpoint)(raw);
            if (!input.isolated || !options.canRestore || !(yield* options.canRestore))
              return yield* new P.WorkspaceExecutionError({
                code: "shared_workspace_restore_denied",
              });
            return yield* checkpointLock.withPermits(1)(
              checkpoints.restoreCheckpoint({
                cwd: yield* resolve(input.cwd),
                checkpointRef: yield* safeCheckpoint(input.checkpointRef),
                fallbackToHead: false,
              }),
            );
          }
          case "git.diffCheckpoints": {
            const input = yield* Schema.decodeUnknownEffect(P.CheckpointDiff)(raw);
            return yield* checkpoints.diffCheckpoints({
              ...input,
              cwd: yield* resolve(input.cwd),
              fromCheckpointRef: yield* safeCheckpoint(input.fromCheckpointRef),
              toCheckpointRef: yield* safeCheckpoint(input.toCheckpointRef),
            });
          }
          case "scripts.settle":
          case "scripts.run":
            return yield* script(yield* Schema.decodeUnknownEffect(P.Script)(raw));
          default:
            return yield* new P.WorkspaceExecutionError({ code: "unsupported_workspace_method" });
        }
      });
    return {
      execute: (method: string, raw: unknown) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            activeOperations++;
          }),
          () => execute(method, raw),
          () =>
            Effect.sync(() => {
              activeOperations--;
            }),
        ),
      activity: Effect.sync(() => ({ activeOperations, pendingCallbacks: 0 })),
      resolve,
    };
  });
