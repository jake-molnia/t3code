import { describe, expect, it } from "vite-plus/test";

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
} from "./cli-stage.ts";

describe("standalone CLI dependency staging", () => {
  it.each(["arm64", "x64"] as const)("pins native binaries for %s archives", (arch) => {
    expect(resolveFffNativeDependencies("linux", arch, "0.11.0")).toEqual({
      [`@ff-labs/fff-bin-linux-${arch}-gnu`]: "0.11.0",
      [`@ff-labs/fff-bin-linux-${arch}-musl`]: "0.11.0",
    });
    expect(resolveFffNativeDependencies("mac", arch, "0.11.0")).toEqual({
      [`@ff-labs/fff-bin-darwin-${arch}`]: "0.11.0",
    });
    expect(resolveFffNativeDependencies("win", arch, "0.11.0")).toEqual({
      [`@ff-labs/fff-bin-win32-${arch}`]: "0.11.0",
    });
  });

  it("keeps staged dependency patches and build policy without desktop packages", () => {
    const patchedDependencies = createStagePatchedDependencies(
      {
        "@scope/native@1.0.0": "native.patch",
        "effect@4.0.2": "effect.patch",
        electron: "shell.patch",
      },
      { "@scope/native": "1.0.0", effect: "4.0.2" },
    );
    expect(patchedDependencies).toEqual({
      "@scope/native@1.0.0": "native.patch",
      "effect@4.0.2": "effect.patch",
    });
    expect(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        patchedDependencies,
        allowBuilds: { "node-pty": true },
      }),
    ).toEqual({
      supportedArchitectures: { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      patchedDependencies,
      allowBuilds: { "node-pty": true },
    });
    expect(createStageWorkspaceConfig({ platform: "mac", arch: "arm64" })).toEqual({
      supportedArchitectures: { os: ["darwin"], cpu: ["arm64"] },
    });
  });
});
