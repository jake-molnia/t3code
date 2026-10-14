import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class AntigravityInstallationError extends Schema.TaggedError<AntigravityInstallationError>()(
  "AntigravityInstallationError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly harnessPath: string;
  readonly version: string | null;
}

/** Resolves the image's paired executables. Runtime installation is never allowed. */
export class AntigravityInstallation extends Context.Service<
  AntigravityInstallation,
  {
    readonly resolve: (
      binaryPath?: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
    readonly acquire: (
      binaryPath?: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
  }
>()("t3/provider/AntigravityInstallation") {}

const Version = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }));
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolve = Effect.fn("AntigravityInstallation.resolve")(function* (binaryPath?: string) {
    const executablePath = binaryPath?.trim() || "/opt/native/bin/agy_acp_server.par";
    if (!path.isAbsolute(executablePath)) {
      return yield* new AntigravityInstallationError({
        operation: "resolve",
        detail: "Antigravity requires an absolute executable path in the sandbox image.",
      });
    }
    const directory = path.dirname(executablePath);
    const harnessPath = path.join(directory, "localharness_external");
    for (const file of [executablePath, harnessPath]) {
      yield* fs.access(file, { readable: true }).pipe(
        Effect.mapError(
          (cause) =>
            new AntigravityInstallationError({
              operation: "resolve",
              detail:
                "The sandbox image must include Antigravity and its localharness_external helper.",
              cause,
            }),
        ),
      );
      const info = yield* fs.stat(file).pipe(
        Effect.mapError(
          (cause) =>
            new AntigravityInstallationError({
              operation: "resolve",
              detail: "Could not inspect the Antigravity image executable.",
              cause,
            }),
        ),
      );
      if (info.type !== "File" || (info.mode & 0o111) === 0) {
        return yield* new AntigravityInstallationError({
          operation: "resolve",
          detail: "Antigravity image files must be executable regular files.",
        });
      }
    }
    const version = yield* fs.readFileString(path.join(directory, "antigravity-version.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Version)),
      Effect.map((record) => record.version),
      Effect.orElseSucceed(() => null),
    );
    return { executablePath, harnessPath, version };
  });
  return AntigravityInstallation.of({ resolve, acquire: resolve });
});

export const layer = Layer.effect(AntigravityInstallation, make);
