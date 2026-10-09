import { sandboxInput } from "./HarnessDefaults.ts";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as C from "@t3tools/contracts";
import * as A from "@t3tools/provider-core/server/ProviderAdapter";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as P from "./ProviderProtocol.ts";

const decodeMcpConfiguration = Schema.decodeUnknownEffect(Schema.toCodecJson(P.McpConfiguration));
const decodeAdapterCommand = Schema.decodeUnknownEffect(Schema.toCodecJson(P.AdapterCommand));
const encodeProviderCapabilities = Schema.encodeEffect(
  Schema.toCodecJson(C.OrchestrationV2ProviderCapabilities),
);
const decodeSelection = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Selection));
const decodeOpenSession = Schema.decodeUnknownEffect(Schema.toCodecJson(P.OpenSession));
const encodeSessionDescription = Schema.encodeEffect(Schema.toCodecJson(P.SessionDescription));
const encodeProviderEvent = Schema.encodeEffect(Schema.toCodecJson(A.ProviderAdapterV2Event));
const encodeProviderError = Schema.encodeEffect(Schema.toCodecJson(A.ProviderAdapterV2Error));
const decodeAdapterCommand2 = Schema.decodeUnknownEffect(P.AdapterCommand);
const decodeProviderSessionIdInput = Schema.decodeUnknownEffect(
  Schema.Struct({ providerSessionId: C.ProviderSessionId }),
);
const decodeSessionCommand = Schema.decodeUnknownEffect(Schema.toCodecJson(P.SessionCommand));
const decodeModelContext = Schema.decodeUnknownEffect(P.ModelContext);
const encodeProviderThread = Schema.encodeEffect(
  Schema.toCodecJson(C.OrchestrationV2ProviderThread),
);
const decodeEnsureThread = Schema.decodeUnknownEffect(Schema.toCodecJson(P.EnsureThread));
const decodeResumeThread = Schema.decodeUnknownEffect(Schema.toCodecJson(P.ResumeThread));
const decodeTurn = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Turn));
const decodeSteer = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Steer));
const decodeInterrupt = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Interrupt));
const decodeRespond = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Respond));
const encodeSnapshot = Schema.encodeEffect(Schema.toCodecJson(P.Snapshot));
const decodeThread = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Thread));
const decodeRollback = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Rollback));
const decodeFork = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Fork));
const decodeHistory = Schema.decodeUnknownEffect(Schema.toCodecJson(P.History));
const decodeFeedback = Schema.decodeUnknownEffect(Schema.toCodecJson(P.Feedback));
const decodeMcpList = Schema.decodeUnknownEffect(Schema.toCodecJson(P.McpList));
const decodeMcpCall = Schema.decodeUnknownEffect(Schema.toCodecJson(P.McpCall));
const decodeMcpRead = Schema.decodeUnknownEffect(Schema.toCodecJson(P.McpRead));

