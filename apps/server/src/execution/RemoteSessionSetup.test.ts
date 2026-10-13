import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { trackRemoteSessionSetup } from "./RemoteSessionSetup.ts";

const threadId = ThreadId.make("resumed-thread");

describe("resumed sandbox setup", () => {
  it.effect(
    "times scheduler readiness before agent startup and completes the existing stage stream",
    () =>
      Effect.gen(function* () {
        const tracker = yield* WorktreeSetupTracker.make;
        const waiting = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const opening = yield* Deferred.make<void>();
        const opened = yield* Deferred.make<void>();
        const fiber = yield* trackRemoteSessionSetup({
          tracker,
          threadId,
          acquire: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(ready))),
          open: () =>
            Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(opened))),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        const pending = yield* tracker.get(threadId);
        expect(pending?.kind).toBe("sandbox-resume");
        expect(pending?.stages.map((s) => [s.id, s.status])).toEqual([
          ["sandbox", "running"],
          ["agent", "pending"],
        ]);
        yield* TestClock.adjust("45 seconds");
        yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(opening);
        const starting = yield* tracker.get(threadId);
        const sandbox = starting?.stages[0];
        expect(Date.parse(sandbox?.endedAt ?? "") - Date.parse(sandbox?.startedAt ?? "")).toBe(
          45000,
        );
        expect(starting?.stages[1]?.status).toBe("running");
        yield* Deferred.succeed(opened, undefined);
        yield* Fiber.join(fiber);
        expect((yield* tracker.get(threadId))?.phase).toBe("done");
      }),
  );

  it.effect(
    "run interruption cancels a pending resume without a bootstrap cancellation handle",
    () =>
      Effect.gen(function* () {
        const tracker = yield* WorktreeSetupTracker.make;
        const waiting = yield* Deferred.make<void>();
        const fiber = yield* trackRemoteSessionSetup({
          tracker,
          threadId,
          acquire: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
          open: () => Effect.void,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        expect(yield* tracker.cancel(threadId)).toBe(false);
        yield* Fiber.interrupt(fiber);
        expect((yield* tracker.get(threadId))?.phase).toBe("cancelled");
      }),
  );

  it.effect("does not replace the initial launch tracker or its stage history", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: "feature",
        baseRef: "main",
        stages: ["sandbox", "checkout", "agent"],
        fiber: null,
      });
      yield* tracker.stageStatus(threadId, "sandbox", "done");
      yield* tracker.stageStatus(threadId, "checkout", "done");
      const before = yield* tracker.get(threadId);
      yield* trackRemoteSessionSetup({
        tracker,
        threadId,
        acquire: Effect.succeed("worker"),
        open: Effect.succeed,
      });
      expect(yield* tracker.get(threadId)).toEqual(before);
    }),
  );
  it.effect("only the first concurrent resume owns progress", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* trackRemoteSessionSetup({
        tracker,
        threadId,
        acquire: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
        open: () => Effect.void,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      const before = yield* tracker.get(threadId);
      yield* trackRemoteSessionSetup({
        tracker,
        threadId,
        acquire: Effect.void,
        open: () => Effect.void,
      });
      expect(yield* tracker.get(threadId)).toEqual(before);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect((yield* tracker.get(threadId))?.phase).toBe("done");
    }),
  );

  it.effect("an older resume cannot finish or mutate a replacement setup", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* trackRemoteSessionSetup({
        tracker,
        threadId,
        acquire: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
        open: () => Effect.void,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* tracker.begin({
        threadId,
        branch: "replacement",
        baseRef: "main",
        stages: ["checkout"],
        fiber: null,
      });
      const replacement = yield* tracker.get(threadId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* tracker.get(threadId)).toEqual(replacement);
      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(threadId)).toEqual(replacement);
    }),
  );

  it.effect("records failed acquisition without leaking provider error text", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* trackRemoteSessionSetup({
        tracker,
        threadId,
        acquire: Effect.fail("private endpoint"),
        open: () => Effect.void,
      }).pipe(Effect.flip);
      const snapshot = yield* tracker.get(threadId);
      expect(snapshot?.phase).toBe("failed");
      expect(snapshot?.stages[0]?.status).toBe("failed");
      expect(snapshot?.error).toBe("Sandbox execution could not start. Retry the turn.");
    }),
  );
});
