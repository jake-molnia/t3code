import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const RETENTION_MS = 92 * 24 * 60 * 60 * 1000;
export const UsageRecord = Schema.Struct({
  provider: C.UsageProviderKind,
  timestampMs: Schema.Number,
  model: Schema.String,
  rateModel: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  totals: C.UsageTokenTotals,
  reportedCostUsd: Schema.NullOr(Schema.Number),
  speed: Schema.Literals(["standard", "fast", "ultrafast"]),
  dedupeKey: Schema.NullOr(Schema.String),
});
export const HistoryFile = Schema.Struct({
  path: Schema.String,
  records: Schema.Array(UsageRecord),
});
export const HistorySource = Schema.Struct({
  provider: C.UsageProviderKind,
  dir: Schema.String,
  volumeId: Schema.String,
  hostId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(C.UsageSourceStatus),
  message: Schema.optionalKey(Schema.String),
  action: Schema.optional(Schema.Literal("enableCursorKeychain")),
  refreshing: C.UsageSource.fields.refreshing,
  files: Schema.NullOr(Schema.Array(HistoryFile)),
});
export const History = Schema.Array(HistorySource);
export type History = typeof History.Type;
export type HistorySource = typeof HistorySource.Type;

/** Replaces native scanning while preserving the upstream pricing and aggregation path. */
export class UsageHistorySources extends Context.Service<
  UsageHistorySources,
  {
    readonly read: Effect.Effect<History, C.UsageReadError>;
  }
>()("t3/usage/UsageHistorySources") {}
