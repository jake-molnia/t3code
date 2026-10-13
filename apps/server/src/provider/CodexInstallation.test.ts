import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CodexInstallation from "./CodexInstallation.ts";

it.effect("resolves and probes image Codex without creating a managed installation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const binary = path.join(directory, "codex");
    yield* fs.writeFileString(
      binary,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-cli 0.156.1; else echo app-server; fi\n',
    );
    yield* fs.chmod(binary, 0o755);
    const installation = yield* CodexInstallation.makeCodexInstallation({
      environment: { PATH: directory },
    });
    expect(yield* installation.resolve()).toMatchObject({
      executablePath: binary,
      source: "local",
      version: "0.156.1",
    });
    expect(yield* fs.readDirectory(directory)).toEqual(["codex"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails on a missing image executable without creating a download directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const installation = yield* CodexInstallation.makeCodexInstallation({
      environment: { PATH: directory },
    });
    expect(yield* installation.resolve().pipe(Effect.flip)).toBeInstanceOf(
      CodexInstallation.CodexInstallationError,
    );
    expect(yield* fs.readDirectory(directory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
