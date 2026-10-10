import * as Deferred from "effect/Deferred";
// @effect-diagnostics preferSchemaOverJson:off -- JSON strings here are stable in-memory model-cache keys, not wire decoding.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import * as A from "@t3tools/provider-core/server/ProviderAdapter";
import { readMcpProviderSession } from "@t3tools/provider-core/server/mcpSession";
import * as P from "./ProviderProtocol.ts";
import type { ExecutionEvent } from "../../../../packages/contracts/src/execution.ts";
import * as Schedule from "effect/Schedule";
import {
  ExecutionOperationError,
  ExecutionTransportError,
  type ExecutionClient,
} from "./ExecutionClient.ts";

const decodeProviderError = Schema.decodeUnknownEffect(
  Schema.toCodecJson(A.ProviderAdapterV2Error),
);
const encodeSelectionSync = Schema.encodeSync(Schema.toCodecJson(P.Selection));
const encodeOpenSession = Schema.encodeEffect(Schema.toCodecJson(P.OpenSession));
const decodeProviderEvent = Schema.decodeUnknownEffect(
  Schema.toCodecJson(A.ProviderAdapterV2Event),
);
const encodeEnsureThreadSync = Schema.encodeSync(Schema.toCodecJson(P.EnsureThread));
const encodeResumeThreadSync = Schema.encodeSync(Schema.toCodecJson(P.ResumeThread));
const encodeTurnSync = Schema.encodeSync(Schema.toCodecJson(P.Turn));
const encodeSteerSync = Schema.encodeSync(Schema.toCodecJson(P.Steer));
const encodeInterruptSync = Schema.encodeSync(Schema.toCodecJson(P.Interrupt));
const encodeRespondSync = Schema.encodeSync(Schema.toCodecJson(P.Respond));
const encodeThreadSync = Schema.encodeSync(Schema.toCodecJson(P.Thread));
const encodeRollbackSync = Schema.encodeSync(Schema.toCodecJson(P.Rollback));
const encodeForkSync = Schema.encodeSync(Schema.toCodecJson(P.Fork));
const encodeHistorySync = Schema.encodeSync(Schema.toCodecJson(P.History));
const encodeFeedbackSync = Schema.encodeSync(Schema.toCodecJson(P.Feedback));
const encodeMcpListSync = Schema.encodeSync(Schema.toCodecJson(P.McpList));
const encodeMcpCallSync = Schema.encodeSync(Schema.toCodecJson(P.McpCall));
const encodeMcpReadSync = Schema.encodeSync(Schema.toCodecJson(P.McpRead));

const sessionClients = new Map<
  C.ProviderSessionId,
  { client: ExecutionClient; driver: C.ProviderDriverKind; pendingCreation: boolean }
>();
/** Explicit release only. Closing the central transport scope leaves remote sessions alive. */
export function isRemoteProviderSession(sessionId: C.ProviderSessionId) {
  return sessionClients.has(sessionId);
}

export function forgetRemoteProviderSession(sessionId: C.ProviderSessionId) {
  sessionClients.delete(sessionId);
}

export function abortRemoteProviderSessionOpen(sessionId: C.ProviderSessionId) {
  return Effect.suspend(() =>
    sessionClients.get(sessionId)?.pendingCreation
      ? closeRemoteProviderSession(sessionId)
      : Effect.void,
  );
}

export function closeRemoteProviderSession(sessionId: C.ProviderSessionId) {
  return Effect.gen(function* () {
    const session = sessionClients.get(sessionId);
    if (!session) return;
    const { client, driver } = session;
    yield* Effect.tryPromise(() =>
      client.call(
        "closeSession",
        { sessionId, input: null },
        `close:${client.identity.incarnation}:${sessionId}`,
      ),
    ).pipe(
      Effect.catch((cause) =>
        cause.cause instanceof ExecutionOperationError && cause.cause.code === "stale_identity"
          ? Effect.void
          : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) =>
          new A.ProviderAdapterCloseSessionError({
            driver,
            providerSessionId: sessionId,
            cause,
          }),
      ),
    );
    sessionClients.delete(sessionId);
  });
}

