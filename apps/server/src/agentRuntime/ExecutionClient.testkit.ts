import * as Effect from "effect/Effect";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";

/** In-process worker transport. Promise callbacks inherit the enclosing test's services. */
export const makeClient = <E>(
  identity: ExecutionClient["identity"],
  execute: (
    method: string,
    input: unknown,
    transport: "durable" | "transient",
  ) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    return {
      credentialSource: () => {
        throw new Error("Credential sharing is unused in this fixture");
      },
      identity,
      call: (method, input) => run(execute(method, input, "durable")),
      transient: (method, input) => run(execute(method, input, "transient")),
      events: async () => [],
      ack: async () => {},
      operationStatus: async () => ({ state: "missing" as const }),
      inspectIdentity: async () => identity,
    } satisfies ExecutionClient;
  });
