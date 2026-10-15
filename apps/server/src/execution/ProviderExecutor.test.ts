import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import type * as A from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { migrateGatewayModelSelection } from "./GatewayMigration.ts";
import { makeProviderExecutor } from "./ProviderExecutor.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { captureRunPromise } from "./EffectHttpBoundary.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "provider question quiescence",
  (it) => {
    it.effect(
      "releases idle message questions while keeping callbacks and running work alive",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "question-quiescence-" });
          const journal = yield* Effect.acquireRelease(
            Effect.tryPromise(() => openWorkerJournal(path.join(directory, "journal"))),
            (value) => Effect.promise(value.close),
          );
          const events = yield* Queue.unbounded<A.ProviderAdapterV2Event>();
          const published = yield* Queue.unbounded<unknown>();
          const run = yield* captureRunPromise;
          const instanceId = C.ProviderInstanceId.make("codex");
          const driver = C.ProviderDriverKind.make("codex");
          const providerSessionId = C.ProviderSessionId.make("session");
          const threadId = C.ThreadId.make("thread");
          const now = yield* DateTime.now;
          let background = false;
          const unused = () => Effect.die("Unused external provider operation");
          const adapter: A.ProviderAdapterV2["Service"] = {
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: () =>
              Effect.succeed({
                instanceId,
                driver,
                providerSessionId,
                providerSession: {
                  id: providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd: directory,
                  model: "test",
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: unused,
                resumeThread: unused,
                startTurn: unused,
                steerTurn: unused,
                interruptTurn: unused,
                respondToRuntimeRequest: unused,
                readThreadSnapshot: unused,
                rollbackThread: unused,
                forkThread: unused,
                hasPendingBackgroundWork: Effect.sync(() => background),
              }),
          };
          const executor = yield* makeProviderExecutor({
            adapters: new Map([[instanceId, adapter]]),
            publish: (_id, event) => run(Queue.offer(published, event)).then(() => undefined),
          });
          yield* executor.execute("openSession", {
            instanceId,
            input: {
              threadId,
              providerSessionId,
              modelSelection: { instanceId, model: "test" },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: directory,
              },
            },
          });
          const identity = {
            workspaceId: "workspace",
            allocationId: "1",
            generation: 1,
            incarnation: "one",
            podUid: "pod",
            protocolVersion: 1,
          } as const;
          const token = "question-test-token-at-least-thirty-two-characters";
          const worker = createExecutionWorker({
            identity,
            token,
            journal,
            execute: (method, input) => run(executor.execute(method, input)),
            activity: () => run(executor.activity),
          });
          let revision = 0;
          const transition = (action: "quiesce" | "resume") =>
            Effect.tryPromise(() =>
              worker.handle(
                new Request(`http://worker/v1/${action}`, {
                  method: "POST",
                  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                  body: JSON.stringify({
                    identity,
                    revision: ++revision,
                    operationId: `transition-${revision}`,
                  }),
                }),
              ),
            );
          const request: C.OrchestrationV2RuntimeRequest = {
            id: C.RuntimeRequestId.make("question"),
            nodeId: C.NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          };
          const emit = (event: A.ProviderAdapterV2Event) =>
            Queue.offer(events, event).pipe(Effect.andThen(Queue.take(published)));
          const notification = yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: request,
          });
          expect(notification).toMatchObject({
            runtimeRequest: { status: "pending", responseCapability: { type: "message" } },
          });
          expect(yield* executor.activity).toEqual({ activeOperations: 0, pendingCallbacks: 0 });
          expect((yield* transition("quiesce")).status).toBe(200);
          expect((yield* transition("resume")).status).toBe(200);
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: { ...request, responseCapability: { type: "live", providerSessionId } },
          });
          expect((yield* transition("quiesce")).status).toBe(409);
          expect((yield* executor.activity).pendingCallbacks).toBe(1);
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: { ...request, status: "resolved", resolvedAt: now },
          });
          const providerTurn: C.OrchestrationV2ProviderTurn = {
            id: C.ProviderTurnId.make("turn"),
            providerThreadId: C.ProviderThreadId.make("provider-thread"),
            nodeId: C.NodeId.make("node"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          };
          yield* emit({ type: "provider_turn.updated", driver, providerTurn });
          expect((yield* transition("quiesce")).status).toBe(409);
          yield* emit({
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...providerTurn, status: "completed", completedAt: now },
          });
          background = true;
          expect((yield* transition("quiesce")).status).toBe(409);
          background = false;
          expect((yield* transition("quiesce")).status).toBe(200);
        }),
    );
  },
);

