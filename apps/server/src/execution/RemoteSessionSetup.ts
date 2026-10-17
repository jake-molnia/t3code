import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { runtimeStartupMessage } from "../agentRuntime/RuntimeClient.ts";
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
      let stage: "sandbox" | "agent" = "sandbox";
      return yield* restore(
        Effect.gen(function* () {
          yield* setup.stageStatus("sandbox", "running");
          const client = yield* input.acquire;
          yield* setup.stageStatus("sandbox", "done");
          stage = "agent";
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
              ? (runtimeStartupMessage(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ??
                  (stage === "sandbox"
                    ? "Sandbox execution could not start. Retry the turn."
                    : "The sandbox is ready, but the agent could not start. Retry the turn."))
              : null,
          ),
        ),
      );
    }),
  );
}
