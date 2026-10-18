import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as C from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Remote from "./RemoteWorkspaceGitStatus.ts";
import * as Routing from "./WorkspaceRouting.ts";

const status = (refName: string | null): C.VcsStatusResult => ({
  isRepo: true,
  sourceControlProvider: undefined,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
});

it.effect(
  "explicit Git refresh wakes each workspace after idle; passive streams retain their own snapshots",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const observations: string[] = [];
      let fail = false;
      let failObservation = false;
      const routing = Layer.mock(Routing.WorkspaceRouting)({
        enabled: true,
        observe: (cwd) =>
          Effect.gen(function* () {
            observations.push(cwd);
            if (failObservation)
              return yield* new Routing.WorkspaceRoutingError({
                operation: "observe",
                cause: "worker suspended during read",
              });
            return null;
          }),
      });
      const policy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(true),
      });
      const workflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
        invalidateLocalStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
        invalidateRemoteStatus: () => Effect.void,
        remoteStatus: ({ cwd }) => Effect.succeed(status(cwd)),
        localStatus: (input) =>
          Effect.gen(function* () {
            calls.push(input.cwd);
            if (fail)
              return yield* new C.GitCommandError({
                operation: "status",
                cwd: input.cwd,
                command: "git",
                detail: "worker unavailable",
              });
            return status(input.cwd);
          }),
      });
      const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
        resolveCommit: () => Effect.succeed({ commitSha: "head" }),
        resolveBranchName: (cwd) => Effect.succeed(cwd),
      });
      const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
        Effect.provide(
          Remote.layer.pipe(Layer.provide(Layer.mergeAll(routing, workflow, policy, git))),
        ),
      );
      const first = "/workspace/first/repo";
      const second = "/workspace/second/repo";
      expect((yield* service.refreshStatus(first)).refName).toBe(first);
      expect((yield* service.refreshStatus(second)).refName).toBe(second);
      expect(calls).toEqual([first, first, second, second]);
      expect(observations).toEqual([]);
      for (const cwd of [first, second]) {
        const events = yield* service.streamStatus({ cwd }).pipe(Stream.take(1), Stream.runCollect);
        expect(events).toEqual([{ _tag: "snapshot", local: status(cwd), remote: status(cwd) }]);
      }
      expect(calls).toEqual([first, first, second, second]);
      expect(new Set(observations)).toEqual(new Set([first, second]));
      failObservation = true;
      expect(
        yield* service.streamStatus({ cwd: first }).pipe(Stream.take(1), Stream.runCollect),
      ).toEqual([{ _tag: "snapshot", local: status(first), remote: status(first) }]);
      fail = true;
      expect((yield* service.refreshStatus(first).pipe(Effect.exit))._tag).toBe("Failure");
    }),
);

