import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import * as A from "@t3tools/provider-core/server/ProviderAdapter";

export const OpenSession = Schema.Struct({
  threadId: C.ThreadId,
  providerSessionId: C.ProviderSessionId,
  modelSelection: C.ModelSelection,
  runtimePolicy: A.ProviderAdapterV2RuntimePolicy,
  resumeFromSession: Schema.optionalKey(C.OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
});
export const EnsureThread = Schema.Struct({
  threadId: C.ThreadId,
  modelSelection: C.ModelSelection,
  runtimePolicy: A.ProviderAdapterV2RuntimePolicy,
  providerSessionId: Schema.optionalKey(C.ProviderSessionId),
  existingProviderThread: Schema.optionalKey(C.OrchestrationV2ProviderThread),
});
export const ResumeThread = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  threadId: Schema.optionalKey(C.ThreadId),
  modelSelection: Schema.optionalKey(C.ModelSelection),
  runtimePolicy: Schema.optionalKey(A.ProviderAdapterV2RuntimePolicy),
});
export const Turn = Schema.Struct({
  appThread: C.OrchestrationV2AppThread,
  threadId: C.ThreadId,
  runId: C.RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(C.RunId),
  attemptId: C.RunAttemptId,
  rootNodeId: C.NodeId,
  providerThread: C.OrchestrationV2ProviderThread,
  message: A.ProviderAdapterV2TurnMessage,
  modelSelection: C.ModelSelection,
  runtimePolicy: A.ProviderAdapterV2RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});
export const Steer = Schema.Struct({
  threadId: C.ThreadId,
  runId: C.RunId,
  providerThread: C.OrchestrationV2ProviderThread,
  providerTurnId: C.ProviderTurnId,
  message: A.ProviderAdapterV2TurnMessage,
});
export const Interrupt = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  providerTurnId: C.ProviderTurnId,
  requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
});
export const Respond = Schema.Struct({
  requestId: C.RuntimeRequestId,
  decision: Schema.optionalKey(C.ProviderApprovalDecision),
  answers: Schema.optionalKey(C.ProviderUserInputAnswers),
  response: Schema.optionalKey(Schema.Unknown),
});
export const Thread = Schema.Struct({ providerThread: C.OrchestrationV2ProviderThread });
export const Snapshot = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  providerTurns: Schema.Array(C.OrchestrationV2ProviderTurn),
  messages: Schema.Array(C.OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(C.OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});
export const Rollback = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  providerThreadTurns: Schema.Array(C.OrchestrationV2ProviderTurn),
  target: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("thread_start"),
      checkpointId: C.CheckpointId,
      appRunOrdinal: Schema.Literal(0),
    }),
    Schema.Struct({
      type: Schema.Literal("provider_turn"),
      checkpointId: C.CheckpointId,
      appRunOrdinal: Schema.Number,
      providerTurn: C.OrchestrationV2ProviderTurn,
    }),
  ]),
});
export const Fork = Schema.Struct({
  sourceProviderThread: C.OrchestrationV2ProviderThread,
  sourceProviderTurns: Schema.optionalKey(Schema.Array(C.OrchestrationV2ProviderTurn)),
  providerTurnId: Schema.optionalKey(C.ProviderTurnId),
  targetThreadId: C.ThreadId,
  ownerNodeId: Schema.optionalKey(C.NodeId),
  modelSelection: Schema.optionalKey(C.ModelSelection),
  runtimePolicy: Schema.optionalKey(A.ProviderAdapterV2RuntimePolicy),
});
export const History = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  messages: Schema.Array(C.OrchestrationV2HistoricalMessage),
  context: Schema.String,
});
export const Selection = Schema.Struct({
  current: C.ModelSelection,
  target: C.ModelSelection,
  sessionCapabilities: C.OrchestrationV2ProviderCapabilities,
});
export const SelectionPlan = Schema.Union([
  Schema.Struct({ type: Schema.Literal("apply_on_next_turn") }),
  Schema.Struct({ type: Schema.Literal("restart_session") }),
  Schema.Struct({ type: Schema.Literal("create_with_handoff") }),
  Schema.Struct({ type: Schema.Literal("reject"), reason: Schema.String }),
]);
export const SessionDescription = Schema.Struct({
  instanceId: C.ProviderInstanceId,
  driver: C.ProviderDriverKind,
  providerSessionId: C.ProviderSessionId,
  providerSession: C.OrchestrationV2ProviderSession,
  optionalMethods: Schema.Array(Schema.String),
});
export const SessionCommand = Schema.Struct({
  sessionId: C.ProviderSessionId,
  input: Schema.Unknown,
});
export const AdapterCommand = Schema.Struct({
  instanceId: C.ProviderInstanceId,
  input: Schema.Unknown,
});
export const Feedback = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  reason: Schema.optionalKey(Schema.String),
});
export const McpList = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  server: Schema.String,
});
export const McpCall = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  server: Schema.String,
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export const McpRead = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThread,
  server: Schema.String,
  uri: Schema.String,
});

export const McpConfiguration = Schema.Struct({
  environmentId: C.EnvironmentId,
  threadId: C.ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: C.ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
  browserToolsAvailable: Schema.Boolean,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  agentDeviceEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const ModelContext = Schema.Struct({
  modelSelection: C.ModelSelection,
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  previous: Schema.optionalKey(C.ModelSelection),
});
export const ModelContextResult = Schema.Struct({
  contextWindow: Schema.NullOr(Schema.Number),
  reusable: Schema.Boolean,
});

type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
/** A new upstream optional method must be assigned a transport before this worker compiles. Subscriptions stay in each process's session manager. */
export const OptionalSessionMethods: Record<
  Exclude<OptionalKeys<A.ProviderAdapterV2SessionRuntime>, "subscribeEvents">,
  true
> = {
  hasPendingBackgroundWork: true,
  hasPendingBackgroundWorkForThread: true,
  getModelContextWindow: true,
  canReuseContextUsage: true,
  injectHistory: true,
  compactThread: true,
  unloadThread: true,
  uploadFeedback: true,
  mcpApps: true,
};
