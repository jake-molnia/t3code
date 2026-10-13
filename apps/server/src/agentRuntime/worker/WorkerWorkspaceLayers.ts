import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as Net from "@t3tools/shared/Net";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

const terminals = Layer.effect(
  TerminalManager.TerminalManager,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const ptyAdapter = yield* PtyAdapter.PtyAdapter;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const ports = yield* PortScanner.PortDiscovery;
    return yield* TerminalManager.makeWithOptions({
      logsDir: config.terminalLogsDir,
      ptyAdapter,
      registerTerminalProcesses: ports.registerTerminalProcesses,
      unregisterTerminal: ports.unregisterTerminal,
      resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
        TerminalManager.resolveProviderInstanceTerminalEnvironment({
          serverSettings,
          path,
          rawProviderInstanceId,
          env,
        }),
    });
  }),
);

/** Compose over workerLayers: native services and file-backed settings, without SQLite. */
export const layer = Layer.mergeAll(
  WorkspaceFileSystem.layer,
  GitVcsDriver.layer,
  CheckpointStore.layer,
  terminals,
).pipe(
  Layer.provideMerge(PortScanner.layer.pipe(Layer.provide(Net.layer))),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ProjectFaviconResolver.layer),
  Layer.provideMerge(WorkspaceEntries.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provide(NodePtyAdapter.layer),
);