const fixture = Effect.gen(function* () {
  let running = true;
  let allowed = true;
  let interval = Duration.seconds(10);
  let branch: string | null = "first";
  let dirty = false;
  let includePr = false;
  let nextLocal = () => {};
  let aheadCount = 2;
  let head: string | null = "head";
  let localReads = 0;
  let identityReads = 0;
  let nextRemote: Effect.Effect<void, C.GitCommandError> = Effect.void;
  const remoteReads: Array<{ at: number; fetch: boolean }> = [];
  const events = yield* Queue.unbounded<C.VcsStatusStreamEvent>();
  const remoteRead = yield* Queue.unbounded<void>();
  const workflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
    invalidateLocalStatus: () => Effect.void,
    invalidateRemoteStatus: () => Effect.void,
    invalidateStatus: () => Effect.void,
    localStatus: () =>
      Effect.sync(() => {
        localReads++;
        const {
          hasUpstream: _,
          aheadCount: _a,
          behindCount: _b,
          pr: _p,
          ...local
        } = status(branch);
        const result = { ...local, hasWorkingTreeChanges: dirty };
        const change = nextLocal;
        nextLocal = () => {};
        change();
        return result;
      }),
    remoteStatus: (_input, options) =>
      Effect.gen(function* () {
        const fetch = options?.refreshUpstream !== false;
        remoteReads.push({ at: yield* Clock.currentTimeMillis, fetch });
        const result = {
          hasUpstream: true,
          aheadCount,
          behindCount: 1,
          pr:
            includePr && branch !== null
              ? {
                  number: 1,
                  title: branch,
                  url: "https://github.com/example/repo/pull/1",
                  baseRef: "main",
                  headRef: branch,
                  state: "open",
                }
              : null,
        } satisfies C.VcsStatusRemoteResult;
        const wait = nextRemote;
        nextRemote = Effect.void;
        yield* Queue.offer(remoteRead, undefined);
        yield* wait;
        return result;
      }),
    status: () =>
      Effect.gen(function* () {
        localReads++;
        remoteReads.push({ at: yield* Clock.currentTimeMillis, fetch: true });
        yield* Queue.offer(remoteRead, undefined);
        return status(branch);
      }),
  });
  const routing = Layer.mock(Routing.WorkspaceRouting)({
    enabled: true,
    observe: (_cwd, effect) => Effect.suspend(() => (running ? effect : Effect.succeed(null))),
  });
  const policy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.sync(() => allowed),
  });
  const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
    resolveBranchName: () =>
      Effect.sync(() => {
        identityReads++;
        return branch;
      }),
    resolveCommit: () =>
      Effect.suspend(() => {
        identityReads++;
        return head === null
          ? Effect.fail(
              new C.GitCommandError({
                operation: "resolveCommit",
                command: "git",
                cwd: "/workspace/first/repo",
                detail: "HEAD unavailable",
              }),
            )
          : Effect.succeed({ commitSha: head });
      }),
  });
  const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
    Effect.provide(
      Remote.layer.pipe(Layer.provide(Layer.mergeAll(workflow, routing, policy, git))),
    ),
  );
  const start = (includeRemote = true) =>
    service
      .streamStatus(
        { cwd: "/workspace/first/repo", includeRemote },
        {
          automaticRemoteRefreshInterval: Effect.sync(() => interval),
        },
      )
      .pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
  return {
    service,
    start,
    events,
    remoteRead,
    remoteReads,
    localReads: () => localReads,
    identityReads: () => identityReads,
    setRunning: (value: boolean) => {
      running = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setInterval: (value: Duration.Duration) => {
      interval = value;
    },
    holdNextRemote: (wait: Effect.Effect<void, C.GitCommandError>) => {
      nextRemote = wait;
    },
    onNextLocal: (change: () => void) => {
      nextLocal = change;
    },
    setIncludePr: (value: boolean) => {
      includePr = value;
    },
    setDirty: (value: boolean) => {
      dirty = value;
    },
    setHead: (value: string | null) => {
      head = value;
    },
    setAheadCount: (value: number) => {
      aheadCount = value;
    },
    setBranch: (value: string | null) => {
      branch = value;
    },
  };
});

