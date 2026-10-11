import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { filterApertureSnapshot } from "./ApertureCatalog.ts";
import { deploymentHarnessDefaults } from "./HarnessDefaults.ts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CredentialSources from "./credentialSources.ts";
import * as CursorCredentialStore from "@t3tools/provider-cursor/server/credentialStore";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Settings from "../serverSettings.ts";
import { TextGenerationPolicy } from "@t3tools/provider-core/server/textGenerationPolicy";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";

export const ConfigureProvider = Schema.Struct({
  instanceId: C.ProviderInstanceId,
  config: C.ProviderInstanceConfig,
  settings: C.ServerSettings,
});
export const ProviderRequest = Schema.Struct({
  instanceId: C.ProviderInstanceId,
  input: Schema.Unknown,
});
const common = { cwd: Schema.String, modelSelection: C.ModelSelection };
export const CommitInput = Schema.Struct({
  ...common,
  branch: Schema.NullOr(Schema.String),
  stagedSummary: Schema.String,
  stagedPatch: Schema.String,
  includeBranch: Schema.optionalKey(Schema.Boolean),
  policy: Schema.optionalKey(TextGenerationPolicy),
});
export const PrInput = Schema.Struct({
  ...common,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  commitSummary: Schema.String,
  diffSummary: Schema.String,
  diffPatch: Schema.String,
  changeRequestTemplate: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(TextGenerationPolicy),
});
export const BranchInput = Schema.Struct({
  ...common,
  message: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(C.ChatAttachment)),
  naming: Schema.optionalKey(
    Schema.Struct({ mode: C.BranchNamingMode, prefix: Schema.String, instructions: Schema.String }),
  ),
});
export const TitleInput = Schema.Struct({
  ...common,
  message: Schema.String,
  linkedContext: Schema.optionalKey(Schema.String),
  previousTitle: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(C.ChatAttachment)),
});
export const ReviewGuideInput = Schema.Struct({
  ...common,
  number: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  baseBranch: Schema.String,
  baseCommit: Schema.String,
  settledReview: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
  stack: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.NullOr(Schema.String),
        headSha: Schema.NullOr(Schema.String),
        state: Schema.Literals(["open", "closed", "merged"]),
      }),
    ),
  ),
});
export const ReviewGuideResult = Schema.Struct({ stops: C.PullRequestReviewGuide.fields.stops });
const decodeReviewGuideInput = Schema.decodeUnknownEffect(Schema.toCodecJson(ReviewGuideInput));
const decodeRpcValue = Schema.decodeUnknownEffect(Schema.toCodecJson(ConfigureProvider));
const decodeOwnerSessionIdInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    ownerSessionId: Schema.String,
    methodId: Schema.optionalKey(Schema.String),
    returnUrl: Schema.optionalKey(Schema.String),
    callbackMode: Schema.optionalKey(Schema.Literals(["server", "client"])),
    flowId: Schema.optionalKey(Schema.String),
    callbackUrl: Schema.optionalKey(Schema.String),
    response: Schema.optionalKey(C.ProviderAuthRespondInput),
  }),
);
const decodeProviderUsageLimitsUpdate = Schema.decodeUnknownEffect(
  Schema.Struct({ ...C.ProviderUsageLimitsUpdate.fields, checkedAt: Schema.String }),
);
const encodeServerProvider = Schema.encodeEffect(Schema.toCodecJson(C.ServerProvider));
const decodeRpcValue2 = Schema.decodeUnknownEffect(Schema.String);
const decodeRpcValue3 = Schema.decodeUnknownEffect(Schema.toCodecJson(CommitInput));
const decodeRpcValue4 = Schema.decodeUnknownEffect(Schema.toCodecJson(PrInput));
const decodeRpcValue5 = Schema.decodeUnknownEffect(Schema.toCodecJson(BranchInput));
const decodeRpcValue6 = Schema.decodeUnknownEffect(Schema.toCodecJson(TitleInput));

