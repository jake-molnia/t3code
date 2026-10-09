import { ExecutionPoolId, ProviderDriverKind, type ExecutionPool } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { chooseExecutionPool, reconcileExecutionPoolProvider } from "./load-balancing.ts";

const codex = ProviderDriverKind.make("codex");
const other = ProviderDriverKind.make("other");
const gompers = ExecutionPoolId.make("gompers");
const portal = ExecutionPoolId.make("portal");
const now = 100_000;
const resources = {
  sampledAt: now,
  cpuCount: 8,
  cpuUtilization: 0.2,
  totalMemoryBytes: 32000,
  availableMemoryBytes: 24000,
};
const pool = (id: typeof gompers, overrides: Partial<ExecutionPool> = {}): ExecutionPool => ({
  id,
  label: id,
  available: true,
  resources,
  providerDrivers: [codex],
  ...overrides,
});
const catalog = (pools: readonly ExecutionPool[], receivedAt = now) => ({
  snapshot: { defaultPoolId: gompers, pools },
  receivedAt,
});

describe("execution pool balancing", () => {
  it("uses existing capacity scoring and preferences", () => {
    const candidates = catalog([
      pool(gompers),
      pool(portal, { resources: { ...resources, cpuCount: 4 } }),
    ]);
    expect(chooseExecutionPool(candidates, codex, {}, now)).toBe(gompers);
    expect(chooseExecutionPool(candidates, codex, { [gompers]: 25, [portal]: 100 }, now)).toBe(
      portal,
    );
    expect(chooseExecutionPool(candidates, codex, { [gompers]: 0, [portal]: 0 }, now)).toBeNull();
  });
  it("excludes unhealthy, unsupported, stale and resource-starved pools", () => {
    expect(
      chooseExecutionPool(
        catalog([pool(gompers, { available: false }), pool(portal, { providerDrivers: [other] })]),
        codex,
        {},
        now,
      ),
    ).toBeNull();
    expect(chooseExecutionPool(catalog([pool(gompers)], now - 15001), codex, {}, now)).toBeNull();
    expect(
      chooseExecutionPool(
        catalog([pool(gompers, { resources: { ...resources, cpuUtilization: 0.96 } })]),
        codex,
        {},
        now,
      ),
    ).toBeNull();
    expect(
      chooseExecutionPool(catalog([pool(gompers, { resources: null })]), codex, {}, now),
    ).toBeNull();
  });
});

describe("provider changes on pinned drafts", () => {
  const candidates = catalog([pool(gompers), pool(portal, { providerDrivers: [other] })]);
  const changed = {
    snapshot: candidates.snapshot,
    selectedPoolId: gompers,
    driver: other,
    automatic: true,
    placementLocked: false,
    balancedPoolId: chooseExecutionPool(candidates, other, {}, now),
  };
  it("reselects an incompatible automatic pin using the existing scorer", () => {
    expect(reconcileExecutionPoolProvider(changed)).toEqual({
      incompatible: true,
      reselect: true,
      replacementPoolId: portal,
    });
  });
  it("blocks incompatible manual pins without changing their placement", () => {
    expect(reconcileExecutionPoolProvider({ ...changed, automatic: false })).toEqual({
      incompatible: true,
      reselect: false,
      replacementPoolId: null,
    });
  });
  it("blocks rather than moving attachment or workspace-bound drafts", () => {
    expect(reconcileExecutionPoolProvider({ ...changed, placementLocked: true })).toEqual({
      incompatible: true,
      reselect: false,
      replacementPoolId: null,
    });
  });
  it("keeps compatible pins despite capacity preference changes", () => {
    expect(reconcileExecutionPoolProvider({ ...changed, driver: codex })).toEqual({
      incompatible: false,
      reselect: false,
      replacementPoolId: null,
    });
  });
  it("remains blocked while an automatic replacement is unavailable", () => {
    expect(reconcileExecutionPoolProvider({ ...changed, balancedPoolId: null })).toEqual({
      incompatible: true,
      reselect: true,
      replacementPoolId: null,
    });
  });
});
