import { ExecutionPoolId, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Name = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/),
  Schema.isMaxLength(63),
);
const Quantity = Schema.String.check(
  Schema.isPattern(
    /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)(?:m|[EPTGMK]i?|[eE][+-]?[0-9]+)?$/,
  ),
);
const Resources = Schema.Struct({ cpu: Quantity, memory: Quantity });
export const Placement = Schema.Struct({
  id: ExecutionPoolId,
  label: Schema.NonEmptyString,
  namespace: Name,
  image: Schema.String.check(Schema.isPattern(/^\S+@sha256:[a-f0-9]{64}$/)),
  profile: Schema.NonEmptyString,
  providerDrivers: Schema.Array(ProviderDriverKind),
  resources: Schema.Struct({ requests: Resources, limits: Resources }),
  storage: Schema.Struct({ size: Quantity, storageClassName: Schema.optionalKey(Name) }),
  workerEnvSecret: Schema.optionalKey(Name),
  workerEnvConfigMap: Schema.optionalKey(Name),
  serviceAccountName: Schema.optionalKey(Name),
});
export type Placement = typeof Placement.Type;
export const Configuration = Schema.Struct({
  defaultPoolId: ExecutionPoolId,
  pools: Schema.Array(Placement),
});
