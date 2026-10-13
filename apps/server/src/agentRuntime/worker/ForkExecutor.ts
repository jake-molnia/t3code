import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as Checkpoints from "../../checkpointing/CheckpointStore.ts";
import * as Config from "../../config.ts";
import * as P from "../../execution/ForkWorkspaceProtocol.ts";
import { WorkspaceExecutionError } from "./Protocol.ts";
import { blobPath } from "./AssetExecutor.ts";

const decodeExport = Schema.decodeUnknownEffect(P.ExportFork);
const decodeImport = Schema.decodeUnknownEffect(P.ImportFork);
const receiptCodec = Schema.fromJsonString(P.ForkReceipt);
const encodeReceipt = Schema.encodeEffect(receiptCodec);
const decodeReceipt = Schema.decodeUnknownEffect(receiptCodec);

export const makeForkExecutor = <E>(options: {
  resolve: (path: string, allowMissing?: boolean) => Effect.Effect<string, E>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* Git.GitVcsDriver;
    const checkpoints = yield* Checkpoints.CheckpointStore;
    const config = yield* Config.ServerConfig;
    const lock = yield* Semaphore.make(1);
    const exports = new Set<string>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        exports,
        (bundle) =>
          fs.remove(path.dirname(bundle), { recursive: true, force: true }).pipe(Effect.ignore),
        { discard: true },
      ),
    );
    const execute = (method: string, raw: unknown) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (method === "git.cleanupFork") {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ bundlePath: Schema.String }),
            )(raw);
            if (exports.has(input.bundlePath)) {
              yield* fs.remove(path.dirname(input.bundlePath), { recursive: true, force: true });
              exports.delete(input.bundlePath);
            }
            return null;
          }
          if (method === "git.bundleFork") {
            const input = yield* decodeExport(raw);
            if (
              !input.checkpointRef.startsWith("refs/t3/") &&
              !input.checkpointRef.startsWith("refs/t3code/")
            )
              return yield* new WorkspaceExecutionError({ code: "invalid_checkpoint_namespace" });
            const cwd = yield* options.resolve(input.cwd);
            const checkpoint = yield* git.execute({
              operation: "fork.checkpoint",
              cwd,
              args: ["rev-parse", "--verify", `${input.checkpointRef}^{commit}`],
            });
            const head = yield* git.execute({
              operation: "fork.head",
              cwd,
              args: ["rev-parse", "--verify", "HEAD"],
              allowNonZeroExit: true,
            });
            const branch = yield* git.execute({
              operation: "fork.branch",
              cwd,
              args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
              allowNonZeroExit: true,
            });
            const baseCommit = head.exitCode === 0 ? head.stdout.trim() : null;
            return yield* Effect.acquireUseRelease(
              Effect.gen(function* () {
                const directory = yield* fs.makeTempDirectory({ prefix: "t3-fork-bundle-" });
                const bundlePath = path.join(directory, "repository.bundle");
                exports.add(bundlePath);
                return { directory, bundlePath };
              }),
              ({ bundlePath }) =>
                Effect.gen(function* () {
                  yield* git.execute({
                    operation: "fork.bundle",
                    cwd,
                    args: [
                      "bundle",
                      "create",
                      bundlePath,
                      "--all",
                      ...(baseCommit ? ["HEAD"] : []),
                    ],
                    timeoutMs: 180_000,
                  });
                  const lfsObjects: Array<{ oid: string; path: string }> = [];
                  const seen = new Set<string>();
                  const environment = yield* git.execute({
                    operation: "fork.lfs.env",
                    cwd,
                    args: ["lfs", "env"],
                    maxOutputBytes: 64 * 1024,
                  });
                  if (environment.stdoutTruncated)
                    return yield* new WorkspaceExecutionError({ code: "lfs_metadata_truncated" });
                  const mediaDirectory = environment.stdout
                    .split("\n")
                    .find((line) => line.startsWith("LocalMediaDir="))
                    ?.slice("LocalMediaDir=".length);
                  for (const ref of new Set([
                    input.checkpointRef,
                    ...(baseCommit ? [baseCommit] : []),
                  ])) {
                    const objects = yield* git.execute({
                      operation: "fork.lfs.objects",
                      cwd,
                      args: ["lfs", "ls-files", "--long", ref],
                      maxOutputBytes: 16 * 1024 * 1024,
                    });
                    if (objects.stdoutTruncated)
                      return yield* new WorkspaceExecutionError({ code: "lfs_metadata_truncated" });
                    for (const line of objects.stdout.split("\n")) {
                      const oid = /^([a-f0-9]{64}) [*-] /.exec(line)?.[1];
                      if (!oid || seen.has(oid)) continue;
                      seen.add(oid);
                      if (!mediaDirectory)
                        return yield* new WorkspaceExecutionError({
                          code: "lfs_storage_unavailable",
                        });
                      const objectPath = path.join(
                        mediaDirectory,
                        oid.slice(0, 2),
                        oid.slice(2, 4),
                        oid,
                      );
                      // Unhydrated pointers may still resolve from the original remote on import.
                      if (yield* fs.exists(objectPath)) lfsObjects.push({ oid, path: objectPath });
                    }
                  }
                  return {
                    bundlePath,
                    ...(lfsObjects.length > 0 ? { lfsObjects } : {}),
                    checkpointRef: input.checkpointRef,
                    checkpointOid: checkpoint.stdout.trim(),
                    baseCommit,
                    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
                    origin: yield* git.readConfigValue(cwd, "remote.origin.url"),
                  } satisfies typeof P.ForkBundle.Type;
                }),
              ({ directory, bundlePath }, exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : fs.remove(directory, { recursive: true, force: true }).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          exports.delete(bundlePath);
                        }),
                      ),
                      Effect.ignore,
                    ),
            );
          }
          if (method === "git.importFork") {
            const input = yield* decodeImport(raw);
            const target = yield* options.resolve(input.cwd, true);
            const marker = path.join(target, ".git", "t3-fork.json");
            if (yield* fs.exists(target)) {
              if (!(yield* fs.exists(marker)))
                return yield* new WorkspaceExecutionError({ code: "fork_destination_exists" });
              const existing = yield* fs.readFileString(marker).pipe(Effect.flatMap(decodeReceipt));
              if (
                existing.blobId !== input.blobId ||
                existing.checkpointOid !== input.checkpointOid
              )
                return yield* new WorkspaceExecutionError({ code: "fork_destination_conflict" });
              return { cwd: input.cwd };
            }
            const bundle = blobPath(config.stateDir, input.blobId);
            const staging = `${target}.fork-staging`;
            yield* fs.remove(staging, { recursive: true, force: true });
            yield* fs.makeDirectory(path.dirname(staging), { recursive: true });
            yield* git.execute({
              operation: "fork.clone",
              cwd: config.cwd,
              args: ["clone", "--no-checkout", "--", bundle, staging],
              timeoutMs: 180_000,
            });
            yield* git.execute({
              operation: "fork.fetch-checkpoint",
              cwd: staging,
              args: ["fetch", "--", bundle, `${input.checkpointRef}:${input.checkpointRef}`],
            });
            const imported = yield* git.execute({
              operation: "fork.verify-checkpoint",
              cwd: staging,
              args: ["rev-parse", "--verify", `${input.checkpointRef}^{commit}`],
            });
            if (imported.stdout.trim() !== input.checkpointOid)
              return yield* new WorkspaceExecutionError({ code: "fork_checkpoint_mismatch" });
            if (input.origin)
              yield* git.execute({
                operation: "fork.origin",
                cwd: staging,
                args: ["remote", "set-url", "origin", input.origin],
              });
            else
              yield* git.execute({
                operation: "fork.origin",
                cwd: staging,
                args: ["remote", "remove", "origin"],
              });
            for (const oid of input.lfsObjects ?? []) {
              const destination = path.join(
                staging,
                ".git",
                "lfs",
                "objects",
                oid.slice(0, 2),
                oid.slice(2, 4),
                oid,
              );
              yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
              yield* fs.copyFile(blobPath(config.stateDir, oid), destination);
            }
            if (input.baseCommit)
              yield* git.execute({
                operation: "fork.checkout-base",
                cwd: staging,
                args: input.branch
                  ? ["checkout", "-B", input.branch, input.baseCommit]
                  : ["checkout", "--detach", input.baseCommit],
              });
            else if (input.branch)
              yield* git.execute({
                operation: "fork.unborn-branch",
                cwd: staging,
                args: ["symbolic-ref", "HEAD", `refs/heads/${input.branch}`],
              });
            // Checkpoints contain a file tree, not historical HEAD/index metadata. Keep the source Git base.
            yield* checkpoints.restoreCheckpoint({
              cwd: staging,
              checkpointRef: input.checkpointRef,
              fallbackToHead: false,
            });
            yield* fs.writeFileString(
              path.join(staging, ".git", "t3-fork.json"),
              yield* encodeReceipt({ blobId: input.blobId, checkpointOid: input.checkpointOid }),
              { mode: 0o600 },
            );
            yield* fs.rename(staging, target);
            return { cwd: input.cwd };
          }
          return yield* new WorkspaceExecutionError({ code: "unsupported_fork_method" });
        }),
      );
    return { execute };
  });
