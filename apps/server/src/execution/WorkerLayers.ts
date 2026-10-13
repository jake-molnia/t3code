import { ProviderConfigurationOverrides } from "../provider/ProviderConfigurationOverrides.ts";
import { deploymentHarnessDefaults } from "./HarnessDefaults.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import { prepareHarnessState } from "./HarnessDefaults.ts";
import * as CredentialSources from "./credentialSources.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as AgentScopeLive from "../process/agentScope.ts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as WorkerSettings from "./WorkerSettings.ts";

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
      yield* Effect.tryPromise(() => prepareHarnessState(options.stateDir));
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
  return Layer.mergeAll(
    UsageService.layer.pipe(
      Layer.provide(
        CursorUsageAccounts.layer.pipe(
          Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
        ),
      ),
    ),
    ProviderInfrastructure.layer,
    AcpRegistrySupport.layerFromHost,
    ResetCreditCoordinator.layer,
    OpenCodeRuntime.layer.pipe(
      Layer.provide(OpenCodeServerLedger.layer({ stateDir: options.stateDir })),
    ),
    CodexInstallation.CodexInstallation.layer,
  ).pipe(
    Layer.provideMerge(ProviderHostLive.layerWorker),
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(AgentScopeLive.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(CredentialSources.layer),
    Layer.provideMerge(
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
    ),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(
      Layer.effect(
        ProviderConfigurationOverrides,
        Effect.gen(function* () {
          // Config bootstraps the retained harness home before variables are expanded.
          yield* ServerConfig.ServerConfig;
          return yield* Effect.try(() => deploymentHarnessDefaults());
        }),
      ),
    ),
    Layer.provideMerge(WorkerSettings.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(NodeServices.layer),
  );
}
