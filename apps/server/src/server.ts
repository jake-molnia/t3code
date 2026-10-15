import * as McpConnections from "./mcp/McpConnections.ts";
import * as ExecutorRuntime from "./mcp/ExecutorRuntime.ts";
import * as ServerVersion from "./environment/ServerVersion.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import * as RemoteUsageHistory from "./agentRuntime/UsageHistory.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as RemoteProjectMetadata from "./agentRuntime/RemoteProjectMetadata.ts";
import * as RemoteAssets from "./agentRuntime/RemoteAssets.ts";
import * as LifecyclePolicy from "./agentRuntime/LifecyclePolicy.ts";
import * as AttachmentStaging from "./agentRuntime/AttachmentStaging.ts";
import * as RemoteWorkspacePreview from "./agentRuntime/RemoteWorkspacePreview.ts";
import * as SandboxComputer from "./computer/SandboxComputer.ts";
import * as SandboxIde from "./agentRuntime/SandboxIde.ts";
import * as SandboxIdeHttp from "./agentRuntime/sandboxIdeHttp.ts";
import * as RemoteWorkspaceTerminals from "./agentRuntime/RemoteWorkspaceTerminals.ts";
import * as RemoteWorkspaceGitStatus from "./agentRuntime/RemoteWorkspaceGitStatus.ts";
import * as RemoteRestoreSafety from "./agentRuntime/RestoreSafety.ts";
import * as WorkspaceRouting from "./agentRuntime/WorkspaceRouting.ts";
import * as RemoteWorkspace from "./agentRuntime/RemoteWorkspaceServices.ts";
import * as AgentRuntimeClient from "./agentRuntime/RuntimeClient.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { EnvironmentHttpApi, type RepositoryIdentity } from "@t3tools/contracts";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import { withUntracedRequests } from "./http.ts";
import * as ServerHttp from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as PullRequestHttp from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as ServerBrowserStream from "./preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";

import * as ServerSettings from "./serverSettings.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as RemoteGitDriver from "./agentRuntime/RemoteGitDriver.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as RemoteVcsProcess from "./agentRuntime/RemoteVcsProcess.ts";
import * as CredentialBroker from "./execution/CredentialBroker.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as Observability from "./observability/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as RelayDeliveryProof from "./scheduledTasks/RelayDeliveryProof.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as UsageService from "./usage/UsageService.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ResourceCleanupService from "./orchestration-v2/ResourceCleanupService.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as ProjectHttp from "./project/http.ts";
import * as NetService from "@t3tools/shared/Net";
import * as ServerActivation from "./serverActivation.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerResourceAttribution = ResourceAttribution.layer;
const layerApplicationObservability = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(layerResourceAttribution),
);

// One rotating store behind both logger views, so driver instances never race
// its rotation. Diagnostics must not block startup: a store that cannot open
// degrades to the no-op loggers.
const layerProviderEventLoggers = Layer.effect(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

const layerPtyAdapter = NodePtyAdapter.layer;

const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(layerNativeTelemetry),
);

const layerBackground = BackgroundPolicy.layer.pipe(Layer.provideMerge(layerServerSettings));

const layerResourceDiagnostics = Layer.mergeAll(
  HostResources.layer,
  layerResourceTelemetry,
  ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      // Negotiate permessage-deflate with clients that offer it; clients
      // that don't still get uncompressed frames on their connection.
      // Context takeover stays enabled (ws default) so the compression
      // window is shared across frames — that also makes small frames cheap
      // to compress, so no size threshold is set (ws only honors
      // `threshold` when context takeover is disabled).
      websocket: { perMessageDeflate: true },
    });
  }),
);

const layerPlatformServices = NodeServices.layer;

const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));
const layerUsageHistory = RemoteUsageHistory.layer.pipe(Layer.provide(layerPersistence));
const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AntigravityUsage.layer,
      CursorUsageAccounts.layer.pipe(
        Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
      ),
    ).pipe(Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer)))),
  ),
  Layer.provide(RemoteUsageHistory.sourcesLayer.pipe(Layer.provide(layerUsageHistory))),
  Layer.provide(layerServerSettings),
);