const eventEnvelopes = new WeakMap<A.ProviderAdapterV2Event, ExecutionEvent>();
const eventAcknowledgers = new WeakMap<A.ProviderAdapterV2Event, () => Promise<void>>();
const terminalCompletions = new WeakMap<A.ProviderAdapterV2Event, Deferred.Deferred<void>>();
export function awaitRemoteTerminal(event: A.ProviderAdapterV2Event) {
  const completion = terminalCompletions.get(event);
  return completion ? Deferred.await(completion) : Effect.void;
}
export function completeRemoteTerminal(event: A.ProviderAdapterV2Event) {
  const completion = terminalCompletions.get(event);
  return completion ? Deferred.succeed(completion, undefined).pipe(Effect.asVoid) : Effect.void;
}
/** Called after ingestion; its durable cursor check prevents acknowledging rejected writes. */
export function ackRemoteEvent(event: A.ProviderAdapterV2Event) {
  return Effect.suspend(() => {
    const acknowledge = eventAcknowledgers.get(event);
    return acknowledge
      ? Effect.tryPromise(acknowledge).pipe(Effect.catch(() => Effect.void))
      : Effect.void;
  });
}
/** Ingestion persists this cursor in the same transaction as the provider event. */
export function remoteEventEnvelope(event: A.ProviderAdapterV2Event) {
  return eventEnvelopes.get(event);
}
export function copyRemoteEventDelivery(
  source: A.ProviderAdapterV2Event,
  target: A.ProviderAdapterV2Event,
) {
  const envelope = eventEnvelopes.get(source);
  const acknowledge = eventAcknowledgers.get(source);
  if (envelope) eventEnvelopes.set(target, envelope);
  if (acknowledge) eventAcknowledgers.set(target, acknowledge);
}