it.effect("interval zero keeps current local state without automatic remote work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setInterval(Duration.zero);
    const fiber = yield* f.start();
    expect(yield* Queue.take(f.events)).toMatchObject({
      _tag: "snapshot",
      local: { refName: "first" },
    });
    f.setBranch("second");
    yield* TestClock.adjust("2 seconds");
    expect(yield* Queue.take(f.events)).toMatchObject({
      _tag: "snapshot",
      local: { refName: "second" },
    });
    yield* TestClock.adjust("30 seconds");
    expect(f.remoteReads).toEqual([]);
    expect(f.localReads()).toBeGreaterThan(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("automatic remote work honors the interval, policy, and stopped workers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fiber = yield* f.start();
    yield* Queue.take(f.events);
    yield* Queue.take(f.remoteRead);
    expect(f.remoteReads).toEqual([{ at: 0, fetch: true }]);
    yield* TestClock.adjust("9 seconds");
    expect(f.remoteReads).toHaveLength(1);
    yield* TestClock.adjust("1 second");
    yield* Queue.take(f.remoteRead);
    expect(f.remoteReads).toEqual([
      { at: 0, fetch: true },
      { at: 10_000, fetch: true },
    ]);
    f.setAllowed(false);
    const localBefore = f.localReads();
    yield* TestClock.adjust("20 seconds");
    expect(f.remoteReads).toHaveLength(2);
    expect(f.localReads()).toBeGreaterThan(localBefore);
    f.setAllowed(true);
    f.setRunning(false);
    const stoppedLocal = f.localReads();
    const stoppedIdentity = f.identityReads();
    yield* TestClock.adjust("20 seconds");
    expect(f.remoteReads).toHaveLength(2);
    expect(f.localReads()).toBe(stoppedLocal);
    expect(f.identityReads()).toBe(stoppedIdentity);
    f.setRunning(true);
    yield* TestClock.adjust("10 seconds");
    yield* Queue.take(f.remoteRead);
    expect(f.remoteReads.at(-1)).toEqual({ at: 60_000, fetch: true });
    f.setInterval(Duration.zero);
    yield* TestClock.adjust("20 seconds");
    expect(f.remoteReads).toHaveLength(3);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect(
  "local finalization reads stay local, PR refresh never fetches, explicit refresh can fetch",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const cwd = "/workspace/first/repo";
      expect((yield* f.service.refreshLocalStatus(cwd)).refName).toBe("first");
      expect(f.remoteReads).toEqual([]);
      yield* f.service.refreshPullRequestStatus(cwd);
      expect(f.remoteReads).toEqual([{ at: 0, fetch: false }]);
      f.setAllowed(false);
      yield* f.service.refreshPullRequestStatus(cwd);
      expect(f.remoteReads).toHaveLength(1);
      f.setBranch("second");
      expect((yield* f.service.refreshStatus(cwd)).refName).toBe("second");
      expect(f.remoteReads.at(-1)?.fetch).toBe(true);
      expect(f.remoteReads).toHaveLength(2);
    }),
);

it.effect("local-only subscriptions never schedule remote work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fiber = yield* f.start(false);
    yield* Queue.take(f.events);
    yield* TestClock.adjust("30 seconds");
    expect(f.remoteReads).toEqual([]);
    expect(f.localReads()).toBeGreaterThan(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect(
  "passive subscribers share cached remote state without retaining another subscriber's polling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const active = yield* f.start();
      yield* Queue.take(f.events);
      expect(yield* Queue.take(f.events)).toMatchObject({
        _tag: "snapshot",
        remote: { aheadCount: 2 },
      });
      const passiveEvents = yield* Queue.unbounded<C.VcsStatusStreamEvent>();
      const passive = yield* f.service
        .streamStatus({
          cwd: "/workspace/first/repo",
          includeRemote: false,
        })
        .pipe(
          Stream.runForEach((event) => Queue.offer(passiveEvents, event)),
          Effect.forkScoped,
        );
      expect(yield* Queue.take(passiveEvents)).toMatchObject({
        _tag: "snapshot",
        remote: { aheadCount: 2 },
      });
      expect(f.remoteReads).toHaveLength(1);
      f.setAheadCount(3);
      yield* TestClock.adjust("12 seconds");
      expect(yield* Queue.take(passiveEvents)).toMatchObject({
        _tag: "snapshot",
        remote: { aheadCount: 3 },
      });
      expect(f.remoteReads).toHaveLength(2);
      yield* Fiber.interrupt(active);
      f.setDirty(true);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(passiveEvents)).toMatchObject({
        _tag: "snapshot",
        local: { refName: "first", hasWorkingTreeChanges: true },
        remote: { aheadCount: 3 },
      });
      expect(f.remoteReads).toHaveLength(2);
      yield* Fiber.interrupt(passive);
    }),
);

