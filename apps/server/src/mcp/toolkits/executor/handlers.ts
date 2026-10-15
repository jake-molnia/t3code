import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpConnections from "../../McpConnections.ts";
import { ExecutorToolkit } from "./tools.ts";

const call = Effect.fn("ExecutorTools.call")(function* (
  operation: "search" | "schema" | "execute",
  value: string,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = yield* McpInvocationContext.requireThreadScope(scope, "Executor");
  const service = yield* McpConnections.McpConnections;
  const result = yield* service
    .call({
      threadId: thread.thread.threadId,
      sessionId: thread.thread.providerSessionId,
      operation,
      value,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  return { result };
});

export const layer = McpToolAccess.toLayer(ExecutorToolkit, {
  executor_search: McpToolAccess.readsAsCaller(({ query }) => call("search", query)),
  executor_schema: McpToolAccess.readsAsCaller(({ path }) => call("schema", path)),
  executor_execute: McpToolAccess.writesEnvironment(({ code }) => call("execute", code)),
  executor_resume: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "Executor");
      const service = yield* McpConnections.McpConnections;
      const result = yield* service
        .resume({
          ...input,
          content: input.content ?? "{}",
          threadId: thread.thread.threadId,
          sessionId: thread.thread.providerSessionId,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { result };
    }),
  ),
});