const layerAgentRuntime = AgentRuntimeClient.layer.pipe(Layer.provide(layerPersistence));
const layerWorkspaceRouting = WorkspaceRouting.layer.pipe(
  Layer.provide(layerAgentRuntime),
  Layer.provide(layerPersistence),
);
const layerRemoteAssets = RemoteAssets.layer.pipe(
  Layer.provide(layerWorkspaceRouting),
  Layer.provide(layerAgentRuntime),
);

const layerRemoteGit = RemoteGitDriver.layer.pipe(Layer.provide(layerWorkspaceRouting));
const layerVcsDriverRegistry = RemoteGitDriver.registryLayer.pipe(
  Layer.provide(layerRemoteGit),
  Layer.provide(layerWorkspaceRouting),
);
const layerRemoteVcsProcess = RemoteVcsProcess.layer.pipe(
  Layer.provide(layerWorkspaceRouting),
  Layer.provide(layerAgentRuntime),
);

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(layerRemoteGit),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerRepositoryIdentityResolver = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      // Each host that can refine an identity gets a turn; the first one that changes it wins.
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const kind of SourceControlBuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS.map(
          (driver) => driver.kind,
        )) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  // Where the viewed-file marks live for a host that keeps none of its own.
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

const layerGitManager = GitManager.layer.pipe(
  // Per-project git settings resolve the acting thread's project.
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(layerRemoteGit),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
);

const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(layerRemoteGit),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(layerRemoteGit),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provideMerge(layerRemoteGit),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(RemoteWorkspaceGitStatus.layer.pipe(Layer.provide(layerGitWorkflow))),
);

const layerCheckpointStore = RemoteWorkspace.checkpointLayer;

const layerTerminal = RemoteWorkspaceTerminals.layer;

const layerPreview = RemoteWorkspacePreview.managerLayer;

const layerWorkspaceEntries = RemoteWorkspace.entriesLayer;

const layerWorkspaceFileSystem = RemoteWorkspace.fileSystemLayer;

const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
);

const layerProjectFaviconResolver = RemoteProjectMetadata.faviconLayer.pipe(
  Layer.provide(layerRemoteAssets),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(RemoteProjectMetadata.projectFileLayer),
);

const layerServerEnvironment = ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(ResourceCleanupService.layer),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const layerOrchestrationApplication = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerOrchestrationV2Runtime),
);

// Automatic thread settlement (#8600): a server-owned sweep evaluates
// inactivity and merged pull requests, then settles through the orchestrator
// so every client sees the same shelf.
const layerThreadSettlementWorker = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(
  Layer.provide(LifecyclePolicy.layer),
  Layer.provide(layerPullRequestService),
  Layer.provide(ProjectionStoreV2.layer),
  Layer.provide(ProjectStore.layer),
);

const layerThreadPullRequestWorker = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService));

const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
  AgentAwarenessRelay.layer,
  // Asks T3 Connect to deliver webhooks it held while this environment was offline.
  layerThreadSettlementWorker,
  StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
  layerThreadPullRequestWorker,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provideMerge(PullRequestSyncReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provide(PullRequestWatchReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  // Subscribes to `account.rate-limits.updated` so usage bars track live
  // telemetry instead of waiting for the next status probe.
  ProviderUsageLimitsIngestion.layer,
  ReplayMarkers.layer,
  // Catches overrides left behind by a project deleted before this cleanup
  // existed, or by a cleanup write that failed. See ProjectService.delete
  // for the normal (on-delete) path.
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
).pipe(
  // Core Services
  Layer.provideMerge(layerOrchestrationApplication),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(layerServerSettings),
  // The asset route uses the registry's GitHub credential for private PR media, which the
  // built-in drivers' layer provides alongside the registry.
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview)),
  Layer.provideMerge(layerPersistence),
  // Both read a user-owned file out of the state directory and stream changes
  // to clients; neither depends on the other.
  Layer.provideMerge(
    Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer),
  ),
  Layer.provideMerge(ProviderRegistry.layer),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // hydration adds their default instances to `providerInstances` on boot.
  Layer.provideMerge(
    ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(WorktreeSetupTracker.layer)),
  ),
  Layer.provideMerge(layerWorkspaceRouting),
  Layer.provideMerge(RemoteRestoreSafety.layer),
  Layer.provideMerge(AttachmentStaging.layer),
  Layer.provideMerge(layerAgentRuntime),
);

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  // Search, prepare, status inspection, and turn launch share one registry
  // cache so every client and provider instance sees the same prepared agents.
  Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
  // Provider event loggers are shared by every driver instance and the
  // orchestration runtime, so they are provided once here.
  // `ModelManifest.layer` is the model manifest, refreshed from the repo's
  // `model-manifest.json` on `main`. Drivers read their entry through the
  // `ModelCatalog` port it provides.
  Layer.provideMerge(
    Layer.mergeAll(
      layerProviderEventLoggers,
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
      ResetCreditCoordinator.layer,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
    ),
  ),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(layerWorkspaceRouting),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(ServerVersion.layer.pipe(Layer.provide(layerServerEnvironment))),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  Layer.provideMerge(ServerSecretStore.layer),
);

