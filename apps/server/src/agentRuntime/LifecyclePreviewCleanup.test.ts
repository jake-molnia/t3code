import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import type { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as ResourceCleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Policy from "./LifecyclePolicy.ts";
import { makePreviewExecutor } from "./worker/PreviewExecutor.ts";

const root = C.ThreadId.make("settled-root");
const child = C.ThreadId.make("unsettled-child");
const at = DateTime.makeUnsafe(1_000);
const decodePreview = Schema.decodeUnknownEffect(C.PreviewSessionSnapshot);
const decodeRequest = Schema.decodeUnknownSync(Schema.Struct({ method: Schema.String }));
const identity = {
  workspaceId: "shared-workspace",
  allocationId: "allocation",
  generation: 1,
  incarnation: "incarnation",
  podUid: "pod",
  protocolVersion: 1,
} satisfies ExecutionIdentity;
const services = Layer.mergeAll(
  PreviewManager.layer,
  Broker.layer,
  Layer.mock(HtmlRender.HtmlRender)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "settled-preview-cleanup-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

function member(id: C.ThreadId, settled: boolean): Policy.LifecycleMember {
  return {
    thread: {
      id,
      status: "completed",
      activeRunId: null,
      activityRunStatus: null,
      pendingBackgroundTasks: [],
      createdAt: at,
      latestUserMessageAt: at,
      latestRunCompletedAt: at,
      settledAt: settled ? at : null,
      settledOverride: settled ? "settled" : null,
    },
    runs: [],
    requests: [],
    subagents: [],
    nativeBackground: false,
    unassignedUserMessages: false,
  };
}

it.layer(services, { excludeTestServices: true })("settled workspace previews", (it) => {
  it.effect.each([
    { settled: true, hasSibling: false },
    { settled: true, hasSibling: true },
    { settled: false, hasSibling: false },
  ])("closes only settled previews: %j", ({ settled, hasSibling }) =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      yield* Effect.addFinalizer(() =>
        Effect.all([manager.close({ threadId: root }), manager.close({ threadId: child })]).pipe(
          Effect.orDie,
        ),
      );
      const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
      const opened = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const runPromise = yield* captureRunPromise;
      const executor = yield* makePreviewExecutor({
        publish: (_session, event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          (event.type === "closed" || event.type === "opened")
            ? runPromise(
                Deferred.succeed(event.type === "closed" ? closed : opened, undefined),
              ).then(() => {})
            : Promise.resolve(),
      }).pipe(
        Effect.provideService(ServerBrowser.ServerBrowser, {
          attachViewer: () => Effect.succeed({ output, input: () => Effect.void }),
          answerFileChooser: () => Effect.succeed(false),
          openDownload: () => Effect.succeedNone,
          clearProfile: () => Effect.void,
          reportProfiles: () => Effect.void,
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
          getDescriptor: Effect.die("unused"),
        }),
      );
      const tab = yield* decodePreview(
        yield* executor.execute("preview.open", { threadId: root, url: "http://localhost:8778" }),
      );
      yield* executor.execute("preview.viewerOpen", {
        threadId: root,
        tabId: tab.tabId,
        maxWidth: 100,
        maxHeight: 100,
        quality: 50,
        canOperate: false,
      });
      yield* Deferred.await(opened);
      if (hasSibling)
        yield* executor.execute("preview.open", {
          threadId: child,
          url: "http://localhost:8779",
        });
      const snapshot: Policy.LifecycleSnapshot = {
        ownerThreadId: root,
        workspaceId: identity.workspaceId,
        revision: 1,
        kind: "thread",
        members: hasSibling
          ? [member(root, settled), member(child, false)]
          : [member(root, settled)],
        pendingEffects: false,
        settleScript: null,
      };
      const client = createExecutionClient({
        endpoint: "http://worker.test",
        token: "test-token",
        identity,
        fetch: async (_url, init) => {
          const request = decodeRequest(JSON.parse(String(init?.body)));
          if (request.method === "terminals.list") return Response.json({ ok: true, value: [] });
          if (request.method === "terminals.closeIdle")
            return Response.json({ ok: true, value: null });
          throw new Error("Unexpected worker method");
        },
      });
      const policy = yield* Policy.makePolicy({
        enabled: true,
        idleMs: 0,
        roots: Effect.succeed([root]),
        recoverSettlements: Effect.void,
        enroll: () => Effect.void,
        retire: () => Effect.void,
        read: () => Effect.succeed(snapshot),
        observe: () => Effect.succeed({ kind: "running", client }),
        resume: () => Effect.die("must not wake compute"),
        collectUsage: () => Effect.void,
        stop: () => Effect.void,
      }).pipe(Effect.provide(ResourceCleanup.layer));
      expect(yield* policy.reconcileThread(root)).toBe(
        settled ? "release-submitted" : "suspend-submitted",
      );
      expect((yield* manager.list({ threadId: root })).sessions).toHaveLength(settled ? 0 : 1);
      if (settled) yield* Deferred.await(closed);
      expect((yield* manager.list({ threadId: child })).sessions).toHaveLength(hasSibling ? 1 : 0);
      expect(yield* executor.activity).toEqual({
        activeOperations: (settled ? 0 : 2) + (hasSibling ? 1 : 0),
        pendingCallbacks: 0,
      });
    }),
  );
});