export class WorkerProviderError extends Schema.TaggedError<WorkerProviderError>()(
  "WorkerProviderError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const make = Effect.gen(function* () {
  const providerHost = yield* ProviderHost.ProviderHost;
  const credentialContext = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | ServerSecretStore.ServerSecretStore
  >();
  const sources = yield* CredentialSources.CredentialSources;
  const authOwners = new Map<C.ProviderInstanceId, Set<string>>();
  const registry = yield* Registry.ProviderInstanceRegistry;
  const mutator = yield* Mutator.ProviderInstanceRegistryMutator;
  const settings = yield* Settings.ServerSettingsService;
  const normalizeHarness = yield* Effect.try(() => deploymentHarnessDefaults());
  const configurations: Record<string, C.ProviderInstanceConfig> = {};
  const adapters = new Map<C.ProviderInstanceId, ProviderAdapterV2["Service"]>();
  const lock = yield* Semaphore.make(1);
  const execute = (method: string, raw: unknown) =>
    Effect.gen(function* () {
      if (method === "configureProvider") {
        const input = yield* decodeRpcValue(raw);
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* settings.updateSettings({
              ...input.settings,
              ...resolveModelPreferences(input.settings),
            });
            configurations[input.instanceId] = yield* Effect.try(() =>
              normalizeHarness(input.config),
            );
            yield* mutator.reconcile(configurations);
            const instance = yield* registry.getInstance(input.instanceId);
            if (!instance) return yield* new WorkerProviderError({ operation: "configure" });
            adapters.set(input.instanceId, instance.orchestrationAdapter);
          }),
        );
        return null;
      }
      const command = yield* Schema.decodeUnknownEffect(ProviderRequest)(raw);
      const instance = yield* registry.getInstance(command.instanceId);
      if (!instance) return yield* new WorkerProviderError({ operation: "lookup" });
      if (method === "auth.configureSource") {
        sources.configure(
          command.instanceId,
          yield* Schema.decodeUnknownEffect(CredentialSources.CredentialSource)(command.input),
        );
        return null;
      }
      if (method === "auth.executionCredentials") {
        if (instance.driverKind === "codex") {
          const access = sources.export(command.instanceId);
          if (Option.isNone(access))
            return yield* new WorkerProviderError({ operation: "credentials_unavailable" });
          return yield* access.value;
        }
        if (instance.driverKind === "cursor") {
          const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
            command.instanceId,
          ).pipe(Effect.provideService(ProviderHost.ProviderHost, providerHost));
          return (yield* Effect.tryPromise(() => credentials.store.load())) ?? null;
        }
        return yield* new WorkerProviderError({ operation: "credentials_unsupported" });
      }
      if (method === "auth.importExecutionCredentials") {
        if (instance.driverKind !== "cursor")
          return yield* new WorkerProviderError({ operation: "credentials_unsupported" });
        const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
          command.instanceId,
        ).pipe(Effect.provideService(ProviderHost.ProviderHost, providerHost));
        const value = yield* Schema.decodeUnknownEffect(
          Schema.NullOr(CursorCredentialStore.ExecutionCredentials),
        )(command.input);
        yield* Effect.tryPromise(() =>
          value === null ? credentials.store.clear() : credentials.store.save(value),
        );
        return null;
      }
      if (method.startsWith("auth.")) {
        const auth = instance.auth;
        if (!auth) return yield* new WorkerProviderError({ operation: "auth_unavailable" });
        if (method === "auth.reconnectProfile" && auth.reconnectProfile) {
          const methodId = yield* Schema.decodeUnknownEffect(Schema.String)(command.input);
          return yield* auth.reconnectProfile(methodId);
        }
        if (method === "auth.importProfile" && auth.importProfile) {
          const profile = yield* Schema.decodeUnknownEffect(C.ChatGptTransferredProfile)(
            command.input,
          );
          return yield* auth.importProfile(profile, Effect.void);
        }
        const input = yield* decodeOwnerSessionIdInput(command.input);
        const owners = authOwners.get(command.instanceId) ?? new Set<string>();
        owners.add(input.ownerSessionId);
        authOwners.set(command.instanceId, owners);
        switch (method) {
          case "auth.state": {
            const state = yield* Stream.runHead(auth.subscribe(input.ownerSessionId));
            if (Option.isNone(state))
              return yield* new WorkerProviderError({ operation: "auth_state_missing" });
            return state.value;
          }
          case "auth.start":
            return yield* auth.start(
              input.ownerSessionId,
              Effect.void,
              input.methodId,
              input.returnUrl,
              input.callbackMode,
            );
          case "auth.complete":
            if (input.flowId && input.callbackUrl)
              return yield* auth.complete(input.ownerSessionId, {
                flowId: input.flowId,
                callbackUrl: input.callbackUrl,
              });
            break;
          case "auth.cancel":
            if (input.flowId) return yield* auth.cancel(input.ownerSessionId, input.flowId);
            break;
          case "auth.respond":
            if (input.response && auth.respond)
              return yield* auth.respond(input.ownerSessionId, input.response);
            break;
          case "auth.logout":
            return yield* auth.logout(Effect.void);
        }
        return yield* new WorkerProviderError({ operation: "invalid_auth_request" });
      }
      switch (method) {
        case "provider.applyUsageLimits": {
          const input = yield* decodeProviderUsageLimitsUpdate(command.input);
          yield* instance.snapshot.applyUsageLimits(input);
          return null;
        }
        case "provider.snapshot":
          return yield* encodeServerProvider(
            filterApertureSnapshot(yield* instance.snapshot.getSnapshot),
          );
        case "provider.refresh":
          return yield* encodeServerProvider(
            filterApertureSnapshot(yield* instance.snapshot.refresh),
          );
        case "provider.snapshotForCwd": {
          const cwd = yield* decodeRpcValue2(command.input);
          const snapshot = instance.snapshotForCwd
            ? yield* instance.snapshotForCwd(cwd)
            : yield* instance.snapshot.getSnapshot;
          return yield* encodeServerProvider(filterApertureSnapshot(snapshot));
        }
        case "text.commit":
          return yield* instance.textGeneration.generateCommitMessage(
            yield* decodeRpcValue3(command.input),
          );
        case "text.pr":
          return yield* instance.textGeneration.generatePrContent(
            yield* decodeRpcValue4(command.input),
          );
        case "text.branch":
          return yield* instance.textGeneration.generateBranchName(
            yield* decodeRpcValue5(command.input),
          );
        case "text.reviewGuide":
          return yield* instance.textGeneration.generateReviewGuide(
            yield* decodeReviewGuideInput(command.input),
          );
        case "text.title":
          return yield* instance.textGeneration.generateThreadTitle(
            yield* decodeRpcValue6(command.input),
          );
        default:
          return yield* new WorkerProviderError({ operation: "unsupported" });
      }
    }).pipe(
      Effect.provide(credentialContext),
      Effect.mapError((cause) => new WorkerProviderError({ operation: method, cause })),
    );
  const activity = Effect.gen(function* () {
    let pendingCallbacks = 0;
    for (const [instanceId, owners] of authOwners) {
      const instance = yield* registry.getInstance(instanceId);
      if (!instance?.auth) continue;
      for (const owner of owners) {
        const state = yield* Stream.runHead(instance.auth.subscribe(owner));
        if (
          Option.isSome(state) &&
          ["starting", "waiting", "verifying"].includes(state.value.phase)
        )
          pendingCallbacks++;
        else owners.delete(owner);
      }
    }
    return { pendingCallbacks, activeOperations: 0 };
  });
  return { adapters, execute, activity, configureCredentialBroker: sources.configureBroker };
});
