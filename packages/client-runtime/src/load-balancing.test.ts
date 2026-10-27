import { ExecutionPoolId, ProviderDriverKind, type ExecutionPool } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  hasExecutionPoolAffinity,
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
  });
  it("uses preferences for native pools without inventing capacity measurements", () => {
    const candidates = catalog([
      pool(gompers, { resources: null }),
      pool(portal, { resources: null }),
    ]);
    expect(chooseExecutionPool(candidates, codex, {}, now)).toBe(gompers);
    expect(chooseExecutionPool(candidates, codex, { [portal]: 100 }, now)).toBe(portal);
    expect(chooseExecutionPool(candidates, codex, { [gompers]: 0, [portal]: 0 }, now)).toBeNull();
    expect(chooseExecutionPool(candidates, codex, {}, now + 15001)).toBeNull();
    expect(chooseExecutionPool(candidates, codex, {}, now - 5001)).toBeNull();
  });
  it("still excludes unavailable, incompatible and full unmeasured pools", () => {
    for (const overrides of [
      { available: false },
      { providerDrivers: [other] },
      { requestCapacity: { profile: "native", sampledAt: now, availableSlots: 0 } },
    ])
      expect(
        chooseExecutionPool(
          catalog([pool(gompers, { resources: null, ...overrides })]),
          codex,
          {},
          now,
        ),
      ).toBeNull();
  });
  it("prefers measured spare capacity before unmeasured pools", () => {
    expect(
      chooseExecutionPool(
        catalog([pool(gompers, { resources: null }), pool(portal)]),
        codex,
        { [gompers]: 100, [portal]: 1 },
        now,
      ),
    ).toBe(portal);
  });
});

it("treats an empty provider allowlist as unrestricted for selection and provider changes", () => {
  const candidates = catalog([pool(gompers, { resources: null, providerDrivers: [] })]);
  expect(chooseExecutionPool(candidates, other, {}, now)).toBe(gompers);
  expect(
    reconcileExecutionPoolProvider({
      snapshot: candidates.snapshot,
      selectedPoolId: gompers,
      driver: other,
      automatic: true,
      placementLocked: false,
      balancedPoolId: null,
    }),
  ).toEqual({ incompatible: false, reselect: false, replacementPoolId: null });
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

describe("persisted new-thread branch hints", () => {
  // Captured from the V5 browser before enabling automatic balancing.
  const draft = {
    threadId: "c5250a68-4f4e-4267-9a42-339297ed321b",
    executionPoolId: "gompers",
    executionPoolSelection: "auto",
    branch: "main",
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  };
  const resolve = (
    input: {
      manual?: boolean;
      worktreePath?: string | null;
      hasAttachments?: boolean;
      threadLocked?: boolean;
    } = {},
  ) => {
    const placementLocked = hasExecutionPoolAffinity({
      threadLocked: input.threadLocked ?? false,
      hasAttachments: input.hasAttachments ?? false,
      worktreePath: input.worktreePath ?? draft.worktreePath,
    });
    return resolveExecutionPoolSelection({
      catalog: { ...catalog([pool(gompers), pool(portal)]), pending: false },
      selectedPoolId: ExecutionPoolId.make(draft.executionPoolId),
      driver: codex,
      automatic: !input.manual && draft.executionPoolSelection === "auto" && !placementLocked,
      placementLocked,
      weights: { [gompers]: 0, [portal]: 50 },
      now,
    });
  };
  it("moves the UI-created main/local draft to Portal when its cached pool becomes manual-only", () => {
    expect(draft.branch).toBe("main");
    expect(draft.envMode).toBe("local");
    expect(resolve()).toBe(portal);
  });
  it("keeps explicit manual choices, real worktrees, staged attachments, and started threads pinned", () => {
    expect(resolve({ manual: true })).toBe(gompers);
    expect(resolve({ worktreePath: "/workspace/bound/worktrees/existing" })).toBe(gompers);
    expect(resolve({ hasAttachments: true })).toBe(gompers);
    expect(resolve({ threadLocked: true })).toBe(gompers);
  });
});

describe("reservation capacity", () => {
  const full = pool(gompers, {
    requestCapacity: { profile: "t3-v7", sampledAt: now, availableSlots: 0 },
  });
  it("excludes freshly measured zero capacity without rewriting actual utilization", () => {
    expect(
      chooseExecutionPool(
        catalog([full, pool(portal)]),
        codex,
        { [gompers]: 100, [portal]: 1 },
        now,
      ),
    ).toBe(portal);
    expect(chooseExecutionPool(catalog([full]), codex, {}, now)).toBeNull();
    expect(full.resources?.cpuUtilization).toBe(0.2);
  });
  it("does not treat stale or unavailable reservation inventory as measured zero", () => {
    for (const requestCapacity of [
      null,
      { profile: "t3-v7", sampledAt: now - 16000, availableSlots: 0 },
    ])
      expect(
        chooseExecutionPool(catalog([pool(gompers, { requestCapacity })]), codex, {}, now),
      ).toBe(gompers);
  });
  it("preserves explicit choices and bound workspace affinity when capacity is exhausted", () => {
    for (const placement of [
      { automatic: false, placementLocked: false },
      { automatic: true, placementLocked: true },
    ])
      expect(
        resolveExecutionPoolSelection({
          catalog: { ...catalog([full, pool(portal)]), pending: false },
          selectedPoolId: gompers,
          driver: codex,
          ...placement,
          weights: {},
          now,
        }),
      ).toBe(gompers);
  });
});
