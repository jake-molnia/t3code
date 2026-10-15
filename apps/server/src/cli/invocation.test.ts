import packageJson from "../../package.json" with { type: "json" };
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { formatCliCommand, resolveRootCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs", "npx t3 serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      "npx t3 serve",
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs", "pnpm dlx t3 serve"],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/t3/dist/bin.mjs",
      "pnpm dlx t3 serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      "pnpm dlx t3 serve",
    ],
    ["/home/theo/.bun/install/cache/t3@0.0.31/dist/bin.mjs", "bunx t3 serve"],
    ["/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs", "bunx t3 serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-t3@latest\\node_modules\\t3\\dist\\bin.mjs",
      "bunx t3 serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/t3/dist/bin.mjs",
    "/home/theo/Code/work/t3code/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/t3/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "t3 serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx t3@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx t3@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx t3 serve"],
    ["0.0.31", "npx t3 serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx t3@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx t3 serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "t3 serve",
  );
});

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  /** `sudo t3 browser setup` as this process would render it, with `t3` on PATH or not. */
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  /** A directory holding an executable `t3`, to stand in for one on PATH. */
  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "t3"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        `sudo ${formatCliCommand({ subcommand: "browser setup", entryPath: npx, version: packageJson.version })}`,
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe(
        `sudo env "PATH=$PATH" ${formatCliCommand({ subcommand: "browser setup", entryPath: npx, version: packageJson.version })}`,
      );
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/t3/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe('sudo env "PATH=$PATH" t3 browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when t3 is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "t3");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { T3CODE_CLI_PATH: shim },
      };
      // The desktop app's shim, quoted for the shell and run as root as is.
      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);
      // A `t3` the person put on PATH still wins.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        'sudo env "PATH=$PATH" t3 browser setup',
      );
      // A standalone binary names itself.
      expect(
        yield* rootCommand({
          node: "/opt/t3/t3",
          entry: "/opt/t3/t3",
          executable: true,
        }),
      ).toBe("sudo /opt/t3/t3 browser setup");
      // A stale shim path, then no launcher at all, fall back to plain `t3`.
      expect(
        yield* rootCommand({ ...desktop, env: { T3CODE_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" t3 browser setup');
    }).pipe(Effect.scoped),
  );
});