const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
  // Misc.
  // Usage reads provider history through the ProviderHost, which needs the
  // background policy below it.
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerUsageHistory),
  Layer.provideMerge(layerBackground),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(SandboxIde.layer),
  Layer.provideMerge(DirectEndpoints.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provideMerge(layerRemoteAssets),
  Layer.provideMerge(AttachmentStaging.layer),
  Layer.provideMerge(layerWorkspaceRouting),
  Layer.provideMerge(layerAgentRuntime),
  Layer.provideMerge(layerPersistence),
  Layer.provide(NetService.layer),
);

const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

const layerMakeRoutes = Layer.mergeAll(
  CredentialBroker.layer,
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(PullRequestHttp.layer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(WebhookRoute.layer.pipe(Layer.provide(RelayDeliveryProof.layer))),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    ServerHttp.layerOtlpTracesProxyRoute,
    ServerHttp.layerAssetRoute,
    ServerHttp.layerAttachmentUploadRoute,
    ServerBrowserStream.routeLayer,
    SandboxIdeHttp.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)),
    ServerHttp.layerStaticAndDevRoute,
    Ws.layer,
  ),
  // The MCP session registry is provided globally (shared with V2 provider
  // sessions) rather than inline here. The orchestrator toolkit resolves
  // delegation targets through the same live adapter facade the V2
  // orchestrator uses, so MCP capability reporting can never drift from
  // what dispatch can actually serve.
  McpHttpServer.layer.pipe(
    Layer.provide(SandboxComputer.layer),
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
  ),
).pipe(
  Layer.provide(McpConnections.layer.pipe(Layer.provide(ExecutorRuntime.layer))),
  // Guides read through the same pull request service as every other surface.
  Layer.provide(
    PullRequestReviewGuideService.layer.pipe(Layer.provide(PullRequestReviewGuides.layer)),
  ),
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP. Provided
  // after the guide service so it reaches that too.
  Layer.provide(layerPullRequestService),
  // The stream route and the WebSocket RPCs share one browser.
  Layer.provide(RemoteWorkspacePreview.browserLayer),
  // Server browser tabs and HTML render previews install and run the same headless browser.
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(RemoteWorkspacePreview.brokerLayer),
  Layer.provide(layerCommandReadiness),
  Layer.provide(ServerHttp.layerBrowserApiCors),
  Layer.provide(ServerHttp.layerHttpCompression),
);

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();

    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );
    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [Deferred.await(runtimeStateParked), Deferred.await(routesReady)],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(layerRuntimeDependencies));

    const layerRoutes = HttpRouter.serve(layerMakeRoutes, {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      withUntracedRequests,
      Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
    );
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerRuntimeState,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(layerWorkspaceRouting),
      Layer.provideMerge(layerAgentRuntime),
      Layer.provideMerge(layerPersistence),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(layerActivation),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(layerApplicationObservability),
      Layer.provide(layerRemoteVcsProcess),
      Layer.provideMerge(FetchHttpClient.layer),
      // PR reads, Git operations, and WebSocket discovery share one process limiter.
      Layer.provide(VcsProcess.layer),
      // Every agent and terminal spawn reads this, so it sits below everything.
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(layerMakeServer);