it.effect.each(["aperture-anthropic/claude", "default"])(
  "gateway admits %s before normalizing and keeps session closure available during outages",
  (savedModel) =>
    Effect.gen(function* () {
      const instanceId = C.ProviderInstanceId.make("pi");
      const driver = C.ProviderDriverKind.make("pi");
      const providerSessionId = C.ProviderSessionId.make("gateway-session");
      const threadId = C.ThreadId.make("thread");
      const now = yield* DateTime.now;
      const prepared: string[] = [];
      const received: string[] = [];
      let available = true;
      let preparedDefault = false;
      let currentDefault = "gateway/claude";
      const admitted = new Set(["gateway/claude"]);
      let closed = false;
      const unused = () => Effect.die("Unexpected provider operation");
      const providerThread: C.OrchestrationV2ProviderThread = {
        id: C.ProviderThreadId.make("provider-thread"),
        driver,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const adapter: A.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            received.push(input.modelSelection.model);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            );
            return {
              instanceId,
              driver,
              providerSessionId,
              providerSession: {
                id: providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: "/workspace",
                model: input.modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: (next) =>
                Effect.sync(() => {
                  received.push(next.modelSelection.model);
                  return providerThread;
                }),
              resumeThread: unused,
              startTurn: unused,
              steerTurn: unused,
              interruptTurn: unused,
              respondToRuntimeRequest: unused,
              readThreadSnapshot: unused,
              rollbackThread: unused,
              forkThread: unused,
            };
          }),
      };
      const executor = yield* makeProviderExecutor({
        adapters: new Map([[instanceId, adapter]]),
        publish: async () => {},
        normalizeSelection: (driver, selection) =>
          selection.model === "default" && preparedDefault
            ? { ...selection, model: currentDefault }
            : migrateGatewayModelSelection(driver, selection),
        prepareInference: async (driver, model) => {
          if (!available) throw new Error("The model gateway is unavailable.");
          if (model === "default") {
            preparedDefault = true;
            prepared.push(currentDefault);
          } else if (model) {
            const resolved = migrateGatewayModelSelection(driver, { instanceId, model }).model;
            if (!admitted.has(resolved))
              throw new Error("The selected model is no longer available. Select another model.");
            prepared.push(resolved);
          }
        },
      });
      const input = {
        threadId,
        providerSessionId,
        modelSelection: { instanceId, model: savedModel },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      };
      yield* executor.execute("openSession", { instanceId, input });
      yield* executor.execute("ensureThread", { sessionId: providerSessionId, input });
      expect(prepared).toEqual(["gateway/claude", "gateway/claude"]);
      expect(received).toEqual(prepared);
      currentDefault = "gateway/new-model";
      admitted.add(currentDefault);
      yield* executor.execute("ensureThread", { sessionId: providerSessionId, input });
      expect(received).toEqual(["gateway/claude", "gateway/claude", "gateway/claude"]);
      admitted.delete("gateway/claude");
      const removed = yield* Effect.flip(
        executor
          .execute("ensureThread", { sessionId: providerSessionId, input })
          .pipe(Effect.asVoid),
      );
      expect(removed.code).toBe("provider_execution");
      expect(received).toHaveLength(3);
      available = false;
      const failure = yield* Effect.flip(
        executor
          .execute("ensureThread", { sessionId: providerSessionId, input })
          .pipe(Effect.asVoid),
      );
      expect(failure.code).toBe("provider_execution");
      expect(received).toHaveLength(3);
      yield* executor.execute("closeSession", { sessionId: providerSessionId, input: {} });
      expect(closed).toBe(true);
    }).pipe(Effect.scoped),
);
