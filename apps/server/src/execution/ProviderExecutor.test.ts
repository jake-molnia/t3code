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
