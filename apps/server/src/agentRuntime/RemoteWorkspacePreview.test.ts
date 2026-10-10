import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as RemotePreview from "./RemoteWorkspacePreview.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import { makePreviewExecutor } from "./worker/PreviewExecutor.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";

const layer = Layer.mergeAll(
  PreviewManager.layer,
  Broker.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ServerConfig.layerTest(process.cwd(), { prefix: "remote-preview-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.layer(layer, { excludeTestServices: true })("remote browser transport", (it) => {
  it.effect(
    "bridges real HTTP frames without journaling them and routes automation to the worker broker",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-worker-" });
        const frames = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({ capacity: 16 });
        let acked = 0;
        const profiles: C.PreviewReportProfilesInput[] = [];
        const manager = yield* PreviewManager.PreviewManager;
        const nativeBroker = yield* Broker.PreviewAutomationBroker;
        const browser = ServerBrowser.ServerBrowser.of({
          attachViewer: () => Effect.succeed({ output: frames, input: () => Effect.void }),
          answerFileChooser: () => Effect.succeed(true),
          openDownload: () => Effect.succeed(Option.none()),
          clearProfile: () => Effect.void,
          reportProfiles: (input) =>
            Effect.sync(() => {
              profiles.push(input);
            }),
        });
        const hostReady = yield* Deferred.make<void>();
        const host = yield* nativeBroker.connect(
          {
            clientId: C.SERVER_BROWSER_AUTOMATION_CLIENT_ID,
            environmentId: C.EnvironmentId.make("worker-env"),
            supportedOperations: [...C.PREVIEW_AUTOMATION_SERVER_OPERATIONS],
          },
          { preferred: true },
        );
        yield* host.pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(hostReady, undefined).pipe(Effect.asVoid)
              : nativeBroker.respond({
                  clientId: C.SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                  connectionId: event.connectionId,
                  requestId: event.request.requestId,
                  ok: true,
                  result: { workerThread: event.request.threadId },
                }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(hostReady);
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(path.join(root, "journal.jsonl"))),
          (value) => Effect.promise(() => value.close()),
        );
        let worker: ReturnType<typeof createExecutionWorker> | undefined;
        const runPromise = yield* captureRunPromise;
        const executor = yield* makePreviewExecutor({
          publish: (sessionId, event) =>
            worker
              ? worker.publish(sessionId, event)
              : Promise.reject(new Error("worker not ready")),
        }).pipe(
          Effect.provideService(ServerBrowser.ServerBrowser, browser),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
            getDescriptor: Effect.die("unused descriptor"),
          }),
          Effect.provideService(HtmlRender.HtmlRender, {
            prepare: (html) => Effect.succeed(html),
            preview: () => Effect.die("not launching a browser"),
            publish: () => Effect.die("unused publication"),
          }),
        );
        const identity = {
          workspaceId: "preview-workspace",
          allocationId: "1",
          generation: 1,
          incarnation: "one",
          podUid: "pod",
          protocolVersion: 1,
        } satisfies Parameters<typeof createExecutionWorker>[0]["identity"];
        const token = "preview-worker-test-more-than-thirty-two-characters";
        worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: (method, input) => runPromise(executor.execute(method, input)),
          activity: () => runPromise(executor.activity),
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(() => value.close()),
        );
        const client = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
        });
        const runtime = RuntimeClient.RuntimeClient.of({
          ideOrigin: () => Effect.die("IDE origin is not used by this test"),
          enabled: true,
          forThread: () => Effect.succeed(client),
          forWorkspace: () => Effect.succeed(client),
          forUtility: () => Effect.succeed(client),
          observeThread: () => Effect.succeed({ kind: "running", client }),
          observeWorkspace: () => Effect.succeed({ kind: "running", client }),
          sessionResidency: () => Effect.succeed(identity),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        const remoteContext = yield* Layer.build(
          Layer.mergeAll(
            RemotePreview.managerLayer,
            RemotePreview.browserLayer,
            RemotePreview.brokerLayer,
          ),
        ).pipe(Effect.provideService(RuntimeClient.RuntimeClient, runtime));
        const remoteManager = Context.get(remoteContext, PreviewManager.PreviewManager);
        const remoteBrowser = Context.get(remoteContext, ServerBrowser.ServerBrowser);
        const remoteBroker = Context.get(remoteContext, Broker.PreviewAutomationBroker);
        yield* remoteBrowser.reportProfiles({ profiles: [], defaultProfileId: "incognito" });
        expect(profiles).toHaveLength(0);
        const tab = yield* remoteManager.open({
          threadId: C.ThreadId.make("thread"),
          url: "http://localhost:3000",
          runtime: "desktop",
        });
        expect(
          (yield* manager.list({ threadId: C.ThreadId.make("thread") })).sessions[0]?.runtime,
        ).toBe("server");
        expect(profiles).toEqual([{ profiles: [], defaultProfileId: "incognito" }]);
        yield* remoteBrowser.reportProfiles({ profiles: [], defaultProfileId: "default" });
        expect(profiles).toHaveLength(2);
        const viewer = yield* remoteBrowser.attachViewer({
          threadId: "thread",
          tabId: tab.tabId,
          maxWidth: 100,
          maxHeight: 100,
          quality: 50,
          canOperate: true,
        });
        const before = journal.operations.size;
        yield* Queue.offer(frames, {
          _tag: "frame",
          data: new Uint8Array([4, 5, 6]),
          ack: Effect.sync(() => {
            acked++;
          }),
        });
        const frame = yield* Queue.take(viewer.output).pipe(Effect.timeout("5 seconds"));
        if (frame._tag !== "frame") return yield* Effect.die("expected frame");
        expect(frame.data).toEqual(new Uint8Array([4, 5, 6]));
        expect(acked).toBe(0);
        yield* frame.ack;
        expect(acked).toBe(1);
        expect(journal.operations.size).toBe(before);
        yield* Queue.offer(frames, { _tag: "popup", tabId: "popup-tab" });
        expect(yield* Queue.take(viewer.output).pipe(Effect.timeout("5 seconds"))).toEqual({
          _tag: "popup",
          tabId: "popup-tab",
        });
        const result = yield* remoteBroker.invoke({
          scope: {
            environmentId: C.EnvironmentId.make("central-env"),
            capabilities: new Set(["preview"]),
            issuedAt: 0,
            requestNamespace: "test",
            thread: {
              threadId: C.ThreadId.make("thread"),
              providerSessionId: "provider-session",
              providerInstanceId: C.ProviderInstanceId.make("codex"),
            },
            client: undefined,
          },
          operation: "status",
          input: {},
          timeoutMs: 5000,
        });
        expect(result).toEqual({ workerThread: "thread" });
      }),
  );
});
