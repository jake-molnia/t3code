import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";

export const Platform = Context.Reference<NodeJS.Platform>("@t3tools/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const Hostname = Context.Reference<string>("@t3tools/shared/HostProcess/Hostname", {
  defaultValue: () => NodeOS.hostname(),
});

export const HomeDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/HomeDirectory",
  {
    defaultValue: () => NodeOS.homedir(),
  },
);

export const Environment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/HostProcess/Environment",
  {
    defaultValue: () => process.env,
  },
);

export const WorkingDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/WorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const ExecutablePath = Context.Reference<string>(
  "@t3tools/shared/HostProcess/ExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const Arguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/HostProcess/Arguments",
  {
    defaultValue: () => process.argv,
  },
);

/**
 * Whether this process is a Node single-executable rather than a script run
 * by a Node on the machine. Code that needs a sibling file or a Node to run
 * one branches on this: an executable hosts such things as hidden
 * subcommands of itself.
 */
export const IsExecutable = Context.Reference<boolean>("@t3tools/shared/HostProcess/IsExecutable", {
  defaultValue: () => NodeSea.isSea(),
});

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");
