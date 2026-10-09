import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CodexInstallationError extends Schema.TaggedError<CodexInstallationError>()(
  "CodexInstallationError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export interface CodexExecutable {
  readonly executablePath: string;
  readonly source: "local";
  readonly version: string;
  readonly managedVersionDirectory: null;
}

export class CodexInstallation extends Context.Service<
  CodexInstallation,
  {
    readonly resolve: () => Effect.Effect<CodexExecutable, CodexInstallationError>;
    readonly acquire: () => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  }
>()("t3/provider/CodexInstallation") {
  static readonly layer = Layer.effect(
    CodexInstallation,
    Effect.suspend(() => makeCodexInstallation({})),
  );
}

export interface CodexInstallationOptions {
  readonly baseDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeCodexInstallation = Effect.fn("CodexInstallation.make")(function* (
  options: CodexInstallationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = options.environment ?? (yield* HostProcessEnvironment);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = new Map<string, { fingerprint: string; executable: CodexExecutable }>();
  const run = Effect.fn("CodexInstallation.probe")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(command, args).pipe(
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        shell: resolved.shell,
        env: environment,
        extendEnv: true,
      }),
    );
    const [stdout, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* new CodexInstallationError({
        operation: "resolve",
        detail: "The image's Codex executable failed its runtime probe.",
      });
    return stdout;
  }, Effect.scoped);
  const resolve = Effect.fn("CodexInstallation.resolve")(
    function* () {
      const executablePath = yield* resolveCommandPath("codex", { env: environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const realPath = yield* fs.realPath(executablePath);
      const info = yield* fs.stat(executablePath);
      const fingerprint = `${realPath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`;
      const cached = cache.get(executablePath);
      if (cached?.fingerprint === fingerprint) return cached.executable;
      const output = yield* run(executablePath, ["--version"]);
      const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u.exec(output.trim())?.[1];
      if (!version)
        return yield* new CodexInstallationError({
          operation: "resolve",
          detail: "Could not read the image's Codex version.",
        });
      yield* run(executablePath, ["app-server", "--help"]);
      const executable: CodexExecutable = {
        executablePath,
        source: "local",
        version,
        managedVersionDirectory: null,
      };
      cache.set(executablePath, { fingerprint, executable });
      return executable;
    },
    Effect.timeout("5 seconds"),
    Effect.mapError((cause) =>
      Schema.is(CodexInstallationError)(cause)
        ? cause
        : new CodexInstallationError({
            operation: "resolve",
            detail: "The execution image must supply a working Codex executable.",
            cause,
          }),
    ),
  );
  return CodexInstallation.of({ resolve, acquire: resolve });
});
