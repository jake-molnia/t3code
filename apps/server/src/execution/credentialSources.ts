// @effect-diagnostics globalFetch:off -- Authenticated worker-to-central credential transport boundary.
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as C from "@t3tools/contracts";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createExecutionClient } from "./ExecutionClient.ts";

export const CredentialSource = Schema.Struct({
  endpoint: Schema.String,
  token: Schema.String,
  identity: ExecutionIdentity,
});
// Refresh tokens and ID tokens never cross the execution credential boundary.
export const CodexAccess = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.Null,
  expiresAt: Schema.Finite,
  earliestRefreshAt: Schema.Null,
  scopes: Schema.Array(Schema.String),
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
});
const encodeAccessRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ threadId: C.ThreadId, instanceId: C.ProviderInstanceId })),
);
async function requestBroker(current: McpProviderSessionConfig, instanceId: C.ProviderInstanceId) {
  const response = await fetch(new URL("/internal/execution/provider-access", current.endpoint), {
    method: "POST",
    headers: { authorization: current.authorizationHeader, "content-type": "application/json" },
    body: encodeAccessRequest({ threadId: current.threadId, instanceId }),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Credential broker rejected access");
  return await response.json();
}
export class CredentialSources extends Context.Service<
  CredentialSources,
  {
    readonly register: (
      id: C.ProviderInstanceId,
      access: Effect.Effect<typeof CodexAccess.Type, C.ProviderSetupError>,
    ) => void;
    readonly export: (
      id: C.ProviderInstanceId,
    ) => Option.Option<Effect.Effect<typeof CodexAccess.Type, C.ProviderSetupError>>;
    readonly configureBroker: (
      id: C.ProviderInstanceId,
      current: () => McpProviderSessionConfig | undefined,
    ) => void;
    readonly configure: (id: C.ProviderInstanceId, source: typeof CredentialSource.Type) => void;
    readonly access: (
      id: C.ProviderInstanceId,
    ) => Option.Option<Effect.Effect<typeof CodexAccess.Type, C.ProviderSetupError>>;
  }
>()("t3/execution/credentialSources") {}
export const layer = Layer.sync(CredentialSources, () => {
  const owners = new Map<
    C.ProviderInstanceId,
    Effect.Effect<typeof CodexAccess.Type, C.ProviderSetupError>
  >();
  const brokers = new Map<C.ProviderInstanceId, () => McpProviderSessionConfig | undefined>();
  const sources = new Map<C.ProviderInstanceId, ReturnType<typeof createExecutionClient>>();
  return CredentialSources.of({
    register: (id, access) => {
      owners.set(id, access);
    },
    export: (id) => Option.fromUndefinedOr(owners.get(id)),
    configureBroker: (id, current) => {
      brokers.set(id, current);
    },
    configure: (id, source) => {
      sources.set(id, createExecutionClient(source));
      const broker = brokers.get(id);
      if (broker && broker() === undefined) brokers.delete(id);
    },
    access: (id) => {
      const client = sources.get(id);
      const broker = brokers.get(id);
      return client || broker
        ? Option.some(
            Effect.tryPromise(async () => {
              if (broker) {
                const current = broker();
                if (!current || current.providerInstanceId !== id)
                  throw new Error("Credential session unavailable");
                return await requestBroker(current, id);
              }
              if (!client) throw new Error("Credential source unavailable");
              return await client.transient("auth.executionCredentials", {
                instanceId: id,
                input: null,
              });
            }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(CodexAccess)),
              Effect.mapError(
                () =>
                  new C.ProviderSetupError({
                    instanceId: id,
                    operation: "access",
                    detail: "The credential owner is unavailable. Reconnect the provider.",
                  }),
              ),
            ),
          )
        : Option.none();
    },
  });
});
