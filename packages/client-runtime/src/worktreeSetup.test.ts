import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { resolveLatestWorktreeSetup, resolveVisibleWorktreeSetup } from "./worktreeSetup.ts";

const snapshot: WorktreeSetupSnapshot = {
  threadId: ThreadId.make("resumed-thread"),
  kind: "sandbox-resume",
  phase: "running",
  startedAt: "2026-10-13T12:00:01.000Z",
  endedAt: null,
  branch: null,
  baseRef: null,
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: null,
  sequence: 1,
};
const input = {
  recorded: null,
  turnStarted: true,
  followUpSent: true,
  latestUserMessageAt: "2026-10-13T12:00:00.000Z",
};

describe("setup attempt reconciliation", () => {
  const previous = { ...snapshot, phase: "failed" as const, sequence: 9 };
  const retry = { ...snapshot, startedAt: "2026-10-13T12:01:00.000Z", sequence: 0 };

  it("keeps the new attempt through reset counters, late events, and stream gaps", () => {
    let held: WorktreeSetupSnapshot | null = previous;
    for (const latest of [null, retry, { ...previous, sequence: 10 }, undefined]) {
      held = resolveLatestWorktreeSetup({ latest, previous: held });
      expect(held).toBe(latest === null ? previous : retry);
    }
    const completed = { ...retry, phase: "done" as const, sequence: 2 };
    held = resolveLatestWorktreeSetup({ latest: completed, previous: held });
    expect(held).toBe(completed);
    expect(resolveLatestWorktreeSetup({ latest: retry, previous: held })).toBe(completed);
  });

  it("uses sequence order within an attempt and timestamps across attempts", () => {
    const updated = { ...retry, sequence: 1 };
    expect(resolveLatestWorktreeSetup({ latest: updated, previous: retry })).toBe(updated);
    expect(resolveLatestWorktreeSetup({ latest: retry, previous: updated })).toBe(updated);
    expect(resolveLatestWorktreeSetup({ latest: retry, previous })).toBe(retry);
    expect(resolveLatestWorktreeSetup({ latest: previous, previous: retry })).toBe(retry);
  });

  it("does not carry a previous thread's setup into a different thread", () => {
    const other = { ...snapshot, threadId: ThreadId.make("other-thread"), sequence: 0 };
    expect(resolveLatestWorktreeSetup({ latest: other, previous })).toBe(other);
  });

  it("reconciles live and recorded attempts before deciding visibility", () => {
    expect(resolveVisibleWorktreeSetup({ ...input, live: retry, recorded: previous })).toBe(retry);
    expect(resolveVisibleWorktreeSetup({ ...input, live: previous, recorded: retry })).toBe(retry);
    expect(
      resolveVisibleWorktreeSetup({
        ...input,
        live: { ...retry, phase: "done" },
        recorded: previous,
      }),
    ).toBeNull();
  });
});

describe("resumed sandbox progress visibility", () => {
  it.each(["running", "failed", "cancelled"] as const)("shows %s on a later turn", (phase) => {
    const live = { ...snapshot, phase };
    expect(resolveVisibleWorktreeSetup({ ...input, live })).toEqual(live);
  });
  it("retires successful startup after agent handoff", () => {
    expect(
      resolveVisibleWorktreeSetup({ ...input, live: { ...snapshot, phase: "done" } }),
    ).toBeNull();
  });
  it("retires an earlier failed startup when a new message is submitted", () => {
    expect(
      resolveVisibleWorktreeSetup({
        ...input,
        latestUserMessageAt: "2026-10-13T12:01:00.000Z",
        live: { ...snapshot, phase: "failed" },
      }),
    ).toBeNull();
  });
  it("preserves initial setup visibility behavior", () => {
    const { kind: _kind, ...initial } = snapshot;
    expect(
      resolveVisibleWorktreeSetup({ ...input, live: { ...initial, phase: "failed" } }),
    ).toBeNull();
    expect(
      resolveVisibleWorktreeSetup({
        ...input,
        followUpSent: false,
        live: { ...initial, phase: "failed" },
      })?.phase,
    ).toBe("failed");
  });
});
