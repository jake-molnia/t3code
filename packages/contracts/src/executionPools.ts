import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ExecutionPoolId = TrimmedNonEmptyString.pipe(Schema.brand("ExecutionPoolId"));
export type ExecutionPoolId = typeof ExecutionPoolId.Type;
/** CPU/memory/pod-request fit estimate, not a Kubernetes scheduling guarantee. */
export const ExecutionPoolRequestCapacity = Schema.Struct({
  profile: TrimmedNonEmptyString,
  sampledAt: NonNegativeInt,
  availableSlots: NonNegativeInt,
});
export const ExecutionPool = Schema.Struct({
  id: ExecutionPoolId,
  label: Schema.String,
  available: Schema.Boolean,
  resources: Schema.NullOr(HostResourcesSnapshot),
  requestCapacity: Schema.optionalKey(Schema.NullOr(ExecutionPoolRequestCapacity)),
  providerDrivers: Schema.Array(ProviderDriverKind),
});
export type ExecutionPool = typeof ExecutionPool.Type;
export const ExecutionPoolsSnapshot = Schema.Struct({
  sandboxIdeAvailable: Schema.optional(Schema.Boolean),
  defaultPoolId: ExecutionPoolId,
  pools: Schema.Array(ExecutionPool),
});
export type ExecutionPoolsSnapshot = typeof ExecutionPoolsSnapshot.Type;
