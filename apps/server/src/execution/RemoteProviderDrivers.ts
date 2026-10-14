import { isAntigravityLogoutPrompt } from "../provider/AntigravityAuth.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { credentialPolicy, applyCredentialPolicy } from "./credentialPolicy.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { trackRemoteSessionSetup } from "./RemoteSessionSetup.ts";
import * as AttachmentStaging from "../agentRuntime/AttachmentStaging.ts";
import * as WorkspaceRouting from "../agentRuntime/WorkspaceRouting.ts";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as A from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Settings from "../serverSettings.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { createRemoteProviderAdapter } from "./RemoteProviderAdapter.ts";
import {
  CommitInput,
  ReviewGuideInput,
  ReviewGuideResult,
  PrInput,
  BranchInput,
  TitleInput,
  ConfigureProvider,
} from "./WorkerProviders.ts";
import { sameIdentity } from "./ExecutionWorker.ts";
import type { ExecutionClient } from "./ExecutionClient.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.toCodecJson(C.ServerProvider));
const isCodexSettings = Schema.is(C.CodexSettings);
const encodeRpcValue = Schema.encodeEffect(Schema.toCodecJson(ConfigureProvider));
const encodeReviewGuideInput = Schema.encodeUnknownSync(Schema.toCodecJson(ReviewGuideInput));
const encodeRpcValueSync = Schema.encodeUnknownSync(Schema.toCodecJson(CommitInput));
const encodeRpcValueSync2 = Schema.encodeUnknownSync(Schema.toCodecJson(PrInput));
const encodeRpcValueSync3 = Schema.encodeUnknownSync(Schema.toCodecJson(BranchInput));
const encodeRpcValueSync4 = Schema.encodeUnknownSync(Schema.toCodecJson(TitleInput));

