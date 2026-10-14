export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;

type Platform = "mac" | "linux" | "win";
type Arch = "arm64" | "x64";

export function resolveFffNativeDependencies(platform: Platform, arch: Arch, version: string) {
  const packages =
    platform === "mac"
      ? [`@ff-labs/fff-bin-darwin-${arch}`]
      : platform === "win"
        ? [`@ff-labs/fff-bin-win32-${arch}`]
        : ["gnu", "musl"].map((libc) => `@ff-labs/fff-bin-linux-${arch}-${libc}`);
  return Object.fromEntries(packages.map((name) => [name, version]));
}

export function createStageWorkspaceConfig(input: {
  readonly platform: Platform;
  readonly arch: Arch;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}) {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  return {
    supportedArchitectures: {
      os: [platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"],
      cpu: [arch],
      ...(platform === "linux" ? { libc: ["glibc"] } : {}),
    },
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

/** Only copy patches for packages included in the standalone CLI archive. */
export function createStagePatchedDependencies(
  patches: Record<string, string>,
  dependencies: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(patches).filter(([key]) => {
      const versionSeparator = key.lastIndexOf("@");
      const name = versionSeparator > 0 ? key.slice(0, versionSeparator) : key;
      return Object.hasOwn(dependencies, name);
    }),
  );
}
