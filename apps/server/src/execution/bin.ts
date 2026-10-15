import { makeWorkerUsage } from "./WorkerUsage.ts";
import { makeIdeActivity } from "./IdeActivity.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeGitDriverExecutor } from "../agentRuntime/worker/GitDriverExecutor.ts";
import { makeMetadataExecutor } from "../agentRuntime/worker/MetadataExecutor.ts";
import { makeAssetExecutor } from "../agentRuntime/worker/AssetExecutor.ts";
import { makeForkExecutor } from "../agentRuntime/worker/ForkExecutor.ts";
import { captureRunPromise } from "./EffectHttpBoundary.ts";
import * as WorkerPreviewLayers from "../agentRuntime/worker/WorkerPreviewLayers.ts";
import { makePreviewExecutor } from "../agentRuntime/worker/PreviewExecutor.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkerWorkspaceLayers from "../agentRuntime/worker/WorkerWorkspaceLayers.ts";
import { makeWorkspaceExecutor } from "../agentRuntime/worker/WorkspaceExecutor.ts";
import { makeTerminalExecutor } from "../agentRuntime/worker/TerminalExecutor.ts";
import { makeComputerExecutor } from "../agentRuntime/worker/ComputerExecutor.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Standalone worker application boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderRegistry from "../provider/ProviderInstanceRegistry.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { workerLayers } from "./WorkerLayers.ts";
import * as WorkerProviders from "./WorkerProviders.ts";
import { makeProviderExecutor } from "./ProviderExecutor.ts";
import { createMcpForwarder } from "./McpForwarder.ts";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker, type ExecutionWorker } from "./ExecutionWorker.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

