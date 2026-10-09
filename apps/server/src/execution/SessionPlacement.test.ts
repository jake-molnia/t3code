import { captureRunPromise } from "./EffectHttpBoundary.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Two isolated HTTP workers exercise the placement decision.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as C from "@t3tools/contracts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { providerSessionIdFor, SessionPlacement } from "./SessionPlacement.ts";
import { makeProviderExecutor } from "./ProviderExecutor.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { createRemoteProviderAdapter } from "./RemoteProviderAdapter.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

// The external provider advertises multiplexing. Placement must still isolate app threads.
const native: ProviderAdapterV2Shape = {
  instanceId: C.ProviderInstanceId.make("codex"),
  driver: C.ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const unsupported = () => Effect.die("External provider method not used by this test");
      return {
        instanceId: native.instanceId,
        driver: native.driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: native.driver,
          providerInstanceId: native.instanceId,
          status: "ready" as const,
          cwd: "/workspace",
          model: "test",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        ensureThread: unsupported,
        resumeThread: unsupported,
        startTurn: unsupported,
        steerTurn: unsupported,
        interruptTurn: unsupported,
        respondToRuntimeRequest: unsupported,
        readThreadSnapshot: unsupported,
        rollbackThread: unsupported,
        forkThread: unsupported,
      };
    }),
};

it.live("multiplexing providers get independent sessions in separate top-level workers", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const ids = [];
        for (const name of ["root-a", "root-b"]) {
          const directory = yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-placement-")),
            ),
            (directory) =>
              Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
          );
          const journal = yield* Effect.acquireRelease(
            Effect.tryPromise(() => openWorkerJournal(NodePath.join(directory, "journal"))),
            (journal) => Effect.promise(journal.close),
          );
          const executor = yield* makeProviderExecutor({
            adapters: new Map([[native.instanceId, native]]),
            publish: async () => {},
          });
          const runPromise = yield* captureRunPromise;
          const identity = {
            workspaceId: name,
            allocationId: name,
            podUid: name,
            generation: 1,
            incarnation: name,
            protocolVersion: 1 as const,
          };
          const token = `test-worker-${name}-token-more-than-thirty-two-characters`;
          const worker = createExecutionWorker({
            identity,
            token,
            journal,
            execute: (method, input) => runPromise(executor.execute(method, input)),
          });
          const server = yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
            ),
            (server) => Effect.promise(server.close),
          );
          const client = createExecutionClient({
            identity,
            token,
            endpoint: `http://127.0.0.1:${server.port}`,
          });
          const providerSessionId = yield* providerSessionIdFor({
            adapter: native,
            providerInstanceId: native.instanceId,
            threadId: C.ThreadId.make(name),
          });
          ids.push(providerSessionId);
          const remote = createRemoteProviderAdapter({
            instanceId: native.instanceId,
            driver: native.driver,
            client,
          });
          const session = yield* remote.openSession({
            threadId: C.ThreadId.make(name),
            providerSessionId,
            modelSelection: { instanceId: native.instanceId, model: "test" },
            runtimePolicy: {
              cwd: "/workspace",
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          });
          expect(session.providerSession.id).toBe(providerSessionId);
        }
        expect(ids[0]).not.toBe(ids[1]);
        expect(ids.every((id) => !id.endsWith(":shared"))).toBe(true);
      }),
    ).pipe(
      Effect.provideService(SessionPlacement, "per-thread"),
      Effect.provide(IdAllocator.layer),
    );
  }),
);