/** Keep upstream driver schemas and metadata; replace only their execution factory. */
export const makeRemoteDrivers = Effect.gen(function* () {
  const runtime = yield* Runtime.RuntimeClient;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const settings = yield* Settings.ServerSettingsService;
  const workspaceRouting = yield* Effect.serviceOption(WorkspaceRouting.WorkspaceRouting);
  const setupTracker = yield* Effect.serviceOption(WorktreeSetupTracker.WorktreeSetupTracker);
  const attachments = yield* Effect.serviceOption(AttachmentStaging.AttachmentStaging);
  const advertisedMcp = yield* Config.option(Config.String("T3_MCP_ADVERTISED_URL"));
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  return BUILT_IN_DRIVERS.map((driver): AnyProviderDriver => ({
    ...driver,
    create: (input) =>
      Effect.gen(function* () {
        const instanceId = input.instanceId;
        const credentialRecipients = new Map<string, ExecutionClient>();
        let configuredUtility: ExecutionClient["identity"] | undefined;
        const authPolicy = credentialPolicy(driver.driverKind, input.config);
        const managedCodex =
          driver.driverKind === "codex" &&
          isCodexSettings(input.config) &&
          input.config.setupMode === "managed";
        const failure = (cause: unknown) =>
          new ProviderDriverError({
            instanceId,
            driver: driver.driverKind,
            detail: "Remote provider request failed",
            cause,
          });
        const adapterFailure = (cause: unknown) =>
          new A.ProviderAdapterProtocolError({
            driver: driver.driverKind,
            detail: "Remote provider unavailable",
            cause,
          });
        const configure = (
          client: ExecutionClient,
          shareCredentials = true,
        ): Effect.Effect<ExecutionClient, ProviderDriverError> =>
          Effect.gen(function* () {
            const current = yield* settings.getSettings;
            const encodedConfig =
              input.configInput === undefined
                ? yield* Schema.encodeEffect(driver.configSchema)(input.config)
                : input.configInput;
            // The registry already resolved explicit disables. Do not turn a
            // decoded driver's default into a second raw disable at the worker.
            const workerConfig =
              encodedConfig !== null &&
              typeof encodedConfig === "object" &&
              !Array.isArray(encodedConfig)
                ? Object.fromEntries(
                    Object.entries(encodedConfig).filter(([key]) => key !== "enabled"),
                  )
                : encodedConfig;
            const config: C.ProviderInstanceConfig = {
              driver: driver.driverKind,
              config: workerConfig,
              enabled: input.enabled,
              environment: input.environment,
              ...(input.displayName ? { displayName: input.displayName } : {}),
              ...(input.accentColor ? { accentColor: input.accentColor } : {}),
            };
            const encoded = yield* encodeRpcValue({
              instanceId,
              config,
              settings: current,
            });
            yield* Effect.tryPromise(() => client.transient("configureProvider", encoded));
            if (
              shareCredentials &&
              (driver.driverKind === "cursor" ||
                driver.driverKind === "antigravity" ||
                managedCodex)
            ) {
              const owner = yield* runtime
                .forUtility(instanceId)
                .pipe(Effect.flatMap((owner) => configure(owner, false)));
              if (!sameIdentity(owner.identity, client.identity)) {
                if (driver.driverKind === "cursor" || driver.driverKind === "antigravity") {
                  const credentials = yield* Effect.tryPromise(() =>
                    owner.transient("auth.executionCredentials", { instanceId, input: null }),
                  );
                  yield* Effect.tryPromise(() =>
                    client.transient("auth.importExecutionCredentials", {
                      instanceId,
                      input: credentials,
                    }),
                  );
                  credentialRecipients.set(client.identity.workspaceId, client);
                } else {
                  yield* Effect.tryPromise(() =>
                    client.transient("auth.configureSource", {
                      instanceId,
                      input: owner.credentialSource(),
                    }),
                  );
                }
              }
            }
            return client;
          }).pipe(Effect.mapError(failure));
        const utility = Effect.gen(function* () {
          if (!input.enabled) return yield* failure("Provider is disabled in settings");
          return yield* runtime.forUtility(instanceId);
        }).pipe(
          Effect.flatMap((client) => configure(client, false)),
          Effect.tap((client) =>
            Effect.sync(() => {
              configuredUtility = client.identity;
            }),
          ),
          Effect.mapError(failure),
        );
        const adapter = (client: ExecutionClient, attachOnly = false) =>
          createRemoteProviderAdapter({
            mcpSessions,
            instanceId,
            driver: driver.driverKind,
            client,
            attachOnly,
            requireRemoteMcpEndpoint: true,
            stageAttachments: (threadId, items) =>
              items.length === 0
                ? Effect.void
                : Option.isSome(attachments)
                  ? attachments.value
                      .stage(threadId, items)
                      .pipe(Effect.asVoid, Effect.mapError(adapterFailure))
                  : Effect.fail(adapterFailure("Attachment staging is unavailable")),
            ...(Option.isSome(advertisedMcp) ? { mcpEndpoint: advertisedMcp.value } : {}),
            getEventCursor: (sessionId) =>
              runPromise(runtime.getEventCursor(client.identity, sessionId)),
          });
        const orchestrationAdapter: A.ProviderAdapterV2["Service"] = {
          instanceId,
          driver: driver.driverKind,
          getCapabilities: () =>
            utility.pipe(
              Effect.mapError(adapterFailure),
              Effect.flatMap((client) => adapter(client).getCapabilities()),
            ),
          planSelectionTransition: (value) =>
            utility.pipe(
              Effect.mapError(adapterFailure),
              Effect.flatMap((client) => adapter(client).planSelectionTransition(value)),
            ),
          openSession: (value) =>
            Effect.gen(function* () {
              const resume = value.resumeFromSession;
              let attachOnly =
                resume !== undefined && resume.status !== "stopped" && resume.status !== "error";
              const acquire = Effect.gen(function* () {
                const observation = attachOnly
                  ? yield* runtime
                      .observeThread(value.threadId)
                      .pipe(
                        Effect.catch((error) =>
                          Runtime.isWorkerObservationPending(error)
                            ? Effect.succeed(null)
                            : Effect.fail(error),
                        ),
                      )
                  : null;
                if (observation?.kind === "stopped") attachOnly = false;
                return observation?.kind === "running"
                  ? observation.client
                  : yield* runtime.forThread(value.threadId, driver.driverKind);
              });
              const open = (client: ExecutionClient) =>
                Effect.gen(function* () {
                  if (attachOnly) {
                    const residency = yield* runtime.sessionResidency(value.providerSessionId);
                    const current = yield* Effect.tryPromise(() => client.inspectIdentity());
                    if (!sameIdentity(client.identity, current))
                      return yield* new Runtime.RuntimeClientError({
                        operation: "session-identity",
                        cause: "Worker changed after acquisition",
                      });
                    if (!residency || !sameIdentity(residency, current)) attachOnly = false;
                  }
                  yield* runtime.rememberSession(
                    value.providerSessionId,
                    value.threadId,
                    client.identity,
                  );
                  yield* configure(client);
                  return yield* adapter(client, attachOnly).openSession(value);
                });
              return yield* Option.isSome(setupTracker)
                ? trackRemoteSessionSetup({
                    tracker: setupTracker.value,
                    threadId: value.threadId,
                    acquire,
                    open,
                  })
                : acquire.pipe(Effect.flatMap(open));
            }).pipe(Effect.mapError(adapterFailure)),
        };
        function invoke<T, E>(
          method: string,
          value: unknown,
          schema: Schema.Codec<T, E>,
          cwd?: string,
        ) {
          const destination =
            cwd === undefined
              ? utility
              : Option.isSome(workspaceRouting)
                ? workspaceRouting.value
                    .clientForCwd(cwd)
                    .pipe(Effect.flatMap(configure), Effect.mapError(failure))
                : Effect.fail(failure("Workspace routing is unavailable"));
          return destination.pipe(
            Effect.flatMap((client) =>
              Effect.tryPromise(() =>
                method.startsWith("auth.")
                  ? client.transient(method, { instanceId, input: value })
                  : client.call(method, { instanceId, input: value }),
              ),
            ),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
            Effect.mapError(failure),
          );
        }
        const disabledSnapshot = buildUnavailableProviderSnapshot({
          instanceId,
          driverKind: driver.driverKind,
          displayName: input.displayName,
          accentColor: input.accentColor,
          reason: "Provider is disabled in settings; execution has not been probed.",
        }).pipe(
          Effect.map((value): C.ServerProvider => {
            const { unavailableReason: _unavailable, ...disabled } = value;
            return { ...disabled, availability: "available" };
          }),
        );
        let lastSnapshot: C.ServerProvider | undefined;
        const snapshot = (method: string, wake: boolean) =>
          Effect.gen(function* () {
            if (!input.enabled) return yield* disabledSnapshot;
            let client: ExecutionClient;
            if (wake || lastSnapshot === undefined) {
              client = yield* utility;
            } else {
              const observation = yield* runtime.observeWorkspace(`t3:utility:${instanceId}`);
              if (observation.kind === "stopped") return lastSnapshot;
              client = observation.client;
              if (!configuredUtility || !sameIdentity(configuredUtility, client.identity)) {
                yield* configure(client, false);
                configuredUtility = client.identity;
              }
            }
            const raw = yield* Effect.tryPromise(() =>
              client.call(method, { instanceId, input: null }),
            );
            return yield* decodeSnapshot(raw);
          }).pipe(
            Effect.catch(() =>
              lastSnapshot !== undefined
                ? Effect.succeed(lastSnapshot)
                : buildUnavailableProviderSnapshot({
                    instanceId,
                    driverKind: driver.driverKind,
                    displayName: input.displayName,
                    reason: "The sandbox provider is unavailable. Check the execution runtime.",
                  }),
            ),
            Effect.map((value) => applyCredentialPolicy(value, authPolicy)),
            Effect.tap((value) =>
              Effect.sync(() => {
                lastSnapshot = value;
              }),
            ),
          );
        const getSnapshot = snapshot("provider.snapshot", false);
        const refresh = snapshot("provider.refresh", true);
        const textError = (operation: string) => (cause: unknown) =>
          new C.TextGenerationError({ operation, detail: "Sandbox text generation failed", cause });
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver.driverKind,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind: driver.driverKind,
            instanceId,
          }),
          displayName: input.displayName,
          enabled: input.enabled,
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          orchestrationAdapter,
          snapshot: {
            getSnapshot,
            refresh,
            resolveMaintenance: () =>
              Effect.succeed({
                provider: driver.driverKind,
                packageName: null,
                update: null,
                latestVersion: null,
              }),
            streamChanges: Stream.fromEffectRepeat(
              getSnapshot.pipe(Effect.tap(() => Effect.sleep("30 seconds"))),
            ),
            applyUsageLimits: (update) =>
              invoke("provider.applyUsageLimits", update, Schema.Unknown).pipe(
                Effect.asVoid,
                Effect.catch((cause) => Effect.logWarning("Remote usage update failed", { cause })),
              ),
          },
          snapshotForCwd: (cwd) =>
            !input.enabled
              ? getSnapshot
              : invoke("provider.snapshotForCwd", cwd, C.ServerProvider, cwd).pipe(
                  Effect.map((value) => applyCredentialPolicy(value, authPolicy)),
                ),
          refreshModels: () =>
            driver.driverKind === "antigravity"
              ? invoke("provider.refreshModels", null, Schema.Null).pipe(
                  Effect.andThen(refresh),
                  Effect.asVoid,
                )
              : refresh.pipe(Effect.asVoid),
          ...(authPolicy.kind !== "workspace"
            ? {
                auth: {
                  ...(driver.driverKind === "antigravity"
                    ? { isLogoutPrompt: isAntigravityLogoutPrompt }
                    : {}),
                  ...(driver.driverKind === "cursor" || managedCodex
                    ? {
                        credentialBinding: {
                          owner: "t3" as const,
                          key: `${driver.driverKind}:${instanceId}`,
                        },
                      }
                    : {}),
                  ...(managedCodex
                    ? {
                        reconnectProfile: (methodId: string) =>
                          invoke(
                            "auth.reconnectProfile",
                            methodId,
                            Schema.NullOr(C.ChatGptReconnectProfile),
                          ).pipe(
                            Effect.mapError(
                              () =>
                                new C.ProviderSetupError({
                                  instanceId,
                                  operation: "reconnect",
                                  detail: "Could not reconnect the saved ChatGPT profile.",
                                }),
                            ),
                          ),
                        importProfile: (
                          profile: C.ChatGptTransferredProfile,
                          stopSessions: Effect.Effect<void, C.ProviderSetupError>,
                        ) =>
                          stopSessions.pipe(
                            Effect.andThen(
                              invoke("auth.importProfile", profile, C.ProviderAuthState),
                            ),
                            Effect.mapError(
                              () =>
                                new C.ProviderSetupError({
                                  instanceId,
                                  operation: "import",
                                  detail: "Could not import the ChatGPT profile.",
                                }),
                            ),
                          ),
                      }
                    : {}),
                  start: (
                    ownerSessionId,
                    stopSessions = Effect.void,
                    methodId,
                    returnUrl,
                    callbackMode,
                  ) =>
                    stopSessions.pipe(
                      Effect.andThen(
                        invoke(
                          "auth.start",
                          { ownerSessionId, methodId, returnUrl, callbackMode },
                          C.ProviderAuthState,
                        ),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new C.ProviderSetupError({
                            instanceId,
                            operation: "start",
                            detail: "Sandbox sign-in failed",
                            cause,
                          }),
                      ),
                    ),
                  complete: (ownerSessionId, response) =>
                    invoke(
                      "auth.complete",
                      { ownerSessionId, ...response },
                      C.ProviderAuthState,
                    ).pipe(
                      Effect.mapError(
                        (cause) =>
                          new C.ProviderSetupError({
                            instanceId,
                            operation: "complete",
                            detail: "Sandbox sign-in callback failed",
                            cause,
                          }),
                      ),
                    ),
                  cancel: (ownerSessionId, flowId) =>
                    invoke("auth.cancel", { ownerSessionId, flowId }, C.ProviderAuthState).pipe(
                      Effect.mapError(
                        (cause) =>
                          new C.ProviderSetupError({
                            instanceId,
                            operation: "cancel",
                            detail: "Sandbox sign-in cancellation failed",
                            cause,
                          }),
                      ),
                    ),
                  respond: (ownerSessionId, response) =>
                    invoke("auth.respond", { ownerSessionId, response }, C.ProviderAuthState).pipe(
                      Effect.mapError(
                        (cause) =>
                          new C.ProviderSetupError({
                            instanceId,
                            operation: "respond",
                            detail: "Sandbox sign-in response failed",
                            cause,
                          }),
                      ),
                    ),
                  logout: (stopSessions) =>
                    stopSessions.pipe(
                      Effect.andThen(
                        invoke(
                          "auth.logout",
                          { ownerSessionId: "server" },
                          C.ProviderAuthState,
                        ).pipe(
                          Effect.tap(() =>
                            Effect.forEach(
                              credentialRecipients.values(),
                              (client) =>
                                Effect.tryPromise(() =>
                                  client.transient("auth.importExecutionCredentials", {
                                    instanceId,
                                    input: null,
                                  }),
                                ).pipe(
                                  Effect.catch(() =>
                                    Effect.logWarning(
                                      "A stopped execution workspace will clear its provider credential when it reconnects.",
                                    ),
                                  ),
                                ),
                              { discard: true },
                            ),
                          ),
                        ),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new C.ProviderSetupError({
                            instanceId,
                            operation: "logout",
                            detail: "Sandbox sign-out failed",
                            cause,
                          }),
                      ),
                    ),
                  subscribe: (ownerSessionId) =>
                    Stream.fromEffectRepeat(
                      invoke("auth.state", { ownerSessionId }, C.ProviderAuthState).pipe(
                        Effect.tap(() => Effect.sleep("500 millis")),
                        Effect.orDie,
                      ),
                    ),
                },
              }
            : {}),
          textGeneration: {
            generateReviewGuide: (value) =>
              invoke(
                "text.reviewGuide",
                encodeReviewGuideInput(
                  Object.fromEntries(
                    Object.entries(value).filter(([, value]) => value !== undefined),
                  ),
                ),
                ReviewGuideResult,
                value.cwd,
              ).pipe(Effect.mapError(textError("review-guide"))),
            generateCommitMessage: (value) =>
              invoke(
                "text.commit",
                encodeRpcValueSync(
                  Object.fromEntries(
                    Object.entries(value).filter(([, value]) => value !== undefined),
                  ),
                ),
                Schema.Struct({
                  subject: Schema.String,
                  body: Schema.String,
                  branch: Schema.optionalKey(Schema.String),
                }),
                value.cwd,
              ).pipe(Effect.mapError(textError("commit"))),
            generatePrContent: (value) =>
              invoke(
                "text.pr",
                encodeRpcValueSync2(
                  Object.fromEntries(
                    Object.entries(value).filter(([, value]) => value !== undefined),
                  ),
                ),
                Schema.Struct({ title: Schema.String, body: Schema.String }),
                value.cwd,
              ).pipe(Effect.mapError(textError("pr"))),
            generateBranchName: (value) =>
              invoke(
                "text.branch",
                encodeRpcValueSync3(
                  Object.fromEntries(
                    Object.entries(value).filter(([, value]) => value !== undefined),
                  ),
                ),
                Schema.Struct({ branch: Schema.String }),
                value.cwd,
              ).pipe(Effect.mapError(textError("branch"))),
            generateThreadTitle: (value) =>
              invoke(
                "text.title",
                encodeRpcValueSync4(
                  Object.fromEntries(
                    Object.entries(value).filter(([, value]) => value !== undefined),
                  ),
                ),
                Schema.Struct({
                  title: Schema.String,
                  needsRefinement: Schema.optionalKey(Schema.Boolean),
                }),
                value.cwd,
              ).pipe(Effect.mapError(textError("title"))),
          },
        };
        return instance;
      }),
  }));
});
