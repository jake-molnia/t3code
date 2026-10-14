// @effect-diagnostics globalFetch:off -- The ordering regression drives real HTTP with a controlled input delay.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as P from "./worker/PreviewProtocol.ts";
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
import { createExecutionClient, ExecutionTransportError } from "../execution/ExecutionClient.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";

const decodeAutomation = Schema.decodeUnknownSync(P.Automation);

const layer = Layer.mergeAll(
  PreviewManager.layer,
  Broker.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ServerConfig.layerTest(process.cwd(), { prefix: "remote-preview-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.layer(layer, { excludeTestServices: true })("remote browser transport", (it) => {
  it.effect(
    "preserves viewer input order across delayed HTTP without blocking dialog or another viewer",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-input-order-" });
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(path.join(root, "journal"))),
          (value) => Effect.promise(value.close),
        );
        const identity = {
          workspaceId: "ordering",
          allocationId: "one",
          generation: 1,
          incarnation: "one",
          podUid: "one",
          protocolVersion: 1,
        } as const;
        const token = "ordering-token-longer-than-thirty-two-characters";
        const received: Array<{ viewerId: string; type: string }> = [];
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const closeEntered = yield* Deferred.make<void>();
        const closeRelease = yield* Deferred.make<void>();
        let viewerNumber = 0;
        let hungCloseAborted = false;
        const worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: async (method, input) => {
            if (method === "preview.viewerOpen") return { viewerId: String(++viewerNumber) };
            if (method === "preview.viewerPoll") return { sequence: 0, items: [] };
            if (method === "preview.viewerInput") {
              const value = Schema.decodeUnknownSync(
                Schema.Struct({
                  viewerId: Schema.String,
                  message: Schema.Struct({
                    type: Schema.String,
                    action: Schema.optional(Schema.String),
                  }),
                }),
              )(input);
              received.push({
                viewerId: value.viewerId,
                type:
                  value.message.type === "key" ? `key:${value.message.action}` : value.message.type,
              });
            }
            return null;
          },
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(value.close),
        );
        const run = yield* captureRunPromise;
        const client = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
          fetch: async (url, init) => {
            const operation = Schema.decodeUnknownSync(
              Schema.Struct({
                method: Schema.optional(Schema.String),
                input: Schema.optional(Schema.Unknown),
              }),
            )(JSON.parse(String(init?.body ?? "{}")));
            if (
              operation.method === "preview.viewerClose" &&
              Schema.decodeUnknownSync(P.ViewerRef)(operation.input).viewerId === "1"
            ) {
              const signal = init?.signal;
              if (!signal) throw new Error("Close request requires cancellation signal");
              return new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                  hungCloseAborted = true;
                  reject(new Error("aborted owned close"));
                };
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              });
            }
            if (operation.method === "preview.viewerInput") {
              const value = Schema.decodeUnknownSync(
                Schema.Struct({
                  viewerId: Schema.String,
                  message: Schema.Struct({
                    type: Schema.String,
                    action: Schema.optional(Schema.String),
                  }),
                }),
              )(operation.input);
              if (value.viewerId === "1" && value.message.type === "text") {
                await run(Deferred.succeed(entered, undefined));
                await run(Deferred.await(release));
              }
              if (value.viewerId === "1" && value.message.type === "blocked") {
                await run(Deferred.succeed(closeEntered, undefined));
                await run(Deferred.await(closeRelease));
              }
            }
            return fetch(url, init);
          },
        });
        const browser = yield* ServerBrowser.ServerBrowser.pipe(
          Effect.provide(
            RemotePreview.browserLayer.pipe(
              Layer.provide(
                Layer.mock(RuntimeClient.RuntimeClient, {
                  enabled: true,
                  observeThread: () => Effect.succeed({ kind: "running", client }),
                }),
              ),
            ),
          ),
        );
        const scope = yield* Scope.fork(yield* Effect.scope);
        const first = yield* browser
          .attachViewer({
            threadId: "thread",
            tabId: "first",
            maxWidth: 100,
            maxHeight: 100,
            quality: 50,
            canOperate: true,
          })
          .pipe(Effect.provideService(Scope.Scope, scope));
        const second = yield* browser.attachViewer({
          threadId: "thread",
          tabId: "second",
          maxWidth: 100,
          maxHeight: 100,
          quality: 50,
          canOperate: true,
        });
        const text = yield* first
          .input({ type: "text", text: "new value" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const keyDown = yield* first
          .input({ type: "key", action: "down", key: "Enter" })
          .pipe(Effect.forkScoped);
        const keyUp = yield* first
          .input({ type: "key", action: "up", key: "Enter" })
          .pipe(Effect.forkScoped);
        const click = yield* first.input({ type: "mouse", action: "down" }).pipe(Effect.forkScoped);
        yield* second.input({ type: "key", key: "x", action: "down" });
        yield* first.input({ type: "dialog", accept: true });
        yield* first.input({ type: "takeControl" });
        yield* first.input({ type: "releaseControl" });
        expect(received).not.toContainEqual({ viewerId: "1", type: "mouse" });
        expect(received).toContainEqual({ viewerId: "2", type: "key:down" });
        expect(received).toContainEqual({ viewerId: "1", type: "dialog" });
        expect(received).toContainEqual({ viewerId: "1", type: "takeControl" });
        expect(received).toContainEqual({ viewerId: "1", type: "releaseControl" });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(text);
        yield* Fiber.join(keyDown);
        yield* Fiber.join(keyUp);
        yield* Fiber.join(click);
        expect(
          received
            .filter(
              (entry) =>
                entry.viewerId === "1" &&
                !["dialog", "takeControl", "releaseControl"].includes(entry.type),
            )
            .map((entry) => entry.type),
        ).toEqual(["text", "key:down", "key:up", "mouse"]);
        const beforeClose = received.length;
        const blocked = yield* first.input({ type: "blocked" }).pipe(Effect.forkScoped);
        yield* Deferred.await(closeEntered);
        const queued = yield* first
          .input({ type: "text", text: "must not arrive" })
          .pipe(Effect.forkScoped);
        const closingAt = yield* Clock.currentTimeMillis;
        yield* Scope.close(scope, Exit.void);
        expect((yield* Clock.currentTimeMillis) - closingAt).toBeLessThan(3_000);
        expect(hungCloseAborted).toBe(true);
        expect((yield* Fiber.await(blocked))._tag).toBe("Failure");
        expect((yield* Fiber.await(queued))._tag).toBe("Failure");
        expect((yield* first.input({ type: "mouse", action: "up" }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        yield* Deferred.succeed(closeRelease, undefined);
        yield* second.input({ type: "dialog", accept: true });
        expect(received.slice(beforeClose)).toEqual([{ viewerId: "2", type: "dialog" }]);
      }),
  );
  it.effect(
    "bridges real HTTP frames without journaling them and routes automation to the worker broker",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-worker-" });
        const frames = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({ capacity: 16 });
        let acked = 0;
        let pollObservation:
          | { started: Deferred.Deferred<void>; finished: Deferred.Deferred<void> }
          | undefined;
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
          execute: async (method, input) => {
            const observing = method === "preview.viewerPoll" ? pollObservation : undefined;
            if (observing) await runPromise(Deferred.succeed(observing.started, undefined));
            try {
              return await runPromise(executor.execute(method, input));
            } finally {
              if (observing) await runPromise(Deferred.succeed(observing.finished, undefined));
            }
          },
          activity: () => runPromise(executor.activity),
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(() => value.close()),
        );
        const liveClient = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
        });
        const twoHeartbeats = yield* Deferred.make<void>();
        let heartbeats = 0;
        let dropBatch = true;
        let fatalPoll: "authorization" | "identity_changed" | undefined;
        const pollCursors: number[] = [];
        const client: typeof liveClient = {
          ...liveClient,
          transient: async (method, input) => {
            if (method !== "preview.viewerPoll") return liveClient.transient(method, input);
            if (fatalPoll) throw new ExecutionTransportError(fatalPoll);
            const poll = Schema.decodeUnknownSync(P.ViewerPoll)(input);
            pollCursors.push(poll.afterSequence);
            const raw = await liveClient.transient(method, input);
            const batch = Schema.decodeUnknownSync(P.ViewerBatch)(raw);
            if (batch.items.length > 0 && dropBatch) {
              dropBatch = false;
              throw new ExecutionTransportError("timeout");
            }
            if (batch.items.length === 0 && ++heartbeats === 2)
              await runPromise(Deferred.succeed(twoHeartbeats, undefined));
            return raw;
          },
        };
        const runtime = RuntimeClient.RuntimeClient.of({
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
        const viewerScope = yield* Scope.fork(yield* Effect.scope);
        const viewer = yield* remoteBrowser
          .attachViewer({
            threadId: "thread",
            tabId: tab.tabId,
            maxWidth: 100,
            maxHeight: 100,
            quality: 50,
            canOperate: true,
          })
          .pipe(Effect.provideService(Scope.Scope, viewerScope));
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
        expect(pollCursors.slice(0, 2)).toEqual([0, 0]);
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
        // Two production 20-second idle heartbeats outlast the original 30-second failure.
        yield* Deferred.await(twoHeartbeats).pipe(Effect.timeout("45 seconds"));
        expect(yield* Queue.size(viewer.output)).toBe(0);
        const control = {
          _tag: "control" as const,
          canOperate: true,
          controller: "you" as const,
          generation: 2,
          dialog: null,
        };
        yield* Queue.offer(frames, control);
        expect(yield* Queue.take(viewer.output).pipe(Effect.timeout("5 seconds"))).toEqual(control);
        yield* Queue.offer(frames, {
          _tag: "frame",
          data: new Uint8Array([7, 8]),
          ack: Effect.sync(() => {
            acked++;
          }),
        });
        const resumed = yield* Queue.take(viewer.output).pipe(Effect.timeout("5 seconds"));
        if (resumed._tag !== "frame") return yield* Effect.die("expected resumed frame");
        expect(resumed.data).toEqual(new Uint8Array([7, 8]));
        yield* resumed.ack;
        expect(acked).toBe(2);
        yield* remoteManager.close({ threadId: C.ThreadId.make("thread"), tabId: tab.tabId });
        expect(yield* Queue.take(viewer.output).pipe(Effect.timeout("5 seconds"))).toEqual({
          _tag: "gone",
        });
        yield* Scope.close(viewerScope, Exit.void);
        for (const failure of ["authorization", "identity_changed"] as const) {
          fatalPoll = failure;
          const scope = yield* Scope.fork(yield* Effect.scope);
          const terminalTab = yield* remoteManager.open({
            threadId: C.ThreadId.make("thread"),
            url: "http://localhost:3000",
            runtime: "server",
          });
          const denied = yield* remoteBrowser
            .attachViewer({
              threadId: "thread",
              tabId: terminalTab.tabId,
              maxWidth: 100,
              maxHeight: 100,
              quality: 50,
              canOperate: true,
            })
            .pipe(Effect.provideService(Scope.Scope, scope));
          expect(yield* Queue.take(denied.output).pipe(Effect.timeout("5 seconds"))).toEqual({
            _tag: "gone",
          });
          yield* Scope.close(scope, Exit.void);
          yield* remoteManager.close({
            threadId: C.ThreadId.make("thread"),
            tabId: terminalTab.tabId,
          });
        }
        fatalPoll = undefined;
        const finalTab = yield* remoteManager.open({
          threadId: C.ThreadId.make("thread"),
          url: "http://localhost:3000",
          runtime: "server",
        });
        const finalScope = yield* Scope.fork(yield* Effect.scope);
        const finalViewer = yield* remoteBrowser
          .attachViewer({
            threadId: "thread",
            tabId: finalTab.tabId,
            maxWidth: 100,
            maxHeight: 100,
            quality: 50,
            canOperate: true,
          })
          .pipe(Effect.provideService(Scope.Scope, finalScope));
        for (let generation = 1; generation <= 12; generation++)
          yield* Queue.offer(frames, { ...control, generation });
        const controls = yield* Effect.forEach(Array.from({ length: 12 }), () =>
          Queue.take(finalViewer.output),
        ).pipe(Effect.timeout("5 seconds"));
        expect(controls.map((item) => (item._tag === "control" ? item.generation : null))).toEqual(
          Array.from({ length: 12 }, (_, i) => i + 1),
        );
        pollObservation = {
          started: yield* Deferred.make<void>(),
          finished: yield* Deferred.make<void>(),
        };
        yield* Deferred.await(pollObservation.started).pipe(Effect.timeout("5 seconds"));
        yield* Scope.close(finalScope, Exit.void).pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(pollObservation.finished).pipe(Effect.timeout("5 seconds"));
        expect((yield* executor.activity).activeOperations).toBe(1);
        yield* remoteManager.close({ threadId: C.ThreadId.make("thread"), tabId: finalTab.tabId });
      }),
    { timeout: 60_000 },
  );
});

