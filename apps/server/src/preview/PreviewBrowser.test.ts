import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as PreviewBrowser from "./PreviewBrowser.ts";

it.effect("uses an existing image executable without creating installation state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const executable = path.join(directory, "chromium");
    yield* fs.writeFileString(executable, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(executable, 0o755);
    const browser = yield* PreviewBrowser.makePreviewBrowser(executable);
    expect(yield* browser.installed).toEqual(Option.some(executable));
    expect(yield* browser.executable).toBe(executable);
    expect(yield* fs.readDirectory(directory)).toEqual(["chromium"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing image executable without downloading or creating files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const browser = yield* PreviewBrowser.makePreviewBrowser(path.join(directory, "missing"));
    expect(yield* browser.installed).toEqual(Option.none());
    const error = yield* browser.executable.pipe(Effect.flip);
    expect(error._tag).toBe("PreviewBrowserUnavailableError");
    expect(error.message).toContain("T3_BROWSER_EXECUTABLE");
    expect(yield* fs.readDirectory(directory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
