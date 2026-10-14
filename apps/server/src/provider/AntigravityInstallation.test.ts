import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Installation from "./AntigravityInstallation.ts";

it.effect(
  "resolves paired image executables without spawning or installing and fails closed on missing helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "antigravity-image-" });
      const executablePath = `${root}/agy_acp_server.par`;
      const harnessPath = `${root}/localharness_external`;
      const installation = yield* Installation.AntigravityInstallation;
      expect(Exit.isFailure(yield* Effect.exit(installation.resolve("agy_acp_server.par")))).toBe(
        true,
      );
      yield* fs.writeFileString(executablePath, "never executed");
      expect(Exit.isFailure(yield* Effect.exit(installation.resolve(executablePath)))).toBe(true);
      yield* fs.writeFileString(harnessPath, "paired native helper");
      expect(Exit.isFailure(yield* Effect.exit(installation.resolve(executablePath)))).toBe(true);
      yield* fs.chmod(executablePath, 0o755);
      yield* fs.chmod(harnessPath, 0o755);
      yield* fs.writeFileString(`${root}/antigravity-version.json`, '{"version":"1.3.0"}');
      expect(yield* installation.acquire(executablePath)).toEqual({
        executablePath,
        harnessPath,
        version: "1.3.0",
      });
      expect((yield* fs.readDirectory(root)).sort()).toEqual([
        "agy_acp_server.par",
        "antigravity-version.json",
        "localharness_external",
      ]);
    }).pipe(Effect.scoped, Effect.provide(Installation.layer), Effect.provide(NodeServices.layer)),
);
