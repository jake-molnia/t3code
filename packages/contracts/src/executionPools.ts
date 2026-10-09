import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ExecutionPoolId = TrimmedNonEmptyString.pipe(Schema.brand("ExecutionPoolId"));
export type ExecutionPoolId = typeof ExecutionPoolId.Type;
export const ExecutionPool = Schema.Struct({
  id: ExecutionPoolId,
  label: Schema.String,
  available: Schema.Boolean,
  resources: Schema.NullOr(HostResourcesSnapshot),
  providerDrivers: Schema.Array(ProviderDriverKind),
});
export type ExecutionPool = typeof ExecutionPool.Type;
export const ExecutionPoolsSnapshot = Schema.Struct({
  defaultPoolId: ExecutionPoolId,
  pools: Schema.Array(ExecutionPool),
});
export type ExecutionPoolsSnapshot = typeof ExecutionPoolsSnapshot.Type;
