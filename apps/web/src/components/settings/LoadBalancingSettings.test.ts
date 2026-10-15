import { ExecutionPoolId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loadPreferenceForWeight, summarizeLoadPreferences } from "./LoadBalancingSettings";

const pools = [
  { id: ExecutionPoolId.make("a"), label: "Gompers" },
  { id: ExecutionPoolId.make("b"), label: "Portal" },
  { id: ExecutionPoolId.make("c"), label: "Spare" },
];

describe("loadPreferenceForWeight", () => {
  it("snaps legacy slider weights onto the four preferences", () => {
    expect(loadPreferenceForWeight(undefined)).toBe(50);
    expect(loadPreferenceForWeight(0)).toBe(0);
    expect(loadPreferenceForWeight(10)).toBe(25);
    expect(loadPreferenceForWeight(50)).toBe(50);
    expect(loadPreferenceForWeight(80)).toBe(100);
  });
});

describe("summarizeLoadPreferences", () => {
  it("is empty when every pool is at Normal", () => {
    expect(summarizeLoadPreferences(pools, { a: 50 })).toBeNull();
  });

  it("lists only the pools that differ from Normal, in list order", () => {
    expect(summarizeLoadPreferences(pools, { b: 100, c: 0 })).toBe(
      "Portal prefer · Spare manual only",
    );
  });
});