const program = Effect.gen(function* () {
  const workspaceId = yield* Config.String("T3_WORKSPACE_ID");
  const allocationId = yield* Config.String("T3_ALLOCATION_ID");
  const generation = yield* Config.Int("T3_ALLOCATION_GENERATION");
  const podUid = yield* Config.String("T3_POD_UID");
  const token = yield* Config.String("T3_WORKER_TOKEN");
  const port = yield* Config.Int("T3_WORKER_PORT").pipe(Config.withDefault(8083));
  const ideUrl = yield* Config.option(Config.String("T3CODE_SANDBOX_IDE_URL"));
  const cwd = yield* Config.String("T3_WORKSPACE_ROOT").pipe(Config.withDefault("/workspace"));
  const stateDir = yield* Config.String("T3_WORKER_STATE_DIR").pipe(
    Config.withDefault("/workspace/.t3-worker"),
  );
  const identity = {
    workspaceId,
    allocationId,
    generation,
    podUid,
    incarnation: NodeCrypto.randomUUID(),
    protocolVersion: 1 as const,
  };
  const run = Effect.gen(function* () {
    const providers = yield* WorkerProviders.make;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const journal = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        openWorkerJournal(`${stateDir}/worker.jsonl`, { incarnation: identity.incarnation }),
      ),
      (journal) => Effect.promise(journal.close),
    );
    const forwarder = createMcpForwarder(`http://127.0.0.1:${port}`);
    let worker: ExecutionWorker | undefined;
    const executor = yield* makeProviderExecutor({
      adapters: providers.adapters,
      prepareInference: providers.prepareInference,
      normalizeSelection: providers.normalizeSelection,
      configureMcp: (config) => {
        Effect.runSync(mcpSessions.set(forwarder.configure(config)));
        providers.configureCredentialBroker(config.providerInstanceId, () =>
          forwarder.upstreamForProvider(config.providerInstanceId),
        );
      },
      closeMcp: (threadId, instanceId) => {
        forwarder.removeThread(threadId, instanceId);
        const current = Effect.runSync(mcpSessions.read(threadId));
        if (current?.providerInstanceId === instanceId) Effect.runSync(mcpSessions.clear(threadId));
      },
      publish: (sessionId, event) => {
        if (!worker) return Promise.reject(new Error("Worker not initialized"));
        return worker.publish(sessionId, event);
      },
    });
    const workspace = yield* makeWorkspaceExecutor({
      root: cwd,
      incarnation: identity.incarnation,
      canRestore: Effect.succeed(true),
    });
    const git = yield* makeGitDriverExecutor({
      resolve: workspace.resolve,
      publish: (operationId, event) =>
        Effect.promise(() => {
          if (!worker) return Promise.reject(new Error("Worker not initialized"));
          return worker.publish(`git:${operationId}`, event);
        }),
    });
    const assets = yield* makeAssetExecutor;
    const metadata = yield* makeMetadataExecutor({ resolve: workspace.resolve });
    const forks = yield* makeForkExecutor({ resolve: workspace.resolve });
    const terminals = yield* makeTerminalExecutor({
      resolve: workspace.resolve,
      publish: (event) =>
        Effect.promise(() => {
          if (!worker) return Promise.reject(new Error("Worker not initialized"));
          return worker.publish(`terminal:${event.threadId}`, event);
        }),
    });
    const preview = yield* makePreviewExecutor({
      publish: (sessionId, event) => {
        if (!worker) return Promise.reject(new Error("Worker not initialized"));
        return worker.publish(sessionId, event);
      },
    });
    const computer = yield* makeComputerExecutor;
    const usage = yield* makeWorkerUsage;
    const runPromise = yield* captureRunPromise;
    const ideActivity = Option.isSome(ideUrl)
      ? yield* Effect.gen(function* () {
          const pid = yield* Config.Int("T3_IDE_PID");
          return yield* Effect.tryPromise(() =>
            makeIdeActivity(pid, () =>
              runPromise(
                Effect.logWarning("IDE terminal activity is uncertain; retaining sandbox compute"),
              ),
            ),
          );
        })
      : async () => ({ activeOperations: 0, pendingCallbacks: 0 });
    worker = createExecutionWorker({
      identity,
      token,
      journal,
      activity: () =>
        runPromise(
          Effect.gen(function* () {
            const ide = yield* Effect.promise(ideActivity);
            const provider = yield* executor.activity;
            const utility = yield* providers.activity;
            const files = yield* workspace.activity;
            const terminal = yield* terminals.activity;
            const browsing = yield* preview.activity;
            const computing = yield* computer.activity;
            const usageActivity = yield* usage.activity;
            const transferring = yield* assets.activity;
            return {
              activeOperations:
                ide.activeOperations +
                provider.activeOperations +
                utility.activeOperations +
                files.activeOperations +
                terminal.activeOperations +
                browsing.activeOperations +
                computing.activeOperations +
                usageActivity.activeOperations +
                transferring.activeOperations,
              pendingCallbacks: provider.pendingCallbacks + utility.pendingCallbacks,
            };
          }),
        ),
      execute: (method, input) =>
        method.startsWith("usage.")
          ? runPromise(usage.execute(method, input))
          : method === "configureProvider" ||
              method.startsWith("provider.") ||
              method.startsWith("text.") ||
              method.startsWith("auth.")
            ? runPromise(providers.execute(method, input))
            : method.startsWith("git.driver.") ||
                method.startsWith("vcs.driver.") ||
                method === "vcs.process" ||
                method === "vcs.process.probe" ||
                method.startsWith("vcs.temp.")
              ? runPromise(git.execute(method, input))
              : method.startsWith("project.")
                ? runPromise(metadata.execute(method, input))
                : method === "git.bundleFork" ||
                    method === "git.importFork" ||
                    method === "git.cleanupFork"
                  ? runPromise(forks.execute(method, input))
                  : method.startsWith("asset.") || method.startsWith("input.")
                    ? runPromise(assets.execute(method, input))
                    : method.startsWith("computer.")
                      ? runPromise(computer.execute(method, input))
                      : method.startsWith("preview.") || method.startsWith("html.")
                        ? runPromise(preview.execute(method, input))
                        : method.startsWith("terminals.")
                          ? runPromise(terminals.execute(method, input))
                          : /^(workspace|files|git|scripts)\./.test(method)
                            ? runPromise(workspace.execute(method, input))
                            : runPromise(executor.execute(method, input)),
    });
    const handle = worker.handle;
    const acquireLease = worker.acquireLease;
    yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        listenWorker({
          host: "0.0.0.0",
          port,
          ...(Option.isSome(ideUrl)
            ? { ide: { url: ideUrl.value, token, identity, acquireLease } }
            : {}),
          handle: (request) =>
            new URL(request.url).pathname.startsWith("/mcp/")
              ? forwarder.handle(request)
              : handle(request),
        }),
      ),
      (server) => Effect.promise(server.close),
    );
    yield* Effect.logInfo("Execution worker ready", {
      workspaceId,
      allocationId,
      generation,
      podUid,
      port,
    });
    return yield* Effect.never;
  });
  const workspaceLayer = WorkerWorkspaceLayers.layer.pipe(
    Layer.provideMerge(workerLayers({ cwd, stateDir, port })),
  );
  const native = WorkerPreviewLayers.layer.pipe(
    Layer.provideMerge(ServerEnvironment.layer),
    Layer.provideMerge(workspaceLayer),
  );
  return yield* run.pipe(
    Effect.provide(
      ProviderRegistry.layer({ drivers: BUILT_IN_DRIVERS, configMap: {} }).pipe(
        Layer.provideMerge(native),
      ),
    ),
  );
});
NodeRuntime.runMain(program.pipe(Effect.scoped));