export function createRemoteProviderAdapter(options: {
  instanceId: C.ProviderInstanceId;
  driver: C.ProviderDriverKind;
  client: ExecutionClient;
  /** Persist/restore this cursor with central ingestion, not with the provider process. */
  eventCursor?: number;
  attachOnly?: boolean;
  mcpEndpoint?: string;
  stageAttachments?: (
    threadId: C.ThreadId,
    attachments: ReadonlyArray<C.ChatAttachment>,
  ) => Effect.Effect<void, A.ProviderAdapterV2Error>;
  requireRemoteMcpEndpoint?: boolean;
  getEventCursor?: (sessionId: string) => Promise<number>;
}): A.ProviderAdapterV2Shape {
  const error = (cause: unknown) =>
    new A.ProviderAdapterProtocolError({
      driver: options.driver,
      detail: "Remote execution failed",
      cause,
    });
  function configureMcp(threadId: C.ThreadId) {
    return Effect.gen(function* () {
      const mcp = readMcpProviderSession(threadId);
      if (!mcp) return;
      const { capabilities, ...configuration } = mcp;
      const endpoint = options.mcpEndpoint ?? configuration.endpoint;
      const address = yield* Effect.try(() => new URL(endpoint)).pipe(Effect.mapError(error));
      if (
        options.requireRemoteMcpEndpoint &&
        (!options.mcpEndpoint || !["http:", "https:"].includes(address.protocol))
      ) {
        return yield* error(
          "T3_MCP_ADVERTISED_URL must name the central MCP endpoint reachable from sandboxes",
        );
      }
      yield* Effect.tryPromise(() =>
        options.client.call("configureMcp", {
          ...configuration,
          endpoint,
          ...(capabilities ? { capabilities: [...capabilities] } : {}),
        }),
      ).pipe(Effect.mapError(error));
    });
  }
  function call<T, E>(
    method: string,
    input: unknown,
    schema: Schema.Codec<T, E>,
    sessionId?: C.ProviderSessionId,
    operationId?: string,
  ) {
    return Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        options.client.call(
          method,
          sessionId ? { sessionId, input } : { instanceId: options.instanceId, input },
          operationId,
        ),
      ).pipe(Effect.mapError(error));
      if (result !== null && typeof result === "object" && "providerFailure" in result) {
        return yield* Effect.fail(
          yield* decodeProviderError(result.providerFailure).pipe(Effect.mapError(error)),
        );
      }
      return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(result).pipe(
        Effect.mapError(error),
      );
    });
  }
  return {
    instanceId: options.instanceId,
    driver: options.driver,
    getCapabilities: () => call("getCapabilities", null, C.OrchestrationV2ProviderCapabilities),
    planSelectionTransition: (input) =>
      call("planSelectionTransition", encodeSelectionSync(input), P.SelectionPlan),
    openSession: (input) =>
      Effect.gen(function* () {
        yield* configureMcp(input.threadId);
        if (!options.attachOnly)
          sessionClients.set(input.providerSessionId, {
            client: options.client,
            driver: options.driver,
            pendingCreation: true,
          });
        const description = yield* call(
          options.attachOnly ? "attachSession" : "openSession",
          yield* encodeOpenSession(input).pipe(Effect.mapError(error)),
          P.SessionDescription,
        );
        const sessionId = description.providerSessionId;
        sessionClients.set(sessionId, {
          client: options.client,
          driver: options.driver,
          pendingCreation: !options.attachOnly,
        });
        const optional = new Set(description.optionalMethods);
        const windows = new Map<string, number | null>();
        const transitions = new Map<string, boolean>();
        let previousSelection = input.modelSelection;
        const modelKey = (selection: C.ModelSelection, cwd?: string | null) =>
          JSON.stringify([selection, cwd ?? input.runtimePolicy.cwd]);
        const updateModelContext = (modelSelection: C.ModelSelection, cwd?: string | null) => {
          if (!optional.has("getModelContextWindow") && !optional.has("canReuseContextUsage"))
            return Effect.void;
          return call(
            "modelContext",
            { modelSelection, cwd, previous: previousSelection },
            P.ModelContextResult,
            sessionId,
          ).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                windows.set(modelKey(modelSelection, cwd), result.contextWindow);
                transitions.set(
                  JSON.stringify([previousSelection, modelSelection]),
                  result.reusable,
                );
                previousSelection = modelSelection;
              }),
            ),
            Effect.asVoid,
          );
        };
        yield* updateModelContext(input.modelSelection, input.runtimePolicy.cwd);
        const unit = (method: string, value: unknown, operationId?: string) =>
          call(method, value, Schema.Unknown, sessionId, operationId).pipe(Effect.asVoid);
        const events = Stream.suspend(() => {
          let after = options.eventCursor ?? 0;
          let initialized = false;
          return Stream.fromEffectRepeat(
            Effect.gen(function* () {
              if (!initialized) {
                const getCursor = options.getEventCursor;
                if (getCursor)
                  after = yield* Effect.tryPromise(() => getCursor(sessionId)).pipe(
                    Effect.mapError(error),
                  );
                initialized = true;
              }
              const batch = yield* Effect.tryPromise({
                try: (signal) => options.client.events(after, signal, sessionId),
                catch: (cause) =>
                  cause instanceof ExecutionTransportError
                    ? cause
                    : new ExecutionTransportError("unavailable"),
              }).pipe(
                Effect.retry({
                  while: (error) => error.code === "unavailable",
                  schedule: Schedule.spaced("1 second"),
                }),
                Effect.mapError(error),
              );
              const selected: A.ProviderAdapterV2Event[] = [];
              for (const envelope of batch) {
                if (envelope.sequence <= after)
                  return yield* Effect.fail(
                    error(new Error("Non-monotonic worker event sequence")),
                  );
                after = envelope.sequence;
                if (envelope.sessionId === sessionId) {
                  if (
                    envelope.event !== null &&
                    typeof envelope.event === "object" &&
                    "providerFailure" in envelope.event
                  ) {
                    return yield* Effect.fail(
                      yield* decodeProviderError(envelope.event.providerFailure).pipe(
                        Effect.mapError(error),
                      ),
                    );
                  }
                  const event = yield* decodeProviderEvent(envelope.event).pipe(
                    Effect.mapError(error),
                  );
                  eventEnvelopes.set(event, envelope);
                  if (event.type === "turn.terminal")
                    terminalCompletions.set(event, yield* Deferred.make<void>());
                  eventAcknowledgers.set(event, async () => {
                    const committed = await options.getEventCursor?.(sessionId);
                    if (committed !== undefined && committed >= envelope.sequence)
                      await options.client.ack(sessionId, committed);
                  });
                  selected.push(event);
                }
              }
              if (batch.length === 0) {
                const getCursor = options.getEventCursor;
                if (getCursor)
                  yield* Effect.tryPromise(async () => {
                    const committed = await getCursor(sessionId);
                    await options.client.ack(sessionId, committed);
                  }).pipe(Effect.catch(() => Effect.void));
                yield* Effect.sleep("100 millis");
              }
              return selected;
            }),
          ).pipe(Stream.flatMap(Stream.fromIterable));
        });
        const runtime: A.ProviderAdapterV2SessionRuntime = {
          instanceId: description.instanceId,
          driver: description.driver,
          providerSessionId: sessionId,
          providerSession: description.providerSession,
          events,
          ...(optional.has("getModelContextWindow")
            ? {
                getModelContextWindow: (selection: C.ModelSelection, cwd?: string | null) =>
                  windows.get(modelKey(selection, cwd)) ?? undefined,
              }
            : {}),
          ...(optional.has("canReuseContextUsage")
            ? {
                canReuseContextUsage: (previous: C.ModelSelection, next: C.ModelSelection) =>
                  transitions.get(JSON.stringify([previous, next])) ?? false,
              }
            : {}),
          ensureThread: (value) =>
            configureMcp(value.threadId).pipe(
              Effect.andThen(updateModelContext(value.modelSelection, value.runtimePolicy.cwd)),
              Effect.andThen(
                call(
                  "ensureThread",
                  encodeEnsureThreadSync(value),
                  C.OrchestrationV2ProviderThread,
                  sessionId,
                ),
              ),
            ),
          resumeThread: (value) =>
            (value.threadId ? configureMcp(value.threadId) : Effect.void).pipe(
              Effect.andThen(
                value.modelSelection
                  ? updateModelContext(value.modelSelection, value.runtimePolicy?.cwd)
                  : Effect.void,
              ),
              Effect.andThen(
                call(
                  "resumeThread",
                  encodeResumeThreadSync(value),
                  C.OrchestrationV2ProviderThread,
                  sessionId,
                ),
              ),
            ),
          startTurn: (value) =>
            (
              options.stageAttachments?.(value.threadId, value.message.attachments) ?? Effect.void
            ).pipe(
              Effect.andThen(configureMcp(value.threadId)),
              Effect.andThen(updateModelContext(value.modelSelection, value.runtimePolicy.cwd)),
              Effect.andThen(
                unit(
                  "startTurn",
                  encodeTurnSync(value),
                  `turn:${options.client.identity.incarnation}:${sessionId}:${value.attemptId}`,
                ),
              ),
            ),
          steerTurn: (value) =>
            (
              options.stageAttachments?.(value.threadId, value.message.attachments) ?? Effect.void
            ).pipe(
              Effect.andThen(
                unit(
                  "steerTurn",
                  encodeSteerSync(value),
                  `steer:${options.client.identity.incarnation}:${sessionId}:${value.message.messageId}`,
                ),
              ),
            ),
          interruptTurn: (value) => unit("interruptTurn", encodeInterruptSync(value)),
          respondToRuntimeRequest: (value) =>
            unit(
              "respondToRuntimeRequest",
              encodeRespondSync(value),
              `respond:${options.client.identity.incarnation}:${sessionId}:${value.requestId}`,
            ),
          readThreadSnapshot: (value) =>
            call("readThreadSnapshot", encodeThreadSync(value), P.Snapshot, sessionId),
          rollbackThread: (value) =>
            call("rollbackThread", encodeRollbackSync(value), P.Snapshot, sessionId),
          forkThread: (value) =>
            call("forkThread", encodeForkSync(value), C.OrchestrationV2ProviderThread, sessionId),
          ...(optional.has("hasPendingBackgroundWork")
            ? {
                hasPendingBackgroundWork: call(
                  "hasPendingBackgroundWork",
                  null,
                  Schema.Boolean,
                  sessionId,
                ).pipe(Effect.orElseSucceed(() => true)),
              }
            : {}),
          ...(optional.has("hasPendingBackgroundWorkForThread")
            ? {
                hasPendingBackgroundWorkForThread: (
                  providerThread: C.OrchestrationV2ProviderThread,
                ) =>
                  call(
                    "hasPendingBackgroundWorkForThread",
                    encodeThreadSync({ providerThread }),
                    Schema.Boolean,
                    sessionId,
                  ).pipe(Effect.orElseSucceed(() => true)),
              }
            : {}),
          ...(optional.has("injectHistory")
            ? {
                injectHistory: (
                  value: Parameters<
                    NonNullable<A.ProviderAdapterV2SessionRuntime["injectHistory"]>
                  >[0],
                ) => call("injectHistory", encodeHistorySync(value), Schema.Boolean, sessionId),
              }
            : {}),
          ...(optional.has("compactThread")
            ? {
                compactThread: (value: A.ProviderAdapterV2TurnInput) =>
                  unit(
                    "compactThread",
                    encodeTurnSync(value),
                    `turn:${options.client.identity.incarnation}:${sessionId}:${value.attemptId}`,
                  ),
              }
            : {}),
          ...(optional.has("unloadThread")
            ? {
                unloadThread: (value: typeof P.Thread.Type) =>
                  unit("unloadThread", encodeThreadSync(value)),
              }
            : {}),
          ...(optional.has("uploadFeedback")
            ? {
                uploadFeedback: (value: typeof P.Feedback.Type) =>
                  call(
                    "uploadFeedback",
                    encodeFeedbackSync(value),
                    Schema.Struct({ feedbackId: Schema.String }),
                    sessionId,
                  ),
              }
            : {}),
          ...(optional.has("mcpApps")
            ? {
                mcpApps: {
                  listTools: (value: typeof P.McpList.Type) =>
                    call(
                      "mcp.listTools",
                      encodeMcpListSync(value),
                      Schema.Array(
                        Schema.Struct({
                          name: Schema.String,
                          _meta: Schema.optionalKey(Schema.Unknown),
                          annotations: Schema.optionalKey(Schema.Unknown),
                        }),
                      ),
                      sessionId,
                    ),
                  callTool: (value: typeof P.McpCall.Type) =>
                    call(
                      "mcp.callTool",
                      encodeMcpCallSync(value),
                      Schema.Struct({
                        content: Schema.Array(Schema.Unknown),
                        structuredContent: Schema.optionalKey(Schema.Unknown),
                        isError: Schema.optionalKey(Schema.Boolean),
                        _meta: Schema.optionalKey(Schema.Unknown),
                      }),
                      sessionId,
                    ),
                  readResource: (value: typeof P.McpRead.Type) =>
                    call(
                      "mcp.readResource",
                      encodeMcpReadSync(value),
                      Schema.Struct({ contents: Schema.Array(Schema.Unknown) }),
                      sessionId,
                    ),
                },
              }
            : {}),
        };
        // Central transport scope disposal must not kill a surviving remote provider.
        sessionClients.set(sessionId, {
          client: options.client,
          driver: options.driver,
          pendingCreation: false,
        });
        return runtime;
      }),
  };
}
