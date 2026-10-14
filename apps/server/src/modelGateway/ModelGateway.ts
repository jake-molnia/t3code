import { readConfiguration } from "./configuration.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  GatewayAccountId,
  GatewayFlowId,
  ModelGatewayError,
  type GatewayAccount,
  type AuthSessionId,
  type GatewayAddEndpointInput,
  type GatewayAccountInput,
  type GatewayAuth,
  type GatewayCompleteInput,
  type GatewayFlowInput,
  type GatewaySetEnabledInput,
  type GatewaySnapshot,
  type GatewayStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  FetchHttpClient,
} from "effect/http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const Credentials = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      provider: Schema.String,
      label: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
      unavailable: Schema.optional(Schema.Boolean),
      status: Schema.optional(Schema.String),
      runtime_only: Schema.optional(Schema.Boolean),
    }),
  ),
});
const EndpointGroup = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.NonEmptyString,
    disabled: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const GatewayConfiguration = Schema.Struct({
  "api-keys": Schema.optional(
    Schema.Struct({
      "openai-compatibility": Schema.optional(Schema.Array(EndpointGroup)),
    }),
  ),
});
const endpointId = (name: string) => GatewayAccountId.make(`endpoint:${encodeURIComponent(name)}`);
const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Login = Schema.Struct({
  status: Schema.Literal("ok"),
  url: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  flow: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
const LoginStatus = Schema.Struct({ status: Schema.Literals(["ok", "wait", "error"]) });
const MutationResult = Schema.Struct({ status: Schema.Literal("ok") });
const CancelResult = Schema.Struct({ status: Schema.Literal("ok"), cancelled: Schema.Boolean });

export class ModelGateway extends Context.Service<
  ModelGateway,
  {
    readonly addEndpoint: (
      input: GatewayAddEndpointInput,
    ) => Effect.Effect<GatewaySnapshot, ModelGatewayError>;
    readonly snapshot: () => Effect.Effect<GatewaySnapshot, ModelGatewayError>;
    readonly start: (
      input: GatewayStartInput,
      owner: AuthSessionId,
    ) => Effect.Effect<GatewayAuth, ModelGatewayError>;
    readonly status: (
      input: GatewayFlowInput,
      owner: AuthSessionId,
    ) => Effect.Effect<GatewayAuth, ModelGatewayError>;
    readonly complete: (
      input: GatewayCompleteInput,
      owner: AuthSessionId,
    ) => Effect.Effect<GatewayAuth, ModelGatewayError>;
    readonly cancel: (
      input: GatewayFlowInput,
      owner: AuthSessionId,
    ) => Effect.Effect<GatewayAuth, ModelGatewayError>;
    readonly setEnabled: (
      input: GatewaySetEnabledInput,
    ) => Effect.Effect<GatewaySnapshot, ModelGatewayError>;
    readonly remove: (
      input: GatewayAccountInput,
    ) => Effect.Effect<GatewaySnapshot, ModelGatewayError>;
  }
>()("t3/modelGateway/ModelGateway") {}

type Configuration = {
  readonly url: string;
  readonly managementKey: string;
  readonly apiKey: string;
};
type Session = {
  readonly owner: AuthSessionId;
  readonly provider: GatewayStartInput["provider"];
  readonly upstreamState: string;
  readonly deadline: number;
  auth: GatewayAuth;
};

const make = (
  configuration: Configuration | undefined,
  refreshModels: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;
    const sessions = new Map<GatewayFlowId, Session>();
    const lock = yield* Semaphore.make(1);
    const refresh = refreshModels.pipe(
      Effect.timeout("15 seconds"),
      Effect.catchCause(() =>
        Effect.logWarning(
          "Model gateway account changed; provider catalog refresh will retry on the next provider refresh.",
        ),
      ),
    );
    const request = <S extends Schema.ConstraintDecoder<unknown, never>>(
      path: string,
      schema: S,
      init?: { readonly method: "POST" | "PATCH" | "DELETE" | "PUT"; readonly body?: unknown },
      inference = false,
    ) =>
      Effect.gen(function* () {
        if (!configuration) return yield* new ModelGatewayError({ reason: "unavailable" });
        let outgoing = HttpClientRequest.make(init?.method ?? "GET")(
          new URL(path, configuration.url),
          {
            headers: {
              authorization: `Bearer ${inference ? configuration.apiKey : configuration.managementKey}`,
            },
          },
        );
        if (init?.body !== undefined)
          outgoing = HttpClientRequest.setBody(outgoing, yield* HttpBody.json(init.body));
        const response = yield* httpClient
          .execute(outgoing)
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        return yield* HttpClientResponse.schemaBodyJson(schema)(response);
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new ModelGatewayError({ reason: "unavailable" })),
      );
    const endpointGroups = Effect.fn("ModelGateway.endpointGroups")(function* () {
      const config = yield* request("/v8/management/config", GatewayConfiguration);
      return config["api-keys"]?.["openai-compatibility"] ?? [];
    });
    const snapshot = Effect.fn("ModelGateway.snapshot")(function* () {
      if (!configuration) return { kind: "unconfigured" } satisfies GatewaySnapshot;
      return yield* Effect.gen(function* () {
        const accounts = yield* request("/v8/management/credentials", Credentials);
        const endpoints = yield* endpointGroups();
        const models = yield* request("/v1/models", Models, undefined, true);
        return {
          kind: "ready",
          accounts: [
            ...accounts.files
              .filter((account) => !account.runtime_only)
              .map(
                (account) =>
                  ({
                    id: GatewayAccountId.make(account.name),
                    provider: account.provider,
                    label: account.email || account.label || account.name,
                    disabled: account.disabled ?? false,
                    status:
                      account.status === "error"
                        ? "error"
                        : account.unavailable
                          ? "unavailable"
                          : "ready",
                    message:
                      account.status === "error"
                        ? "Reconnect this account."
                        : account.unavailable
                          ? "This account is temporarily unavailable."
                          : null,
                  }) satisfies GatewayAccount,
              ),
            ...endpoints.map(
              (endpoint) =>
                ({
                  id: endpointId(endpoint.name),
                  provider: "openai-compatible",
                  label: endpoint.name,
                  disabled: endpoint.disabled ?? false,
                  status: "ready",
                  message: null,
                }) satisfies GatewayAccount,
            ),
          ],
          models: models.data,
        } satisfies GatewaySnapshot;
      }).pipe(
        Effect.catchTags({
          ModelGatewayError: () =>
            Effect.succeed({ kind: "unavailable" } satisfies GatewaySnapshot),
        }),
      );
    });
    const owned = (input: GatewayFlowInput, owner: AuthSessionId) =>
      Effect.gen(function* () {
        const session = sessions.get(input.flowId);
        if (!session || session.owner !== owner)
          return yield* new ModelGatewayError({ reason: "invalid-flow" });
        const now = yield* Clock.currentTimeMillis;
        if (session.deadline <= now && session.auth.kind === "waiting") {
          const cancellation = yield* request(
            `/v8/management/oauth/session?state=${encodeURIComponent(session.upstreamState)}`,
            CancelResult,
            { method: "DELETE" },
          );
          const completed =
            !cancellation.cancelled &&
            (yield* request(
              `/v8/management/oauth/status?state=${encodeURIComponent(session.upstreamState)}`,
              LoginStatus,
            )).status === "ok";
          session.auth = completed
            ? { kind: "succeeded", flowId: input.flowId }
            : { kind: "failed", flowId: input.flowId, reason: "expired" };
          if (completed) yield* refresh;
        }
        return session;
      });
    const status = Effect.fn("ModelGateway.status")(function* (
      input: GatewayFlowInput,
      owner: AuthSessionId,
    ) {
      const session = yield* owned(input, owner);
      if (session.auth.kind !== "waiting") return session.auth;
      const result = yield* request(
        `/v8/management/oauth/status?state=${encodeURIComponent(session.upstreamState)}`,
        LoginStatus,
      );
      if (result.status === "ok") {
        session.auth = { kind: "succeeded", flowId: input.flowId };
        yield* refresh;
      }
      if (result.status === "error")
        session.auth = { kind: "failed", flowId: input.flowId, reason: "rejected" };
      return session.auth;
    });
    return ModelGateway.of({
      snapshot,
      addEndpoint: (input) =>
        Effect.gen(function* () {
          const baseUrl = yield* Effect.try({
            try: () => new URL(input.baseUrl),
            catch: () => new ModelGatewayError({ reason: "invalid-endpoint" }),
          });
          if (
            !["http:", "https:"].includes(baseUrl.protocol) ||
            baseUrl.username ||
            baseUrl.password ||
            baseUrl.search ||
            baseUrl.hash
          ) {
            return yield* new ModelGatewayError({ reason: "invalid-endpoint" });
          }
          const groups = yield* endpointGroups();
          if (groups.some((group) => group.name === input.name))
            return yield* new ModelGatewayError({ reason: "duplicate-endpoint" });
          yield* request("/v8/management/config/api-keys/openai-compatibility", MutationResult, {
            method: "PUT",
            body: [
              ...groups,
              {
                name: input.name,
                "base-url": baseUrl.href.replace(/\/$/, ""),
                keys: [{ "api-key": input.apiKey }],
                models: [...new Set(input.models)].map((name) => ({ name, alias: name })),
              },
            ],
          });
          yield* refresh;
          return yield* snapshot();
        }).pipe(lock.withPermits(1)),
      start: (input, owner) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // Terminal states remain readable briefly; abandoned sessions cannot grow this map forever.
          for (const [id, session] of sessions) {
            if (session.deadline + 60_000 < now) sessions.delete(id);
            else if (
              session.auth.kind === "waiting" &&
              session.deadline > now &&
              session.owner === owner &&
              session.provider === input.provider
            ) {
              return yield* new ModelGatewayError({ reason: "busy" });
            }
          }
          const login = yield* request(
            `/v8/management/oauth/auth-url?provider=${input.provider}&flow=device`,
            Login,
          );
          const flowId = GatewayFlowId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() => new ModelGatewayError({ reason: "unavailable" })),
            ),
          );
          const deadline = now + Math.min(Math.max(login.expires_in ?? 600, 1), 900) * 1_000;
          const auth: GatewayAuth = {
            kind: "waiting",
            flowId,
            provider: input.provider,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(deadline)),
            interaction:
              login.flow === "device" && login.user_code
                ? { type: "deviceCode", id: flowId, url: login.url, userCode: login.user_code }
                : {
                    type: "browser",
                    id: flowId,
                    url: login.url,
                    requiresConsent: false,
                    acceptsCallback: login.flow !== "device",
                  },
          };
          sessions.set(flowId, {
            owner,
            provider: input.provider,
            upstreamState: login.state,
            deadline,
            auth,
          });
          return auth;
        }).pipe(lock.withPermits(1)),
      status: (input, owner) => status(input, owner).pipe(lock.withPermits(1)),
      complete: (input, owner) =>
        Effect.gen(function* () {
          const session = yield* owned(input, owner);
          if (session.auth.kind !== "waiting") return session.auth;
          if (
            session.auth.interaction.type !== "browser" ||
            !session.auth.interaction.acceptsCallback
          ) {
            return yield* new ModelGatewayError({ reason: "invalid-callback" });
          }
          const callback = yield* Effect.try({
            try: () => new URL(input.callbackUrl),
            catch: () => new ModelGatewayError({ reason: "invalid-callback" }),
          });
          if (
            !["http:", "https:"].includes(callback.protocol) ||
            callback.searchParams.get("state") !== session.upstreamState ||
            (!callback.searchParams.get("code") && !callback.searchParams.get("error"))
          ) {
            return yield* new ModelGatewayError({ reason: "invalid-callback" });
          }
          yield* request("/v8/management/oauth/callback", MutationResult, {
            method: "POST",
            body: { provider: session.provider, redirect_url: input.callbackUrl },
          });
          return yield* status(input, owner);
        }).pipe(lock.withPermits(1)),
      cancel: (input, owner) =>
        Effect.gen(function* () {
          const session = yield* owned(input, owner);
          if (session.auth.kind !== "waiting") return session.auth;
          const result = yield* request(
            `/v8/management/oauth/session?state=${encodeURIComponent(session.upstreamState)}`,
            CancelResult,
            { method: "DELETE" },
          );
          // A completion that won the upstream race must be shown as connected, not cancelled.
          if (!result.cancelled) return yield* status(input, owner);
          session.auth = { kind: "cancelled", flowId: input.flowId };
          return session.auth;
        }).pipe(lock.withPermits(1)),
      setEnabled: (input) =>
        Effect.gen(function* () {
          if (input.accountId.startsWith("endpoint:")) {
            const groups = yield* endpointGroups();
            if (!groups.some((group) => endpointId(group.name) === input.accountId))
              return yield* new ModelGatewayError({ reason: "invalid-account" });
            yield* request("/v8/management/config/api-keys/openai-compatibility", MutationResult, {
              method: "PUT",
              body: groups.map((group) =>
                endpointId(group.name) === input.accountId
                  ? { ...group, disabled: !input.enabled }
                  : group,
              ),
            });
          } else {
            yield* request("/v8/management/credentials/status", MutationResult, {
              method: "PATCH",
              body: { name: input.accountId, disabled: !input.enabled },
            });
          }
          yield* refresh;
          return yield* snapshot();
        }).pipe(lock.withPermits(1)),
      remove: (input) =>
        Effect.gen(function* () {
          if (input.accountId.startsWith("endpoint:")) {
            const groups = yield* endpointGroups();
            if (!groups.some((group) => endpointId(group.name) === input.accountId))
              return yield* new ModelGatewayError({ reason: "invalid-account" });
            yield* request("/v8/management/config/api-keys/openai-compatibility", MutationResult, {
              method: "PUT",
              body: groups.filter((group) => endpointId(group.name) !== input.accountId),
            });
          } else {
            yield* request(
              `/v8/management/credentials?name=${encodeURIComponent(input.accountId)}`,
              MutationResult,
              { method: "DELETE" },
            );
          }
          yield* refresh;
          return yield* snapshot();
        }).pipe(lock.withPermits(1)),
    });
  });

export const layerWithConfiguration = (
  configuration: Configuration | undefined,
  refreshModels: Effect.Effect<void> = Effect.void,
) =>
  Layer.effect(ModelGateway, make(configuration, refreshModels)).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeCrypto.layer),
  );
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const configuration = yield* readConfiguration(process.env);
    return layerWithConfiguration(configuration, registry.refresh().pipe(Effect.asVoid));
  }),
);
