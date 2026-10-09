import type {
  ExecutionPoolsSnapshot,
  HostResourcesSnapshot,
  ProviderDriverKind,
} from "@t3tools/contracts";

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}

export function chooseExecutionPool(
  catalog: { snapshot: ExecutionPoolsSnapshot | null; receivedAt: number },
  driver: ProviderDriverKind,
  weights: Readonly<Record<string, number>>,
  now: number,
) {
  const pools = catalog.snapshot?.pools ?? [];
  const id = chooseLoadBalancedEnvironment(
    pools
      .filter((pool) => pool.available && pool.providerDrivers.includes(driver))
      .map((pool) => ({
        environmentId: pool.id,
        resources: pool.resources,
        receivedAt: catalog.receivedAt,
        weight: weights[pool.id] ?? 50,
      })),
    now,
  );
  return pools.find((pool) => pool.id === id)?.id ?? null;
}

/** A pinned draft may follow a provider change only while its workspace context is untouched. */
export function reconcileExecutionPoolProvider(input: {
  snapshot: ExecutionPoolsSnapshot | null;
  selectedPoolId: ExecutionPoolsSnapshot["defaultPoolId"] | null;
  driver: ProviderDriverKind;
  automatic: boolean;
  placementLocked: boolean;
  balancedPoolId: ExecutionPoolsSnapshot["defaultPoolId"] | null;
}) {
  const selected = input.snapshot?.pools.find((pool) => pool.id === input.selectedPoolId);
  const incompatible = selected !== undefined && !selected.providerDrivers.includes(input.driver);
  return {
    incompatible,
    reselect: incompatible && input.automatic && !input.placementLocked,
    replacementPoolId:
      incompatible && input.automatic && !input.placementLocked ? input.balancedPoolId : null,
  };
}