it.effect("branch changes clear cached remote state with automatic fetch disabled", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setIncludePr(true);
    yield* f.service.refreshStatus("/workspace/first/repo");
    f.setInterval(Duration.zero);
    const fiber = yield* f.start();
    expect(yield* Queue.take(f.events)).toMatchObject({
      local: { refName: "first" },
      remote: { aheadCount: 2, pr: { headRef: "first" } },
    });
    f.setBranch("second");
    yield* TestClock.adjust("2 seconds");
    expect(yield* Queue.take(f.events)).toMatchObject({
      local: { refName: "second" },
      remote: null,
    });
    expect(f.remoteReads).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect.each(["switch", "unobserved-switch", "observed-ABA", "same-branch-commit"])(
  "a delayed remote read cannot cross a checkout generation: %s",
  (change) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const cwd = "/workspace/first/repo";
      yield* f.service.refreshStatus(cwd);
      yield* Queue.take(f.remoteRead);
      const release = yield* Deferred.make<void>();
      f.holdNextRemote(Deferred.await(release));
      const pending = yield* f.service.refreshPullRequestStatus(cwd).pipe(Effect.forkScoped);
      yield* Queue.take(f.remoteRead);
      if (change === "same-branch-commit") f.setHead("new-head");
      else f.setBranch("second");
      if (change !== "unobserved-switch") yield* f.service.refreshLocalStatus(cwd);
      if (change === "observed-ABA") {
        f.setBranch("first");
        yield* f.service.refreshLocalStatus(cwd);
      }
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toBeNull();
      const events = yield* f.service
        .streamStatus({ cwd, includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(events).toMatchObject([
        {
          local: {
            refName:
              change === "observed-ABA" || change === "same-branch-commit" ? "first" : "second",
          },
          remote: null,
        },
      ]);
    }),
);

it.effect("a same-branch HEAD change invalidates cached divergence without fetching", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.refreshStatus("/workspace/first/repo");
    f.setInterval(Duration.zero);
    const fiber = yield* f.start();
    yield* Queue.take(f.events);
    f.setHead("new-head");
    yield* TestClock.adjust("2 seconds");
    expect(yield* Queue.take(f.events)).toMatchObject({
      local: { refName: "first" },
      remote: null,
    });
    expect(f.remoteReads).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect.each(["detached", "unavailable"])("invalidates cached remote state for %s HEAD", (kind) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const cwd = "/workspace/first/repo";
    if (kind === "detached") f.setBranch(null);
    yield* f.service.refreshStatus(cwd);
    f.setInterval(Duration.zero);
    const fiber = yield* f.start();
    yield* Queue.take(f.events);
    f.setHead(kind === "detached" ? "other-detached-head" : null);
    yield* TestClock.adjust("2 seconds");
    expect(yield* Queue.take(f.events)).toMatchObject({
      local: { refName: kind === "detached" ? null : "first" },
      remote: null,
    });
    expect(f.remoteReads).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("HEAD changing during a local sample clears remote state and keeps local changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const cwd = "/workspace/first/repo";
    yield* f.service.refreshStatus(cwd);
    f.setDirty(true);
    f.onNextLocal(() => f.setHead("changed-during-read"));
    expect(yield* f.service.refreshLocalStatus(cwd)).toMatchObject({
      refName: "first",
      hasWorkingTreeChanges: true,
    });
    const events = yield* f.service
      .streamStatus({ cwd, includeRemote: false })
      .pipe(Stream.take(1), Stream.runCollect);
    expect(events).toMatchObject([
      { local: { refName: "first", hasWorkingTreeChanges: true }, remote: null },
    ]);
    expect(f.remoteReads).toHaveLength(1);
  }),
);

it.effect("a failed remote refresh after a branch switch cannot retain the old PR", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const cwd = "/workspace/first/repo";
    f.setIncludePr(true);
    yield* f.service.refreshStatus(cwd);
    f.setBranch("second");
    const failure = new C.GitCommandError({
      operation: "status",
      command: "git",
      cwd,
      detail: "Remote unavailable",
    });
    f.holdNextRemote(Effect.fail(failure));
    expect((yield* f.service.refreshPullRequestStatus(cwd).pipe(Effect.exit))._tag).toBe("Failure");
    const events = yield* f.service
      .streamStatus({ cwd, includeRemote: false })
      .pipe(Stream.take(1), Stream.runCollect);
    expect(events).toMatchObject([{ local: { refName: "second" }, remote: null }]);
  }),
);

it.effect("a branch switch at the same commit during local sampling clears remote state", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const cwd = "/workspace/first/repo";
    yield* f.service.refreshStatus(cwd);
    f.onNextLocal(() => f.setBranch("second"));
    yield* f.service.refreshLocalStatus(cwd);
    const events = yield* f.service
      .streamStatus({ cwd, includeRemote: false })
      .pipe(Stream.take(1), Stream.runCollect);
    expect(events).toMatchObject([{ local: { refName: "second" }, remote: null }]);
    expect(f.remoteReads).toHaveLength(1);
  }),
);
