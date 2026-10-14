import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

/** Whether an operator explicitly allowed Chrome to run without its sandbox. */
export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  {},
) {
  override get message(): string {
    return "The worker cannot start Chromium sandboxing. Check the sandbox pod security context and the node user-namespace policy.";
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The worker image is missing browser libraries (${this.libraries.join(", ")}). Rebuild the worker image with these dependencies.`;
  }
}

export type PreviewBrowserHostError = PreviewBrowserSandboxError | PreviewBrowserLibrariesError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;

/**
 * After a launch fails, names the host setup it is missing: the sandbox, from
 * Chrome's own abort message, or shared libraries, from `ldd`. Undefined when
 * neither explains it. Linux only; other hosts never need either.
 */
export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: { readonly executable: string; readonly output: string }) {
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      return new PreviewBrowserSandboxError({});
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const starts = yield* spawner
      .exitCode(
        ChildProcess.make(input.executable, ["--version"], { stdin: "ignore", stderr: "ignore" }),
      )
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => -1),
      );
    if (starts === 0) return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0 ? undefined : new PreviewBrowserLibrariesError({ libraries });
  },
);

/** Shared libraries the loader cannot find for `executable`, by `ldd`. */
const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const report = yield* spawner
    .string(ChildProcess.make("ldd", [executable], { stdin: "ignore", stderr: "ignore" }))
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return [...report.matchAll(MISSING_LIBRARY)].map((match) => match[1]!);
});