it.effect("reconnects automation after a timed-out request without replaying its action", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const run = yield* captureRunPromise;
    const operations: string[] = [];
    const client = {
      ...createExecutionClient({
        endpoint: "http://worker.test",
        token: "test-token",
        identity: {
          workspaceId: "workspace",
          allocationId: "one",
          generation: 1,
          incarnation: "one",
          podUid: "one",
          protocolVersion: 1,
        },
      }),
      call: async (_method: string, input: unknown) => {
        const { request } = decodeAutomation(input);
        operations.push(request.operation);
        if (request.operation === "click") {
          await run(Deferred.succeed(sent, undefined));
          await run(Deferred.await(release));
        }
        return request.tabId === "missing"
          ? {
              ok: false,
              error: { _tag: "PreviewAutomationTabNotFoundError", message: "Missing tab" },
            }
          : { ok: true, result: { available: true } };
      },
    };
    const context = yield* Layer.build(RemotePreview.brokerLayer).pipe(
      Effect.provide(
        Layer.mock(RuntimeClient.RuntimeClient)({
          enabled: true,
          forThread: () => Effect.succeed(client),
          observeThread: () => Effect.succeed({ kind: "stopped" }),
        }),
      ),
    );
    const broker = Context.get(context, Broker.PreviewAutomationBroker);
    const scope = {
      environmentId: C.EnvironmentId.make("central-env"),
      capabilities: new Set(["preview"] as const),
      issuedAt: 0,
      requestNamespace: "test",
      client: undefined,
      thread: {
        threadId: C.ThreadId.make("thread"),
        providerSessionId: "session",
        providerInstanceId: C.ProviderInstanceId.make("codex"),
      },
    };
    const action = yield* broker
      .invoke<void>({ scope, operation: "click", input: {}, timeoutMs: 1 })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(sent);
    yield* TestClock.adjust("1001 millis");
    expect((yield* Fiber.join(action))._tag).toBe("PreviewAutomationTimeoutError");
    expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toEqual({
      available: true,
    });
    expect(
      (yield* broker
        .invoke<void>({
          scope,
          operation: "snapshot",
          input: {},
          tabId: C.PreviewTabId.make("missing"),
        })
        .pipe(Effect.flip))._tag,
    ).toBe("PreviewAutomationTabNotFoundError");
    expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
      available: true,
    });
    yield* Deferred.succeed(release, undefined);
    expect(operations).toEqual(["click", "status", "snapshot", "open"]);
  }).pipe(Effect.provide(layer)),
);