export class ProviderExecutionError extends Schema.TaggedError<ProviderExecutionError>()(
  "ProviderExecutionError",
  { code: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Created once in the worker application's scope, independent of central HTTP connections. */
export const makeProviderExecutor = (options: {
  configureMcp?: (config: McpProviderSessionConfig) => void;
  closeMcp?: (threadId: C.ThreadId, instanceId: C.ProviderInstanceId) => void;
  adapters: ReadonlyMap<C.ProviderInstanceId, A.ProviderAdapterV2Shape>;
  publish: (sessionId: string, event: unknown) => Promise<void>;
}) =>
  Effect.gen(function* () {
    const workerScope = yield* Effect.scope;
    const sessions = new Map<
      C.ProviderSessionId,
      { runtime: A.ProviderAdapterV2SessionRuntime; scope: Scope.Closeable }
    >();
    const openingSessions = new Set<C.ProviderSessionId>();
    const openingScopes = new Map<C.ProviderSessionId, Scope.Closeable>();
    const retiredSessions = new Set<C.ProviderSessionId>();
    const activeTurns = new Map<string, C.ProviderSessionId>();
    const nativeTurns = new Map<string, C.ProviderSessionId>();
    const pendingCallbacks = new Map<string, C.ProviderSessionId>();
    const failedStreams = new Set<C.ProviderSessionId>();
    function track(sessionId: C.ProviderSessionId, event: A.ProviderAdapterV2Event) {
      if (event.type === "provider_turn.updated") {
        if (event.providerTurn.status === "pending" || event.providerTurn.status === "running")
          nativeTurns.set(event.providerTurn.id, sessionId);
        else nativeTurns.delete(event.providerTurn.id);
      }
      if (event.type === "runtime_request.updated") {
        if (event.runtimeRequest.status === "pending")
          pendingCallbacks.set(event.runtimeRequest.id, sessionId);
        else pendingCallbacks.delete(event.runtimeRequest.id);
      }
      if (event.type === "turn.terminal") {
        activeTurns.delete(`${event.providerThreadId}:${event.runOrdinal}`);
        nativeTurns.delete(event.providerTurnId);
      }
    }
    const activity = Effect.gen(function* () {
      let background = 0;
      for (const { runtime } of sessions.values()) {
        if (runtime.hasPendingBackgroundWork && (yield* runtime.hasPendingBackgroundWork))
          background++;
      }
      return {
        activeOperations: activeTurns.size + nativeTurns.size + failedStreams.size + background,
        pendingCallbacks: pendingCallbacks.size,
      };
    });
    function describeSession(
      runtime: A.ProviderAdapterV2SessionRuntime,
    ): typeof P.SessionDescription.Type {
      return {
        instanceId: runtime.instanceId,
        driver: runtime.driver,
        providerSessionId: runtime.providerSessionId,
        providerSession: runtime.providerSession,
        optionalMethods: Object.keys(P.OptionalSessionMethods).filter((key) => key in runtime),
      };
    }
    function execute(method: string, raw: unknown): Effect.Effect<unknown, ProviderExecutionError> {
      return Effect.gen(function* () {
        if (method === "configureMcp") {
          const input = yield* decodeMcpConfiguration(raw);
          if (!options.configureMcp)
            return yield* new ProviderExecutionError({ code: "mcp_unavailable" });
          const { capabilities, ...config } = input;
          options.configureMcp({
            ...config,
            ...(capabilities ? { capabilities: new Set(capabilities) } : {}),
          });
          return null;
        }
        if (
          method === "getCapabilities" ||
          method === "planSelectionTransition" ||
          method === "openSession"
        ) {
          const command = yield* decodeAdapterCommand(raw);
          const adapter = options.adapters.get(command.instanceId);
          if (!adapter)
            return yield* Effect.fail(new ProviderExecutionError({ code: "instance_unavailable" }));
          if (method === "getCapabilities")
            return yield* encodeProviderCapabilities(yield* adapter.getCapabilities());
          if (method === "planSelectionTransition")
            return yield* adapter.planSelectionTransition(yield* decodeSelection(command.input));
          const input = sandboxInput(yield* decodeOpenSession(command.input));
          if (retiredSessions.has(input.providerSessionId))
            return yield* new ProviderExecutionError({ code: "session_retired" });
          const live = sessions.get(input.providerSessionId);
          if (live) {
            if (live.runtime.instanceId !== command.instanceId)
              return yield* new ProviderExecutionError({ code: "session_instance_conflict" });
            return yield* encodeSessionDescription(describeSession(live.runtime));
          }
          if (openingSessions.has(input.providerSessionId))
            return yield* new ProviderExecutionError({ code: "session_opening" });
          openingSessions.add(input.providerSessionId);
          const scope = yield* Scope.make();
          openingScopes.set(input.providerSessionId, scope);
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => options.closeMcp?.(input.threadId, command.instanceId)),
          );
          yield* Scope.addFinalizer(workerScope, Scope.close(scope, Exit.void));
          const runtime = yield* adapter.openSession(input).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
            Effect.ensuring(
              Effect.sync(() => {
                openingSessions.delete(input.providerSessionId);
                openingScopes.delete(input.providerSessionId);
              }),
            ),
          );
          sessions.set(input.providerSessionId, { runtime, scope });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                track(input.providerSessionId, event);
                const encoded = yield* encodeProviderEvent(event);
                yield* Effect.tryPromise(() => options.publish(input.providerSessionId, encoded));
              }),
            ),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                failedStreams.add(input.providerSessionId);
                const failure = Schema.is(A.ProviderAdapterV2Error)(cause)
                  ? cause
                  : new A.ProviderAdapterEventStreamError({
                      driver: runtime.driver,
                      providerSessionId: input.providerSessionId,
                      cause,
                    });
                const providerFailure = yield* encodeProviderError(failure);
                yield* Effect.tryPromise(() =>
                  options.publish(input.providerSessionId, { providerFailure }),
                );
                yield* Scope.close(scope, Exit.void).pipe(Effect.forkIn(workerScope));
              }),
            ),
            Effect.forkIn(scope),
          );
          return yield* encodeSessionDescription(describeSession(runtime));
        }
        if (method === "describeSession" || method === "attachSession") {
          const command = yield* decodeAdapterCommand2(raw);
          const input = yield* decodeProviderSessionIdInput(command.input);
          const live = retiredSessions.has(input.providerSessionId)
            ? undefined
            : sessions.get(input.providerSessionId);
          if (!live && method === "describeSession") return null;
          if (!live || live.runtime.instanceId !== command.instanceId)
            return yield* new ProviderExecutionError({ code: "session_not_live" });
          return yield* encodeSessionDescription(describeSession(live.runtime));
        }
        const command = yield* decodeSessionCommand(raw);
        if (method === "closeSession") {
          retiredSessions.add(command.sessionId);
          const opening = openingScopes.get(command.sessionId);
          if (opening) yield* Scope.close(opening, Exit.void);
        }
        const session = sessions.get(command.sessionId);
        if (!session && method === "closeSession") return null;
        if (!session)
          return yield* Effect.fail(new ProviderExecutionError({ code: "session_not_live" }));
        const runtime = session.runtime;
        switch (method) {
          case "modelContext": {
            const input = yield* decodeModelContext(command.input);
            return {
              contextWindow:
                runtime.getModelContextWindow?.(input.modelSelection, input.cwd) ?? null,
              reusable: input.previous
                ? (runtime.canReuseContextUsage?.(input.previous, input.modelSelection) ?? false)
                : false,
            };
          }
          case "closeSession":
            yield* Scope.close(session.scope, Exit.void);
            sessions.delete(command.sessionId);
            failedStreams.delete(command.sessionId);
            for (const [key, id] of nativeTurns)
              if (id === command.sessionId) nativeTurns.delete(key);
            for (const [key, id] of activeTurns)
              if (id === command.sessionId) activeTurns.delete(key);
            for (const [key, id] of pendingCallbacks)
              if (id === command.sessionId) pendingCallbacks.delete(key);
            return null;
          case "ensureThread":
            return yield* encodeProviderThread(
              yield* runtime.ensureThread(sandboxInput(yield* decodeEnsureThread(command.input))),
            );
          case "resumeThread":
            return yield* encodeProviderThread(
              yield* runtime.resumeThread(sandboxInput(yield* decodeResumeThread(command.input))),
            );
          case "startTurn": {
            const input = sandboxInput(yield* decodeTurn(command.input));
            const key = `${input.providerThread.id}:${input.runOrdinal}`;
            activeTurns.set(key, command.sessionId);
            yield* runtime.startTurn(input).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  activeTurns.delete(key);
                }),
              ),
            );
            return null;
          }
          case "steerTurn":
            yield* runtime.steerTurn(yield* decodeSteer(command.input));
            return null;
          case "interruptTurn":
            yield* runtime.interruptTurn(yield* decodeInterrupt(command.input));
            return null;
          case "respondToRuntimeRequest":
            yield* runtime.respondToRuntimeRequest(yield* decodeRespond(command.input));
            return null;
          case "readThreadSnapshot":
            return yield* encodeSnapshot(
              yield* runtime.readThreadSnapshot(yield* decodeThread(command.input)),
            );
          case "rollbackThread":
            return yield* encodeSnapshot(
              yield* runtime.rollbackThread(yield* decodeRollback(command.input)),
            );
          case "forkThread":
            return yield* encodeProviderThread(
              yield* runtime.forkThread(sandboxInput(yield* decodeFork(command.input))),
            );
          case "hasPendingBackgroundWork":
            return runtime.hasPendingBackgroundWork
              ? yield* runtime.hasPendingBackgroundWork
              : false;
          case "hasPendingBackgroundWorkForThread":
            return runtime.hasPendingBackgroundWorkForThread
              ? yield* runtime.hasPendingBackgroundWorkForThread(
                  (yield* decodeThread(command.input)).providerThread,
                )
              : false;
          case "injectHistory":
            if (runtime.injectHistory)
              return yield* runtime.injectHistory(yield* decodeHistory(command.input));
            break;
          case "compactThread":
            if (runtime.compactThread) {
              const input = sandboxInput(yield* decodeTurn(command.input));
              const key = `${input.providerThread.id}:${input.runOrdinal}`;
              activeTurns.set(key, command.sessionId);
              yield* runtime.compactThread(input).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    activeTurns.delete(key);
                  }),
                ),
              );
              return null;
            }
            break;
          case "unloadThread":
            if (runtime.unloadThread) {
              yield* runtime.unloadThread(yield* decodeThread(command.input));
              return null;
            }
            break;
          case "uploadFeedback":
            if (runtime.uploadFeedback)
              return yield* runtime.uploadFeedback(yield* decodeFeedback(command.input));
            break;
          case "mcp.listTools":
            if (runtime.mcpApps)
              return yield* runtime.mcpApps.listTools(yield* decodeMcpList(command.input));
            break;
          case "mcp.callTool":
            if (runtime.mcpApps)
              return yield* runtime.mcpApps.callTool(yield* decodeMcpCall(command.input));
            break;
          case "mcp.readResource":
            if (runtime.mcpApps)
              return yield* runtime.mcpApps.readResource(yield* decodeMcpRead(command.input));
            break;
        }
        return yield* Effect.fail(new ProviderExecutionError({ code: "method_unsupported" }));
      }).pipe(
        Effect.catch((cause) => {
          if (Schema.is(A.ProviderAdapterV2Error)(cause)) {
            return encodeProviderError(cause).pipe(
              Effect.map((providerFailure) => ({ providerFailure })),
              Effect.mapError(
                (cause) => new ProviderExecutionError({ code: "failure_encoding", cause }),
              ),
            );
          }
          return Effect.fail(
            Schema.is(ProviderExecutionError)(cause)
              ? cause
              : new ProviderExecutionError({ code: "provider_execution", cause }),
          );
        }),
      );
    }
    return { execute, activity };
  });
