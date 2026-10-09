import { GitCommandError } from "@t3tools/contracts";
import type * as Scope from "effect/Scope";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export class RepositoryFiles extends Context.Service<
  RepositoryFiles,
  {
    readonly temporaryDirectory: Effect.Effect<string, GitCommandError, Scope.Scope>;
    readonly readInstructions: (cwd: string, fileName: string) => Effect.Effect<string>;
    readonly canonicalizeExistingPath: (cwd: string) => Effect.Effect<string>;
  }
>()("t3/git/RepositoryFiles") {}

export const layer = Layer.effect(
  RepositoryFiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return RepositoryFiles.of({
      temporaryDirectory: fs.makeTempDirectoryScoped({ prefix: "t3-source-control-" }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "temporaryDirectory",
              cwd: ".",
              command: "git",
              detail: "Could not prepare temporary repository.",
              cause,
            }),
        ),
      ),
      readInstructions: (cwd, fileName) =>
        Effect.gen(function* () {
          const root = yield* fs.realPath(cwd);
          const target = yield* fs.realPath(path.join(root, fileName));
          if (!target.startsWith(`${root}${path.sep}`)) return "";
          const stat = yield* fs.stat(target);
          if (stat.type !== "File" || stat.size > ByteSize.bytes(20_000)) return "";
          return (yield* fs.readFileString(target)).trim();
        }).pipe(Effect.orElseSucceed(() => "")),
      canonicalizeExistingPath: (cwd) => fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd)),
    });
  }),
);
