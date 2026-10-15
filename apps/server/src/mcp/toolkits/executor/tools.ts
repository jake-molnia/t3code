import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpConnections from "../../McpConnections.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  success: Schema.Struct({ result: Schema.Unknown }),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    McpConnections.McpConnections,
    ThreadManagement.ThreadManagementService,
  ],
};

export const ExecutorToolkit = Toolkit.make(
  Tool.make("executor_search", {
    ...shared,
    description:
      "Find integration tools available to this thread's project. Search before executing; only matching tools are returned, keeping the full catalog out of context. Connections and access are managed in Settings → MCP.",
    parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(1000)) }),
  }).annotate(Tool.Readonly, true),
  Tool.make("executor_schema", {
    ...shared,
    description:
      "Get the input schema and usage of a tool returned by executor_search. Supply its exact path.",
    parameters: Schema.Struct({ path: Schema.String.check(Schema.isMaxLength(2000)) }),
  }).annotate(Tool.Readonly, true),
  Tool.make("executor_execute", {
    ...shared,
    description:
      "Run JavaScript to call this project's connected integration tools using await tools.<integration>.org.<connection>.<tool>(args). Use executor_search and executor_schema first. Return only the result needed. Runs in Executor's isolated integration runtime; no workspace files or shell. Project access is enforced on each tool call.",
    parameters: Schema.Struct({
      code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64000)),
    }),
  }).annotate(Tool.Readonly, false),
  Tool.make("executor_resume", {
    ...shared,
    description:
      "Resume an Executor execution paused for user input or approval. First ask the user for the requested response, or wait for them to complete the sign-in URL. Never invent approval. Use only an executionId returned to this thread, with the user's action and optional JSON-encoded form content.",
    parameters: Schema.Struct({
      executionId: Schema.String,
      action: Schema.Literals(["accept", "decline", "cancel"]),
      content: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
    }),
  }).annotate(Tool.Readonly, false),
);
