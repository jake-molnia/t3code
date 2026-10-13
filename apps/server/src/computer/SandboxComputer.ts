import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as C from "../../../../packages/contracts/src/sandboxComputer.ts";
import * as RuntimeClient from "../agentRuntime/RuntimeClient.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

type ComputerEffect<A> = Effect.Effect<
  A,
  C.SandboxComputerError | McpCapabilityUnavailableError,
  McpInvocationContext.McpInvocationContext
>;

/** Caller authorization is resolved per request, never captured by the global layer.
 * @effect-expect-leaking McpInvocationContext
 */
export class SandboxComputer extends Context.Service<
  SandboxComputer,
  {
    readonly status: ComputerEffect<C.SandboxComputerStatus>;
    readonly screenshot: ComputerEffect<C.SandboxComputerScreenshot>;
    readonly action: (
      input: C.SandboxComputerAction,
    ) => ComputerEffect<C.SandboxComputerActionResult>;
  }
>()("t3/computer/SandboxComputer") {}

const make = Effect.gen(function* () {
  const runtime = yield* RuntimeClient.RuntimeClient;
  const call = Effect.fn("SandboxComputer.call")(function* (
    operation: "status" | "screenshot" | "action",
    input: unknown,
  ) {
    const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
    return yield* Effect.gen(function* () {
      const client = yield* runtime.forThread(scope.thread.threadId);
      return yield* Effect.tryPromise(() => client.call(`computer.${operation}`, input));
    }).pipe(Effect.mapError((cause) => new C.SandboxComputerError({ operation, cause })));
  });
  return SandboxComputer.of({
    status: call("status", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(C.SandboxComputerStatus)),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(new C.SandboxComputerError({ operation: "status", cause })),
      }),
    ),
    screenshot: call("screenshot", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(C.SandboxComputerScreenshot)),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(new C.SandboxComputerError({ operation: "screenshot", cause })),
      }),
    ),
    action: (input) =>
      call("action", input).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(C.SandboxComputerActionResult)),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(new C.SandboxComputerError({ operation: "action", cause })),
        }),
      ),
  });
});

export const layer = Layer.effect(SandboxComputer, make);
