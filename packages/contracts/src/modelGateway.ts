import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderAuthInteraction } from "./providerSetup.ts";

export const GatewayAccountId = TrimmedNonEmptyString.pipe(Schema.brand("GatewayAccountId"));
export type GatewayAccountId = typeof GatewayAccountId.Type;
export const GatewayFlowId = TrimmedNonEmptyString.pipe(Schema.brand("GatewayFlowId"));
export type GatewayFlowId = typeof GatewayFlowId.Type;
export const GatewayProvider = Schema.Literals([
  "codex",
  "claude",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "devin",
  "meta",
]);
export type GatewayProvider = typeof GatewayProvider.Type;
export const GatewayAccount = Schema.Struct({
  id: GatewayAccountId,
  provider: Schema.String,
  label: Schema.String,
  disabled: Schema.Boolean,
  status: Schema.Literals(["ready", "unavailable", "error"]),
  message: Schema.NullOr(Schema.String),
});
export type GatewayAccount = typeof GatewayAccount.Type;
export const GatewaySnapshot = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unconfigured") }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    accounts: Schema.Array(GatewayAccount),
    catalog: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("ready"),
        models: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
      Schema.Struct({ kind: Schema.Literal("unavailable") }),
    ]),
  }),
]);
export type GatewaySnapshot = typeof GatewaySnapshot.Type;
export const GatewayAuth = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    flowId: GatewayFlowId,
    provider: GatewayProvider,
    interaction: ProviderAuthInteraction,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({ kind: Schema.Literal("succeeded"), flowId: GatewayFlowId }),
  Schema.Struct({ kind: Schema.Literal("cancelled"), flowId: GatewayFlowId }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    flowId: GatewayFlowId,
    reason: Schema.Literals(["expired", "rejected", "unavailable"]),
  }),
]);
export type GatewayAuth = typeof GatewayAuth.Type;
export const GatewayStartInput = Schema.Struct({ provider: GatewayProvider });
export type GatewayStartInput = typeof GatewayStartInput.Type;
export const GatewayFlowInput = Schema.Struct({ flowId: GatewayFlowId });
export type GatewayFlowInput = typeof GatewayFlowInput.Type;
export const GatewayCompleteInput = Schema.Struct({
  flowId: GatewayFlowId,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type GatewayCompleteInput = typeof GatewayCompleteInput.Type;
export const GatewayAddEndpointInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  models: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type GatewayAddEndpointInput = typeof GatewayAddEndpointInput.Type;
export const GatewayAccountInput = Schema.Struct({ accountId: GatewayAccountId });
export type GatewayAccountInput = typeof GatewayAccountInput.Type;
export const GatewaySetEnabledInput = Schema.Struct({
  accountId: GatewayAccountId,
  enabled: Schema.Boolean,
});
export type GatewaySetEnabledInput = typeof GatewaySetEnabledInput.Type;
export class ModelGatewayError extends Schema.TaggedError<ModelGatewayError>()(
  "ModelGatewayError",
  {
    reason: Schema.Literals([
      "unavailable",
      "invalid-flow",
      "invalid-callback",
      "invalid-endpoint",
      "invalid-account",
      "duplicate-endpoint",
      "busy",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "The model gateway is unavailable. Try again once it is connected.";
      case "invalid-flow":
        return "This sign-in has expired. Start a new sign-in.";
      case "invalid-callback":
        return "Paste the callback URL from this sign-in.";
      case "invalid-endpoint":
        return "Enter an HTTP or HTTPS API base URL without credentials or a query string.";
      case "duplicate-endpoint":
        return "An API endpoint with this name already exists.";
      case "invalid-account":
        return "This account no longer exists. Refresh the account list.";
      case "busy":
        return "A sign-in is already in progress for this account provider.";
    }
  }
}
