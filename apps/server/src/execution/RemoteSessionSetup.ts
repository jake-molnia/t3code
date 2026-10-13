import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { WorktreeSetupTracker } from "../project/WorktreeSetupTracker.ts";

/** Session-open cancellation belongs to the run, never the bootstrap fiber. */
export function trackRemoteSessionSetup<Client, Value, Error, Requirements>(input: {
  readonly tracker: WorktreeSetupTracker["Service"];
  readonly threadId: ThreadId;
  readonly acquire: Effect.Effect<Client, Error, Requirements>;
  readonly open: (client: Client) => Effect.Effect<Value, Error, Requirements>;
}) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const { tracker, threadId } = input;
      const setup = yield* tracker.beginResume(threadId);
      if (setup === null) {
        return yield* restore(input.acquire.pipe(Effect.flatMap(input.open)));
      }
      return yield* restore(
        Effect.gen(function* () {
          yield* setup.stageStatus("sandbox", "running");
          const client = yield* input.acquire;
          yield* setup.stageStatus("sandbox", "done");
          yield* setup.stageStatus("agent", "running");
          const result = yield* input.open(client);
          yield* setup.stageStatus("agent", "done");
          return result;
        }),
      ).pipe(
        Effect.onExit((exit) =>
          setup.finish(
            Exit.isSuccess(exit)
              ? "done"
              : Cause.hasInterrupts(exit.cause)
                ? "cancelled"
                : "failed",
            Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)
              ? "Sandbox execution could not start. Retry the turn."
              : null,
          ),
        ),
      );
    }),
  );
}
