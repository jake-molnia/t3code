import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import {
  request,
  runStream,
  subscribe,
  subscribeDynamicWithSession,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "./serverConfigProjection.ts";

// Exported server state includes this type in its inferred public return type.
export type { ServerConfigProjection } from "./serverConfigProjection.ts";

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

export interface ServerConfigSubscriptionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  readonly usageLimitsCommand?: boolean;
}

export const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* (subscription: ServerConfigSubscriptionOptions) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const cache = yield* Persistence.EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache.loadServerConfig(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(Option.none<ServerConfig>()),
        ),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      // Stripped on load as well as on save: a cache written by an earlier
      // build can still carry published themes.
      Option.map(cachedConfig, (cached) => ({
        config: withoutEnvironmentThemes(cached),
        latestEvent: cachedConfigSnapshotEvent(withoutEnvironmentThemes(cached)),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      return yield* cache.saveServerConfig(environmentId, withoutEnvironmentThemes(config)).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    yield* runCachePersistence(persistence, persistPending).pipe(Effect.forkScoped);

    yield* subscribe(WS_METHODS.subscribeServerConfig, {
      ...(subscription.environmentThemes === true ? { environmentThemes: true } : {}),
      ...(subscription.usageLimitSources === true ? { usageLimitSources: true } : {}),
      ...(subscription.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
    }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const next = applyServerConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) {
            return;
          }
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverConfigStateChanges(
  environmentId: EnvironmentId,
  subscription: ServerConfigSubscriptionOptions,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState(subscription).pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: (value) => Result.succeed(value),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function applyServerWelcomeEvent(
  current: EnvironmentServerWelcomeState,
  session: RpcSession,
  event: {
    readonly type: "welcome" | "ready" | "legacyThreadMigration";
    readonly payload: unknown;
  },
): EnvironmentServerWelcomeState {
  return event.type === "welcome" && current.currentSession === session
    ? {
        ...current,
        welcomeSession: session,
        welcome: event.payload as ServerLifecycleWelcomePayload,
      }
    : current;
}

export interface EnvironmentServerWelcomeState {
  readonly currentSession: RpcSession | null;
  readonly welcomeSession: RpcSession | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

export function resolveServerWelcomeState(
  state: EnvironmentServerWelcomeState,
): ServerLifecycleWelcomePayload | null {
  return state.currentSession === state.welcomeSession ? state.welcome : null;
}

export const makeEnvironmentServerWelcomeState = Effect.fn("EnvironmentServerWelcomeState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const initialSession = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
    const state = yield* SubscriptionRef.make<EnvironmentServerWelcomeState>({
      currentSession: initialSession,
      welcomeSession: null,
      welcome: null,
    });

    const updateWithCurrentSession = Effect.fn(
      "EnvironmentServerWelcomeState.updateWithCurrentSession",
    )(function* (
      update: (
        current: EnvironmentServerWelcomeState,
        currentSession: RpcSession | null,
      ) => EnvironmentServerWelcomeState,
    ) {
      return yield* SubscriptionRef.modifyEffect(state, (current) =>
        SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(
            (latestSession) =>
              [undefined, update(current, Option.getOrNull(latestSession))] as const,
          ),
        ),
      );
    });

    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.runForEach(() =>
        updateWithCurrentSession((current, currentSession) => ({
          ...current,
          currentSession,
        })),
      ),
      Effect.forkScoped,
    );

    yield* subscribeDynamicWithSession(
      WS_METHODS.subscribeServerLifecycle,
      Effect.fn("EnvironmentServerWelcomeState.makeSubscribeInput")(function* (session) {
        yield* updateWithCurrentSession((current, currentSession) =>
          currentSession === session
            ? {
                ...current,
                currentSession,
                welcomeSession: session,
                welcome: null,
              }
            : { ...current, currentSession },
        );
        return {};
      }),
    ).pipe(
      Stream.runForEach(([session, event]) =>
        updateWithCurrentSession((current, currentSession) =>
          applyServerWelcomeEvent(
            {
              ...current,
              currentSession,
            },
            session,
            event,
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverWelcomeStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerWelcomeState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(Stream.map(resolveServerWelcomeState)),
        ),
      ),
    ),
  );
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return projection.config;
  }
  return initialConfig ?? projection?.config ?? null;
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
    /**
     * Whether this surface renders themes the environment publishes. Mobile
     * keeps its own appearance settings, so it neither asks for the stream nor
     * receives the payload.
     */
    readonly environmentThemes?: boolean;
    /** Whether this surface renders quota from configured usage-limit sources. */
    readonly usageLimitSources?: boolean;
    readonly usageLimitsCommand?: boolean;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        serverConfigStateChanges(environmentId, {
          ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
          ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
          ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
        }),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const usagePricesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const overrides = get(settingsValueAtom(environmentId))?.usagePriceOverrides ?? {};
      // Only changed prices should trigger another transcript scan. Settings
      // snapshots can recreate the same mapping in a different property order.
      return JSON.stringify(
        Object.keys(overrides)
          .sort()
          .map((model) => {
            const price = overrides[model]!;
            return [
              model,
              price.inputCostPerMillionTokens,
              price.outputCostPerMillionTokens,
              price.cacheReadCostPerMillionTokens,
              price.cacheWriteCostPerMillionTokens,
            ];
          }),
      );
    }).pipe(Atom.withLabel(`environment-data:server:usage-prices:${environmentId}`)),
  );
  const usageScanSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(settingsValueAtom(environmentId));
      const aliases = settings?.usageModelAliases ?? {};
      return JSON.stringify([
        get(usagePricesAtom(environmentId)),
        Object.keys(aliases)
          .sort()
          .map((model) => [model, aliases[model]]),
        settings?.cursorKeychainUsageEnabled ?? false,
      ]);
    }).pipe(Atom.withLabel(`environment-data:server:usage-scan-settings:${environmentId}`)),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );
  const welcomeStateFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverWelcomeStateChanges(environmentId), { initialValue: null })
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:welcome-state:${environmentId}`),
      ),
  );
  const welcomeFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(welcomeStateFamily(environmentId));
      if (result._tag !== "Success") return result;
      return result.value === null
        ? AsyncResult.initial<ServerLifecycleWelcomePayload, never>(result.waiting)
        : AsyncResult.success(result.value, result);
    }).pipe(Atom.withLabel(`environment-data:server:welcome:${environmentId}`)),
  );
  const welcome = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerLifecycle>;
  }) => welcomeFamily(target.environmentId);
  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
    scheduler: configScheduler,
    concurrency: configConcurrency,
  });

  return {
    configValueAtom,
    runStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:run-storage-cleanup",
      tag: WS_METHODS.serverRunStorageCleanup,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    releaseNotice: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:release-notice",
      tag: WS_METHODS.serverGetReleaseNotice,
      idleTtlMs: 60 * 60_000,
    }),
    storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:storage-cleanup-report",
      tag: WS_METHODS.serverGetStorageCleanupReport,
      idleTtlMs: 0,
    }),
    settingsValueAtom,
    providersValueAtom,
    modelGatewaySnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gateway:snapshot",
      tag: WS_METHODS.modelGatewaySnapshot,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshIntervalMs: 30_000,
    }),
    modelGatewayAddEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:add-endpoint",
      tag: WS_METHODS.modelGatewayAddEndpoint,
    }),
    modelGatewayStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:start",
      tag: WS_METHODS.modelGatewayStart,
    }),
    modelGatewayStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:status",
      tag: WS_METHODS.modelGatewayStatus,
    }),
    modelGatewayComplete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:complete",
      tag: WS_METHODS.modelGatewayComplete,
    }),
    modelGatewayCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:cancel",
      tag: WS_METHODS.modelGatewayCancel,
    }),
    modelGatewaySetEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:setenabled",
      tag: WS_METHODS.modelGatewaySetEnabled,
    }),
    modelGatewayRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gateway:remove",
      tag: WS_METHODS.modelGatewayRemove,
    }),
    providerAuthState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:auth-state",
      tag: WS_METHODS.providerAuthSubscribe,
      idleTtlMs: 0,
    }),
    startProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-start",
      tag: WS_METHODS.providerAuthStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    respondProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-respond",
      tag: WS_METHODS.providerAuthRespond,
    }),
    completeProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-complete",
      tag: WS_METHODS.providerAuthComplete,
    }),
    chatGptReconnectProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:reconnect-profile",
      tag: WS_METHODS.chatGptReconnectProfile,
    }),
    chatGptImportProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:import-profile",
      tag: WS_METHODS.chatGptImportProfile,
    }),
    chatGptHandoffState: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:chatgpt:handoff",
      sensitiveInput: true,
      // OAuth must not be replayed when the connection recovers.
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.chatGptHandoffSubscribe>) =>
        runStream(WS_METHODS.chatGptHandoffSubscribe, input),
      idleTtlMs: 0,
    }),
    codexAuthCallbackState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:codex:auth-callback",
      tag: WS_METHODS.codexAuthCallbackSubscribe,
      idleTtlMs: 0,
    }),
    cancelProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-cancel",
      tag: WS_METHODS.providerAuthCancel,
    }),
    logoutProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-logout",
      tag: WS_METHODS.providerAuthLogout,
    }),
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    executionPools: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:execution-pools",
      tag: WS_METHODS.serverExecutionPools,
    }),
    hostResources: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:host-resources",
      idleTtlMs: 0,
      staleTimeMs: 5_000,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.serverGetHostResources>) =>
        request(WS_METHODS.serverGetHostResources, input).pipe(Effect.timeout("5 seconds")),
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    scheduledTaskWebhookDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-deliveries",
      tag: WS_METHODS.scheduledTasksListWebhookDeliveries,
    }),
    scheduledTaskWebhookDelivery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-delivery",
      tag: WS_METHODS.scheduledTasksGetWebhookDelivery,
    }),
    /** Live scheduled-task list: snapshot on subscribe, fresh list after every server-side change. */
    scheduledTasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:scheduled-tasks:live",
      tag: WS_METHODS.scheduledTasksSubscribe,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    // Slow sources answer from cache first: that summary stays on screen, with
    // the query waiting, until one `awaitRefresh` request replaces it.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => usageScanSettingsAtom(environmentId),
      execute: (input, emit) =>
        request(WS_METHODS.serverGetUsageSummary, input).pipe(
          Effect.flatMap((summary) =>
            summary.sources.some((source) => source.refreshing === true)
              ? emit(summary).pipe(
                  Effect.andThen(
                    request(WS_METHODS.serverGetUsageSummary, { ...input, awaitRefresh: true }),
                  ),
                  // The cached summary is still the best data, and a failure
                  // would read as the environment not reporting usage at all.
                  Effect.catch((error) =>
                    Effect.logWarning("Could not refresh slow usage sources.").pipe(
                      Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
                      Effect.as(summary),
                    ),
                  ),
                )
              : Effect.succeed(summary),
          ),
        ),
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    searchAcpRegistry: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:acp-registry:search",
      tag: WS_METHODS.serverSearchAcpRegistry,
      // Each submitted search refreshes the server-side registry. Dropping an
      // abandoned query immediately also interrupts stale in-flight requests.
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    configProjection,
    welcome,
    legacyThreadMigration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:legacy-thread-migration",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "legacyThreadMigration"
              ? Result.succeed(event.payload)
              : Result.failVoid,
          ),
        ),
    }),
    consumeResetCredit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:consume-reset-credit",
      tag: WS_METHODS.providerConsumeResetCredit,
      concurrency: {
        mode: "singleFlight",
        // Both ids are free-form strings; a delimiter could collide.
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.instanceId ?? null,
            input.cwd ?? null,
            input.fresh ?? false,
            input.refreshModels ?? false,
          ]),
      },
    }),
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings,
    // Provider-instance mutations share the settings command and its
    // environment-serial scheduler. The named boundary keeps clients on the
    // atomic map-entry payload instead of rebuilding a stale whole map.
    mutateProviderInstance: updateSettings,
    acceptAcpRegistryUrlAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:accept-url-auth",
      tag: WS_METHODS.serverAcceptAcpRegistryUrlAuth,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.elicitationId}`,
      },
    }),
    listAcpRegistrySessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-sessions",
      tag: WS_METHODS.serverListAcpRegistrySessions,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.cursor ?? "first"}`,
      },
    }),
    importAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:import-session",
      tag: WS_METHODS.serverImportAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    deleteAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:delete-session",
      tag: WS_METHODS.serverDeleteAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    listAcpRegistryProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-providers",
      tag: WS_METHODS.serverListAcpRegistryProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}`,
      },
    }),
    setAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:set-provider",
      tag: WS_METHODS.serverSetAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    disableAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:disable-provider",
      tag: WS_METHODS.serverDisableAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    logoutAcpRegistry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:logout",
      tag: WS_METHODS.serverLogoutAcpRegistry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    upsertScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:upsert",
      tag: WS_METHODS.scheduledTasksUpsert,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setScheduledTaskEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:set-enabled",
      tag: WS_METHODS.scheduledTasksSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    deleteScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:delete",
      tag: WS_METHODS.scheduledTasksDelete,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Deliberately not on the config lane: run-now blocks until the run is
    // dispatched, and a slow run must not stall settings/keybinding/provider
    // mutations (or other scheduled-task edits) queued behind it.
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
    rotateScheduledTaskWebhookToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:rotate-webhook-token",
      tag: WS_METHODS.scheduledTasksRotateWebhookToken,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Off the config lane: answering a card must not queue behind settings
    // edits. One answer per card at a time.
    answerSecretRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-request",
      tag: WS_METHODS.secretsAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    refreshUsageRates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-usage-rates",
      tag: WS_METHODS.serverRefreshUsageRates,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    checkOtlpEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-otlp-endpoint",
      tag: WS_METHODS.serverCheckOtlpEndpoint,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
