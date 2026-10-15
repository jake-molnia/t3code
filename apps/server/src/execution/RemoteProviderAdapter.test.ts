import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { captureRunPromise } from "./EffectHttpBoundary.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real HTTP worker with an external-provider test double.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as C from "@t3tools/contracts";
import type * as A from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeProviderExecutor } from "./ProviderExecutor.ts";
import { createExecutionWorker, type ExecutionWorker } from "./ExecutionWorker.ts";
import { createExecutionClient, ExecutionTransportError } from "./ExecutionClient.ts";
import {
  ackRemoteEvent,
  createRemoteProviderAdapter,
  remoteEventEnvelope,
} from "./RemoteProviderAdapter.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

it.live(
  "provider JSON transport recovers event timeouts without replaying mutations and preserves native sessions",
  () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const directory = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-provider-transport-")),
      );
      const journal = yield* Effect.tryPromise(() =>
        openWorkerJournal(NodePath.join(directory, "journal")),
      );
      const instanceId = C.ProviderInstanceId.make("codex");
      const driver = C.ProviderDriverKind.make("codex");
      const providerSessionId = C.ProviderSessionId.make("session");
      const identity = {
        workspaceId: "workspace",
        allocationId: "allocation",
        podUid: "pod",
        generation: 1,
        incarnation: "worker",
        protocolVersion: 1 as const,
      };
      const token = "test-worker-token-longer-than-thirty-two-characters";
      let closed = 0;
      let responses = 0;
      let forwardedEndpoint: string | undefined;
      const optionalCalls: string[] = [];
      const session: C.OrchestrationV2ProviderSession = {
        id: providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/workspace",
        model: "test-model",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        lastError: null,
      };
      const unsupported = () => Effect.die("Test did not supply this external provider operation");
      const adapter: A.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed++;
              }),
            );
            return {
              instanceId,
              driver,
              providerSessionId,
              providerSession: session,
              events: Stream.make({
                type: "provider_session.updated",
                driver,
                providerSession: session,
              } satisfies A.ProviderAdapterV2Event),
              ensureThread: unsupported,
              resumeThread: unsupported,
              startTurn: unsupported,
              steerTurn: unsupported,
              interruptTurn: unsupported,
              stopTask: ({ providerThread, taskId }) =>
                Effect.sync(() => {
                  expect(providerThread.providerSessionId).toBe(providerSessionId);
                  optionalCalls.push(`task:${taskId}`);
                }),
              stopSubagent: ({ providerThread, nativeTaskId }) =>
                Effect.sync(() => {
                  expect(providerThread.providerSessionId).toBe(providerSessionId);
                  optionalCalls.push(`subagent:${nativeTaskId}`);
                }),
              respondToRuntimeRequest: () =>
                Effect.sync(() => {
                  responses++;
                }),
              getModelContextWindow: (selection: C.ModelSelection) =>
                selection.model === "test-model" ? 77_000 : 33_000,
              canReuseContextUsage: (previous: C.ModelSelection, next: C.ModelSelection) =>
                previous.model === next.model,
              hasPendingBackgroundWork: Effect.succeed(true),
              hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
              injectHistory: () =>
                Effect.sync(() => {
                  optionalCalls.push("history");
                  return true;
                }),
              compactThread: () =>
                Effect.sync(() => {
                  optionalCalls.push("compact");
                }),
              unloadThread: () =>
                Effect.sync(() => {
                  optionalCalls.push("unload");
                }),
              uploadFeedback: () => Effect.succeed({ feedbackId: "feedback-1" }),
              mcpApps: {
                listTools: () => Effect.succeed([{ name: "widget", _meta: { ui: true } }]),
                callTool: () =>
                  Effect.succeed({
                    content: [{ type: "text", text: "tool response" }],
                    structuredContent: { count: 1 },
                  }),
                readResource: () =>
                  Effect.succeed({ contents: [{ uri: "ui://widget", text: "widget body" }] }),
              },
              readThreadSnapshot: unsupported,
              rollbackThread: unsupported,
              forkThread: unsupported,
            };
          }),
      };
      let server: Awaited<ReturnType<typeof listenWorker>> | undefined;
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let worker: ExecutionWorker | undefined;
            const executor = yield* makeProviderExecutor({
              adapters: new Map([[instanceId, adapter]]),
              configureMcp: (configuration) => {
                forwardedEndpoint = configuration.endpoint;
              },
              publish: (id, event) => {
                if (!worker) return Promise.reject(new Error("Worker not listening"));
                return worker.publish(id, event);
              },
            });
            const runPromise = yield* captureRunPromise;
            worker = createExecutionWorker({
              identity,
              token,
              journal,
              execute: (method, input) => runPromise(executor.execute(method, input)),
              activity: () => runPromise(executor.activity),
            });
            server = yield* Effect.promise(() =>
              listenWorker({ host: "127.0.0.1", port: 0, handle: worker!.handle }),
            );
            const liveClient = createExecutionClient({
              endpoint: `http://127.0.0.1:${server.port}`,
              token,
              identity,
            });
            const eventCursors: number[] = [];
            const mutationCalls: string[] = [];
            const acknowledged: number[] = [];
            let committedCursor = 0;
            let terminalFailure:
              | "identity_changed"
              | "authorization"
              | "sequence_conflict"
              | undefined;
            let firstBatch: Awaited<ReturnType<typeof liveClient.events>> | undefined;
            const client: typeof liveClient = {
              ...liveClient,
              ack: async (sessionId, sequence) => {
                acknowledged.push(sequence);
                await liveClient.ack(sessionId, sequence);
              },
              call: async (method, value, operationId) => {
                mutationCalls.push(method);
                return liveClient.call(method, value, operationId);
              },
              events: async (after, signal, sessionId, waitMs) => {
                eventCursors.push(after);
                if (terminalFailure === "sequence_conflict") {
                  const envelope = firstBatch?.[0];
                  if (!envelope) throw new Error("Missing captured event");
                  return [{ ...envelope, sequence: after }];
                }
                if (terminalFailure) throw new ExecutionTransportError(terminalFailure);
                if (eventCursors.length === 1) throw new ExecutionTransportError("timeout");
                if (eventCursors.length === 3) {
                  const envelope = firstBatch?.[0];
                  if (!worker || !envelope) throw new Error("Missing live worker event");
                  await worker.publish(envelope.sessionId, envelope.event);
                  throw new ExecutionTransportError("timeout");
                }
                const batch = await liveClient.events(after, signal, sessionId, waitMs);
                firstBatch ??= batch;
                return batch;
              },
            };
            yield* mcpSessions.set({
              environmentId: C.EnvironmentId.make("central"),
              threadId: C.ThreadId.make("thread"),
              providerSessionId,
              providerInstanceId: instanceId,
              endpoint: "http://127.0.0.1:3773/mcp",
              authorizationHeader: "Bearer upstream",
              browserToolsAvailable: true,
            });
            let cursorReads = 0;
            const remote = createRemoteProviderAdapter({
              mcpSessions: yield* McpProviderSessions.McpProviderSessions,
              instanceId,
              driver,
              client,
              getEventCursor: async () => {
                cursorReads++;
                return committedCursor;
              },
              requireRemoteMcpEndpoint: true,
              mcpEndpoint: "http://t3-central:3773/mcp",
            });
            const runtime = yield* Effect.scoped(
              remote.openSession({
                threadId: C.ThreadId.make("thread"),
                providerSessionId,
                modelSelection: { instanceId, model: "test-model" },
                runtimePolicy: {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd: "/workspace",
                },
              }),
            );
            expect(closed).toBe(0);
            expect(forwardedEndpoint).toBe("http://t3-central:3773/mcp");
            expect(DateTime.formatIso(runtime.providerSession.createdAt)).toBe(
              "2026-01-01T00:00:00.000Z",
            );
            const callsBeforeReconnect = [...mutationCalls];
            const events = yield* Stream.runCollect(runtime.events.pipe(Stream.take(2)));
            expect(events).toHaveLength(2);
            expect(eventCursors).toEqual([0, 0, 1, 1]);
            expect(cursorReads).toBe(1);
            expect(events.map((event) => remoteEventEnvelope(event)?.sequence)).toEqual([1, 2]);
            expect(mutationCalls).toEqual(callsBeforeReconnect);
            for (const failure of [
              "identity_changed",
              "authorization",
              "sequence_conflict",
            ] as const) {
              terminalFailure = failure;
              const readsBefore = eventCursors.length;
              const exit = yield* Stream.runCollect(runtime.events).pipe(Effect.exit);
              expect(exit._tag).toBe("Failure");
              expect(eventCursors.length).toBe(readsBefore + 1);
              expect(mutationCalls).toEqual(callsBeforeReconnect);
            }
            terminalFailure = undefined;
            committedCursor = 2;
            const captured = firstBatch?.[0];
            if (!captured || !worker) return yield* Effect.die("Missing worker event");
            for (let index = 0; index < 32; index++) {
              yield* Effect.promise(() => worker!.publish(providerSessionId, captured.event));
            }
            const burst = yield* Stream.runCollect(
              runtime.events.pipe(
                Stream.take(32),
                Stream.tap((event) => {
                  committedCursor = Math.min(
                    remoteEventEnvelope(event)?.sequence ?? committedCursor,
                    33,
                  );
                  return ackRemoteEvent(event);
                }),
              ),
            );
            expect(burst).toHaveLength(32);
            expect(acknowledged).toEqual([]);
            const lastEvent = burst.at(-1);
            if (!lastEvent) return yield* Effect.die("Missing batch end");
            committedCursor = 34;
            yield* ackRemoteEvent(lastEvent);
            expect(acknowledged).toEqual([34]);
            yield* Effect.promise(() => worker!.publish(providerSessionId, captured.event));
            yield* Effect.promise(() =>
              worker!.publish(providerSessionId, {
                type: "turn.terminal",
                driver,
                providerThreadId: C.ProviderThreadId.make("thread"),
                providerTurnId: C.ProviderTurnId.make("turn"),
                runOrdinal: 1,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              } satisfies A.ProviderAdapterV2Event),
            );
            yield* Effect.promise(() => worker!.publish(providerSessionId, captured.event));
            yield* runtime.events.pipe(
              Stream.take(3),
              Stream.tap((event) => {
                committedCursor = remoteEventEnvelope(event)?.sequence ?? committedCursor;
                return ackRemoteEvent(event);
              }),
              Stream.runDrain,
            );
            expect(acknowledged).toEqual([34, 36, 37]);
            const event = events[0];
            expect(event?.type).toBe("provider_session.updated");
            if (event) expect(remoteEventEnvelope(event)?.sequence).toBe(1);
            yield* runtime.respondToRuntimeRequest({
              requestId: C.RuntimeRequestId.make("request"),
              decision: "accept",
            });
            yield* runtime.respondToRuntimeRequest({
              requestId: C.RuntimeRequestId.make("request"),
              decision: "accept",
            });
            expect(responses).toBe(1);
            const modelSelection = { instanceId, model: "test-model" };
            expect(runtime.getModelContextWindow?.(modelSelection)).toBe(77_000);
            expect(runtime.canReuseContextUsage?.(modelSelection, modelSelection)).toBe(true);
            expect(
              runtime.canReuseContextUsage?.(modelSelection, { instanceId, model: "unknown" }),
            ).toBe(false);
            expect(
              yield* runtime.hasPendingBackgroundWork ?? Effect.die("Missing background probe"),
            ).toBe(true);
            const threadId = C.ThreadId.make("thread");
            const providerThread: C.OrchestrationV2ProviderThread = {
              id: C.ProviderThreadId.make("provider-thread"),
              driver,
              providerInstanceId: instanceId,
              providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            };
            expect(
              yield* (
                runtime.hasPendingBackgroundWorkForThread?.(providerThread) ??
                  Effect.die("Missing scoped background probe")
              ),
            ).toBe(true);
            expect(
              yield* (
                runtime.injectHistory?.({
                  providerThread,
                  messages: [],
                  context: "prior context",
                }) ?? Effect.die("Missing history injection")
              ),
            ).toBe(true);
            expect(
              yield* runtime.uploadFeedback?.({ providerThread }) ?? Effect.die("Missing feedback"),
            ).toEqual({ feedbackId: "feedback-1" });
            expect(
              yield* (
                runtime.mcpApps?.listTools({ providerThread, server: "test" }) ??
                  Effect.die("Missing MCP apps")
              ),
            ).toEqual([{ name: "widget", _meta: { ui: true } }]);
            expect(
              yield* (
                runtime.mcpApps?.callTool({
                  providerThread,
                  server: "test",
                  tool: "widget",
                  arguments: {},
                }) ?? Effect.die("Missing MCP apps")
              ),
            ).toMatchObject({ structuredContent: { count: 1 } });
            expect(
              yield* (
                runtime.mcpApps?.readResource({
                  providerThread,
                  server: "test",
                  uri: "ui://widget",
                }) ?? Effect.die("Missing MCP apps")
              ),
            ).toEqual({ contents: [{ uri: "ui://widget", text: "widget body" }] });
            const appThread: C.OrchestrationV2AppThread = {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: C.ProjectId.make("project"),
              title: "Test",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: "/workspace",
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            };
            yield* (
              runtime.compactThread?.({
                appThread,
                threadId,
                runId: C.RunId.make("compact"),
                runOrdinal: 1,
                providerTurnOrdinal: 1,
                attemptId: C.RunAttemptId.make("compact-attempt"),
                rootNodeId: C.NodeId.make("compact-node"),
                providerThread,
                message: {
                  messageId: C.MessageId.make("compact-message"),
                  text: "/compact",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
                modelSelection,
                runtimePolicy: {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd: "/workspace",
                },
              }) ?? Effect.die("Missing compaction")
            );
            yield* (
              runtime.stopTask?.({ providerThread, taskId: "background-command" }) ??
                Effect.die("Missing stopTask")
            );
            yield* (
              runtime.stopSubagent?.({ providerThread, nativeTaskId: "native-child" }) ??
                Effect.die("Missing stopSubagent")
            );
            yield* runtime.unloadThread?.({ providerThread }) ?? Effect.die("Missing unload");
            expect(optionalCalls).toEqual([
              "history",
              "compact",
              "task:background-command",
              "subagent:native-child",
              "unload",
            ]);
          }),
        );
        expect(closed).toBe(1);
      } finally {
        yield* mcpSessions.clear(C.ThreadId.make("thread"));
        yield* Effect.promise(async () => {
          await server?.close();
        });
        yield* Effect.promise(journal.close);
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
