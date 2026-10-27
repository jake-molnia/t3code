import { ExecutionPoolId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExecutionPools, PoolError } from "../ExecutionPools.ts";
import type { Placement } from "../../sandbox/Configuration.ts";

export const placement = (id = "local", profile = "t3"): Placement => ({
  id: ExecutionPoolId.make(id),
  label: id,
  namespace: "test-sandboxes",
  image: `t3-worker@sha256:${"a".repeat(64)}`,
  profile,
  providerDrivers: [ProviderDriverKind.make("codex")],
  resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
  storage: { size: "10Gi" },
});

export const poolsLayer = (placements = [placement()], defaultPoolId = placements[0]!.id) =>
  Layer.succeed(ExecutionPools, {
    enabled: placements.length > 0,
    defaultPoolId,
    get: (id) => {
      const found = placements.find((value) => value.id === (id ?? defaultPoolId));
      return found
        ? Effect.succeed(found)
        : Effect.fail(new PoolError({ detail: "Execution pool is unavailable or not configured" }));
    },
    snapshot: Effect.succeed({
      defaultPoolId,
      pools: placements.map((value) => ({
        id: value.id,
        label: value.label,
        available: true,
        providerDrivers: value.providerDrivers,
        resources: null,
        requestCapacity: null,
      })),
    }),
  });
