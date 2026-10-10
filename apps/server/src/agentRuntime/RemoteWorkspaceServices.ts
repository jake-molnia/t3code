import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as WorkspaceRouting from "./WorkspaceRouting.ts";
import { AuthoredPaths } from "./worker/Protocol.ts";

const decodeAuthoredPaths = Schema.decodeUnknownEffect(AuthoredPaths);

export const fileSystemLayer = Layer.effect(
  WorkspaceFileSystem.WorkspaceFileSystem,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    return WorkspaceFileSystem.WorkspaceFileSystem.of({
      readFile: (input) =>
        routes.call({ cwd: input.cwd, method: "files.read", input: { ...input } }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(C.ProjectReadFileResult)),
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: input.relativePath,
                operationPath: input.relativePath,
                operation: "read",
                cause,
              }),
          ),
        ),
      writeFile: (input) =>
        routes.call({ cwd: input.cwd, method: "files.write", input: { ...input } }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(C.ProjectWriteFileResult)),
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: input.relativePath,
                operationPath: input.relativePath,
                operation: "write-file",
                cause,
              }),
          ),
        ),
    });
  }),
);
export const entriesLayer = Layer.effect(
  WorkspaceEntries.WorkspaceEntries,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const failure = (cwd: string) => (cause: unknown) =>
      new WorkspaceEntries.WorkspaceEntriesReadDirectoryError({
        cwd,
        partialPath: cwd,
        parentPath: cwd,
        cause,
      });
    return WorkspaceEntries.WorkspaceEntries.of({
      list: (input) =>
        routes
          .call({ cwd: input.cwd, method: "files.list", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(C.ProjectListEntriesResult)),
            Effect.mapError(failure(input.cwd)),
          ),
      search: (input) =>
        routes
          .call({ cwd: input.cwd, method: "files.search", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(C.ProjectSearchEntriesResult)),
            Effect.mapError(failure(input.cwd)),
          ),
      searchContents: (input) =>
        routes
          .call({ cwd: input.cwd, method: "files.searchContents", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(C.ProjectSearchContentsResult)),
            Effect.mapError(failure(input.cwd)),
          ),
      browse: (input) =>
        routes
          .call({
            cwd: input.cwd ?? input.partialPath,
            method: "files.browse",
            input: { ...input },
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(C.FilesystemBrowseResult)),
            Effect.mapError(failure(input.cwd ?? "")),
          ),
      refresh: (cwd) =>
        routes.call({ cwd, method: "files.refresh", input: {} }).pipe(Effect.asVoid, Effect.ignore),
    });
  }),
);
export const checkpointLayer = Layer.effect(
  CheckpointStore.CheckpointStore,
  Effect.gen(function* () {
    const routes = yield* WorkspaceRouting.WorkspaceRouting;
    const failure = (operation: string) => (cause: unknown) =>
      new C.VcsUnsupportedOperationError({
        operation,
        kind: "git",
        detail: `Remote checkpoint operation failed: ${String(cause)}`,
      });
    return CheckpointStore.CheckpointStore.of({
      listAuthoredPaths: (input) =>
        routes.call({ cwd: input.cwd, method: "git.listAuthoredPaths", input: { ...input } }).pipe(
          Effect.flatMap(decodeAuthoredPaths),
          Effect.map((paths) => (paths === null ? null : new Set(paths))),
          Effect.mapError(failure("listAuthoredPaths")),
        ),
      isGitRepository: (cwd) =>
        routes
          .call({ cwd, method: "git.isRepository", input: {} })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
            Effect.mapError(failure("isGitRepository")),
          ),
      hasCheckpointRef: (input) =>
        routes
          .call({ cwd: input.cwd, method: "git.hasCheckpoint", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
            Effect.mapError(failure("hasCheckpointRef")),
          ),
      captureCheckpoint: (input) =>
        routes
          .call({ cwd: input.cwd, method: "git.captureCheckpoint", input: { ...input } })
          .pipe(Effect.asVoid, Effect.mapError(failure("captureCheckpoint"))),
      restoreCheckpoint: (input) =>
        routes
          .call({ cwd: input.cwd, method: "git.restore", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
            Effect.mapError(failure("restoreCheckpoint")),
          ),
      diffCheckpoints: (input) =>
        routes
          .call({ cwd: input.cwd, method: "git.diffCheckpoints", input: { ...input } })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
            Effect.mapError(failure("diffCheckpoints")),
          ),
      deleteCheckpointRefs: (input) =>
        routes
          .call({ cwd: input.cwd, method: "git.deleteCheckpoints", input: { ...input } })
          .pipe(Effect.asVoid, Effect.mapError(failure("deleteCheckpointRefs"))),
    });
  }),
);
