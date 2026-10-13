import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class PreviewBrowserUnavailableError extends Schema.TaggedError<PreviewBrowserUnavailableError>()(
  "PreviewBrowserUnavailableError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The sandbox browser is unavailable: ${this.detail}`;
  }
}

export class PreviewBrowser extends Context.Service<
  PreviewBrowser,
  {
    readonly executable: Effect.Effect<string, PreviewBrowserUnavailableError>;
    readonly installed: Effect.Effect<Option.Option<string>>;
  }
>()("t3/preview/PreviewBrowser") {}

/** Browser binaries and dependencies belong to the immutable worker image. */
export const makePreviewBrowser = Effect.fn("PreviewBrowser.make")(function* (executable: string) {
  const fs = yield* FileSystem.FileSystem;
  const available = fs.access(executable, { readable: true });
  return PreviewBrowser.of({
    executable: available.pipe(
      Effect.as(executable),
      Effect.mapError(
        (cause) =>
          new PreviewBrowserUnavailableError({
            detail:
              "The image is missing its configured executable. Rebuild the image or correct T3_BROWSER_EXECUTABLE.",
            cause,
          }),
      ),
    ),
    installed: available.pipe(
      Effect.as(Option.some(executable)),
      Effect.orElseSucceed(() => Option.none()),
    ),
  });
});

export const layer = Layer.effect(
  PreviewBrowser,
  Config.String("T3_BROWSER_EXECUTABLE").pipe(
    Config.withDefault("/usr/bin/chromium"),
    Effect.flatMap(makePreviewBrowser),
  ),
);
