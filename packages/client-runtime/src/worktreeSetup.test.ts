import { describe, expect, it } from "vitest";
import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { resolveVisibleWorktreeSetup } from "./worktreeSetup.ts";

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
