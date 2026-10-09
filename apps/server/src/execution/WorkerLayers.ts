import * as CredentialSources from "./credentialSources.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistryCatalog from "../provider/AcpRegistryCatalog.ts";
import * as ProviderEventLoggers from "../provider/ProviderEventLoggers.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../provider/OpenCodeServerLedger.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as WorkerSettings from "./WorkerSettings.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

export function workerLayers(options: { cwd: string; stateDir: string; port: number }) {
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const paths = yield* ServerConfig.deriveServerPaths(options.stateDir, undefined, {
        baseDirIsExplicit: true,
      });
      const fs = yield* FileSystem.FileSystem;
      for (const directory of [
        paths.stateDir,
        paths.attachmentsDir,
        paths.providerStatusCacheDir,
        paths.providerLogsDir,
      ])
        yield* fs.makeDirectory(directory, { recursive: true });
      return ServerConfig.make({
        ...paths,
        cwd: options.cwd,
        baseDir: options.stateDir,
        mode: "web",
        port: options.port,
        host: "0.0.0.0",
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 10485760,
        traceMaxFiles: 3,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );
  const host = Layer.effect(
    ProviderHost,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettings.ServerSettingsService;
      return ProviderHost.of({
        paths: {
          cwd: config.cwd,
          baseDir: config.baseDir,
          stateDir: config.stateDir,
          providerStatusCacheDir: config.providerStatusCacheDir,
        },
        settings: {
          get: settings.getSettings,
          changes: settings.streamChanges,
          subscribe: settings.subscribeChanges,
        },
        shouldRunBackgroundWork: () => Effect.succeed(true),
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      });
    }),
  );
  return Layer.mergeAll(
    T3ProjectFileLoader.layer,
    ProviderInfrastructure.layer,
    AcpRegistryCatalog.layer,
    host,
    ResetCreditCoordinator.layer,
    OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layer)),
    CodexInstallation.CodexInstallation.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(CredentialSources.layer),
    Layer.provideMerge(ModelManifest.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(WorkerSettings.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(NodeServices.layer),
  );
}
