import { ExecutionPoolId, ProviderDriverKind, type ExecutionPool } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  chooseExecutionPool,
  reconcileExecutionPoolProvider,
  resolveExecutionPoolSelection,
} from "./load-balancing.ts";

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

describe("draft execution pool placement", () => {
  const draft = {
    catalog: { ...catalog([pool(gompers), pool(portal)]), pending: false },
    selectedPoolId: gompers,
    driver: codex,
    automatic: true,
    placementLocked: false,
    weights: { [gompers]: 0 },
    now,
  };
  it("rebalances a restored default pin when its pool becomes manual-only", () => {
    expect(resolveExecutionPoolSelection(draft)).toBe(portal);
  });
  it("does not dispatch a cached automatic choice while catalog loading or refresh is pending", () => {
    expect(
      resolveExecutionPoolSelection({ ...draft, catalog: { ...draft.catalog, pending: true } }),
    ).toBeNull();
    expect(
      resolveExecutionPoolSelection({
        ...draft,
        catalog: { snapshot: null, receivedAt: 0, pending: true },
      }),
    ).toBeNull();
  });
  it("does not fall back to the default for stale or exhausted automatic candidates", () => {
    expect(resolveExecutionPoolSelection({ ...draft, now: now + 15001 })).toBeNull();
    expect(
      resolveExecutionPoolSelection({ ...draft, weights: { [gompers]: 0, [portal]: 0 } }),
    ).toBeNull();
  });
  it("preserves explicit manual choices and workspace-bound placements", () => {
    expect(resolveExecutionPoolSelection({ ...draft, automatic: false })).toBe(gompers);
    expect(resolveExecutionPoolSelection({ ...draft, placementLocked: true })).toBe(gompers);
  });
  it("waits for the catalog before selecting a default for an unassigned manual draft", () => {
    expect(
      resolveExecutionPoolSelection({
        ...draft,
        automatic: false,
        selectedPoolId: null,
        catalog: { snapshot: null, receivedAt: 0, pending: true },
      }),
    ).toBeNull();
  });
  it("rebalances against the selected provider rather than keeping an incompatible cached pin", () => {
    expect(
      resolveExecutionPoolSelection({
        ...draft,
        driver: other,
        catalog: {
          ...catalog([pool(gompers), pool(portal, { providerDrivers: [other] })]),
          pending: false,
        },
      }),
    ).toBe(portal);
  });
});

it("resolves mixed-provider automatic submissions independently before dispatch", () => {
  const candidates = {
    ...catalog([pool(gompers), pool(portal, { providerDrivers: [other] })]),
    pending: false,
  };
  const placements = [codex, other].map((driver) =>
    resolveExecutionPoolSelection({
      catalog: candidates,
      selectedPoolId: gompers,
      driver,
      automatic: true,
      placementLocked: false,
      weights: {},
      now,
    }),
  );
  expect(placements).toEqual([gompers, portal]);
});
