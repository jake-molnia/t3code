import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as C from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Remote from "./RemoteWorkspaceGitStatus.ts";
import * as Routing from "./WorkspaceRouting.ts";

const status = (refName: string): C.VcsStatusResult => ({
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
      const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
        Effect.provide(Remote.layer.pipe(Layer.provide(Layer.mergeAll(routing, workflow, policy)))),
      );
      const first = "/workspace/first/repo";
      const second = "/workspace/second/repo";
      expect((yield* service.refreshStatus(first)).refName).toBe(first);
      expect((yield* service.refreshStatus(second)).refName).toBe(second);
      expect(calls).toEqual([first, second]);
      expect(observations).toEqual([]);
      for (const cwd of [first, second]) {
        const events = yield* service.streamStatus({ cwd }).pipe(Stream.take(1), Stream.runCollect);
        expect(events).toEqual([{ _tag: "snapshot", local: status(cwd), remote: status(cwd) }]);
      }
      expect(calls).toEqual([first, second]);
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
  let branch = "first";
  let aheadCount = 2;
  let localReads = 0;
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
        return local;
      }),
    remoteStatus: (_input, options) =>
      Effect.gen(function* () {
        const fetch = options?.refreshUpstream !== false;
        remoteReads.push({ at: yield* Clock.currentTimeMillis, fetch });
        yield* Queue.offer(remoteRead, undefined);
        return { hasUpstream: true, aheadCount, behindCount: 1, pr: null };
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
  const service = yield* VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
    Effect.provide(Remote.layer.pipe(Layer.provide(Layer.mergeAll(workflow, routing, policy)))),
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
    setRunning: (value: boolean) => {
      running = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setInterval: (value: Duration.Duration) => {
      interval = value;
    },
    setAheadCount: (value: number) => {
      aheadCount = value;
    },
    setBranch: (value: string) => {
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
    yield* TestClock.adjust("20 seconds");
    expect(f.remoteReads).toHaveLength(2);
    expect(f.localReads()).toBe(stoppedLocal);
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
      f.setBranch("still-observing");
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(passiveEvents)).toMatchObject({
        _tag: "snapshot",
        local: { refName: "still-observing" },
        remote: { aheadCount: 3 },
      });
      expect(f.remoteReads).toHaveLength(2);
      yield* Fiber.interrupt(passive);
    }),
);
