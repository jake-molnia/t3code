import * as PreviewRecording from "./PreviewRecording.ts";
import { ExecutionTransportError } from "../execution/ExecutionClient.ts";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as C from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as P from "./worker/PreviewProtocol.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";

const isPreviewAutomationError = Schema.is(C.PreviewAutomationError);

class RemotePreview extends Context.Service<
  RemotePreview,
  {
    manager: PreviewManager.PreviewManager["Service"];
    browser: ServerBrowser.ServerBrowser["Service"];
    broker: Broker.PreviewAutomationBroker["Service"];
  }
>()("t3/agentRuntime/RemoteWorkspacePreview/RemotePreview") {}

const layerCore = Layer.effect(
  RemotePreview,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const scope = yield* Effect.scope;
    const recordingServices = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >();
    const epoch = yield* crypto.randomUUIDv4;
    let revision = 0;
    const events = yield* PubSub.unbounded<C.PreviewEvent>();
    const watchers = new Set<string>();
    const sessions = new Map<string, C.PreviewSessionSnapshot>();
    const profileLock = yield* Semaphore.make(1);
    let reportedProfiles: C.PreviewReportProfilesInput | undefined;
    let profileRevision = 0;
    const profileVersions = new Map<string, { incarnation: string; revision: number }>();
    const syncProfiles = (client: ExecutionClient) =>
      Effect.gen(function* () {
        const input = reportedProfiles;
        if (input === undefined) return;
        const key = client.identity.workspaceId;
        const previous = profileVersions.get(key);
        if (
          previous?.incarnation === client.identity.incarnation &&
          previous.revision === profileRevision
        )
          return;
        yield* Effect.tryPromise(() => client.call("preview.reportProfiles", input));
        profileVersions.delete(key);
        profileVersions.set(key, {
          incarnation: client.identity.incarnation,
          revision: profileRevision,
        });
        if (profileVersions.size > 256) {
          const oldest = profileVersions.keys().next().value;
          if (oldest !== undefined) profileVersions.delete(oldest);
        }
      });
    const identityKey = (threadId: string, tabId: string) => `${threadId}\0${tabId}`;
    const publish = (event: C.PreviewEvent) =>
      Effect.gen(function* () {
        const key = identityKey(event.threadId, event.tabId);
        if (event.type === "closed") sessions.delete(key);
        else if ("snapshot" in event) sessions.set(key, event.snapshot);
        yield* PubSub.publish(events, { ...event, serverEpoch: epoch, revision: ++revision });
      });
    const watch = (threadId: string) =>
      Effect.gen(function* () {
        if (watchers.has(threadId)) return;
        watchers.add(threadId);
        yield* Effect.gen(function* () {
          let cursor = 0;
          let sourceRevision = 0;
          let incarnation: string | undefined;
          let disconnected = false;
          const closeKnown = Effect.gen(function* () {
            for (const snapshot of Array.from(sessions.values()))
              if (snapshot.threadId === threadId)
                yield* publish({
                  type: "closed",
                  threadId,
                  tabId: snapshot.tabId,
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                  serverEpoch: epoch,
                  revision: revision + 1,
                });
          });
          while (true) {
            const keepWatching = yield* Effect.gen(function* () {
              const current = yield* runtime.observeThread(C.ThreadId.make(threadId));
              if (current.kind === "stopped") {
                yield* closeKnown;
                return false;
              }
              if (incarnation !== current.client.identity.incarnation) {
                if (incarnation !== undefined) yield* closeKnown;
                const snapshot = yield* Effect.tryPromise(() =>
                  current.client.call("preview.list", { threadId }),
                ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(C.PreviewListResult)));
                incarnation = current.client.identity.incarnation;
                cursor = 0;
                sourceRevision = snapshot.revision;
                for (const session of snapshot.sessions)
                  yield* publish({
                    type: "opened",
                    threadId,
                    tabId: session.tabId,
                    snapshot: session,
                    createdAt: session.updatedAt,
                    serverEpoch: epoch,
                    revision: revision + 1,
                  });
              }
              const batch = yield* Effect.tryPromise((signal) =>
                current.client.events(cursor, signal, `preview:${threadId}`),
              );
              for (const envelope of batch) {
                if (envelope.identity.incarnation === incarnation) {
                  const event = yield* Schema.decodeUnknownEffect(C.PreviewEvent)(envelope.event);
                  if (event.threadId !== threadId)
                    return yield* Effect.die("Preview thread identity mismatch");
                  if (event.revision > sourceRevision) {
                    yield* publish(event);
                    sourceRevision = event.revision;
                  }
                }
                cursor = Math.max(cursor, envelope.sequence);
              }
              if (cursor > 0)
                yield* Effect.tryPromise(() => current.client.ack(`preview:${threadId}`, cursor));
              disconnected = false;
              return Array.from(sessions.values()).some((session) => session.threadId === threadId);
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.gen(function* () {
                      if (!disconnected)
                        yield* Effect.logWarning("Remote preview observation disconnected", {
                          threadId,
                          cause,
                        });
                      disconnected = true;
                      return true;
                    }),
              ),
            );
            if (!keepWatching) return;
            yield* Effect.sleep(disconnected ? "1 second" : "100 millis");
          }
        }).pipe(
          Effect.ensuring(Effect.sync(() => watchers.delete(threadId))),
          Effect.forkIn(scope),
        );
      });
    const clientFor = (threadId: string, wake: boolean) =>
      Effect.gen(function* () {
        if (wake) return yield* runtime.forThread(C.ThreadId.make(threadId));
        const current = yield* runtime.observeThread(C.ThreadId.make(threadId));
        if (current.kind === "stopped")
          return yield* new C.PreviewSessionLookupError({ threadId, tabId: "unavailable" });
        return current.client;
      }).pipe(Effect.tap((client) => profileLock.withPermits(1)(syncProfiles(client))));
    const invoke = <A, I>(
      method: string,
      input: { threadId: string; tabId?: string | undefined } & Readonly<Record<string, unknown>>,
      schema: Schema.Codec<A, I>,
      wake = false,
    ) =>
      Effect.gen(function* () {
        const client = yield* clientFor(input.threadId, wake);
        const result = yield* Effect.tryPromise(() => client.call(method, input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
        );
        yield* watch(input.threadId);
        return result;
      }).pipe(
        Effect.mapError(
          () =>
            new C.PreviewSessionLookupError({
              threadId: input.threadId,
              tabId: input.tabId ?? "unavailable",
            }),
        ),
      );
    const manager = PreviewManager.PreviewManager.of({
      open: (input) =>
        invoke(
          "preview.open",
          { ...input, runtime: "server" },
          C.PreviewSessionSnapshot,
          true,
        ).pipe(Effect.tap((snapshot) => Effect.sync(() => input.beforePublish?.(snapshot)))),
      navigate: (input) => invoke("preview.navigate", input, C.PreviewSessionSnapshot),
      resize: (input) => invoke("preview.resize", input, C.PreviewSessionSnapshot),
      adjust: (input) => invoke("preview.adjust", input, C.PreviewSessionSnapshot),
      reportStatus: (input) =>
        invoke("preview.reportStatus", input, Schema.Null).pipe(Effect.asVoid),
      requestReveal: (input) => invoke("preview.reveal", input, Schema.Null).pipe(Effect.asVoid),
      refresh: (input) => invoke("preview.refresh", input, Schema.Null).pipe(Effect.asVoid),
      close: (input) => invoke("preview.close", input, Schema.Null).pipe(Effect.asVoid),
      list: (input) =>
        Effect.gen(function* () {
          const current = yield* runtime.observeThread(input.threadId);
          if (current.kind === "stopped") return { sessions: [], serverEpoch: epoch, revision };
          const result = yield* Effect.tryPromise(() =>
            current.client.call("preview.list", input),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(C.PreviewListResult)));
          for (const snapshot of result.sessions)
            sessions.set(identityKey(input.threadId, snapshot.tabId), snapshot);
          yield* watch(input.threadId);
          return { ...result, serverEpoch: epoch, revision };
        }).pipe(Effect.orDie),
      events: Stream.fromPubSub(events),
      subscribeEvents: PubSub.subscribe(events),
    });
    const browser = ServerBrowser.ServerBrowser.of({
      reportProfiles: (input) =>
        profileLock.withPermits(1)(
          Effect.gen(function* () {
            reportedProfiles = input;
            profileRevision++;
            for (const workspaceId of Array.from(profileVersions.keys())) {
              yield* runtime.observeWorkspace(workspaceId).pipe(
                Effect.flatMap((current) =>
                  current.kind === "running" ? syncProfiles(current.client) : Effect.void,
                ),
                Effect.ignoreCause({ log: true }),
              );
            }
          }),
        ),
      attachViewer: (input) =>
        Effect.gen(function* () {
          const client = yield* clientFor(input.threadId, false);
          const opened = yield* Effect.tryPromise(() =>
            client.call("preview.viewerOpen", input),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(P.ViewerRef)));
          // Worker close gives pending frame ACKs one second; bound the whole remote request too.
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise((signal) =>
              client.call("preview.viewerClose", opened, undefined, signal),
            ).pipe(Effect.interruptible, Effect.timeout("2 seconds"), Effect.ignore),
          );
          const inputLock = yield* Semaphore.make(1);
          const inputClosed = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(inputClosed, undefined));
          const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({
            capacity: 8,
          });
          yield* Effect.gen(function* () {
            let afterSequence = 0;
            while (true) {
              const batch = yield* Effect.tryPromise({
                try: (signal) =>
                  client.transient("preview.viewerPoll", { ...opened, afterSequence }, signal),
                catch: (cause) =>
                  cause instanceof ExecutionTransportError
                    ? cause
                    : new ServerBrowser.ServerBrowserLaunchError({ cause }),
              }).pipe(
                Effect.retry({
                  while: (cause) =>
                    cause instanceof ExecutionTransportError &&
                    (cause.code === "timeout" || cause.code === "unavailable"),
                  schedule: Schedule.spaced("1 second"),
                }),
                Effect.flatMap(Schema.decodeUnknownEffect(P.ViewerBatch)),
              );
              if (batch.sequence !== afterSequence + (batch.items.length > 0 ? 1 : 0))
                return yield* new ServerBrowser.ServerBrowserLaunchError({
                  cause: "Invalid preview stream sequence",
                });
              for (const item of batch.items) {
                if (item._tag === "frame") {
                  const ack = Effect.tryPromise(() =>
                    client.transient("preview.viewerAck", { ...opened, ackId: item.ackId }),
                  ).pipe(Effect.asVoid, Effect.ignore);
                  const data = yield* Effect.fromResult(Base64.decode(item.data));
                  if (!(yield* Queue.offer(output, { _tag: "frame", data, ack }))) {
                    yield* ack;
                    return yield* Effect.interrupt;
                  }
                } else if (!(yield* Queue.offer(output, item))) return yield* Effect.interrupt;
              }
              afterSequence = batch.sequence;
              yield* Effect.sleep("30 millis");
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Queue.offer(output, { _tag: "gone" }),
            ),
            Effect.forkScoped,
          );
          return {
            output,
            input: (message: unknown) => {
              const send = Effect.gen(function* () {
                if (yield* Deferred.isDone(inputClosed)) return yield* Effect.interrupt;
                yield* Effect.tryPromise((signal) =>
                  client.transient("preview.viewerInput", { ...opened, message }, signal),
                ).pipe(Effect.asVoid, Effect.ignore);
              });
              // Dialog replies and control changes must unblock an action waiting on the page.
              const bypass =
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                (message.type === "dialog" ||
                  message.type === "takeControl" ||
                  message.type === "releaseControl");
              return Effect.raceFirst(
                bypass ? send : inputLock.withPermits(1)(send),
                Deferred.await(inputClosed).pipe(Effect.andThen(Effect.interrupt)),
              );
            },
          };
        }).pipe(Effect.mapError((cause) => new ServerBrowser.ServerBrowserLaunchError({ cause }))),
      answerFileChooser: (input) =>
        Effect.gen(function* () {
          const client = yield* clientFor(input.threadId, false);
          return yield* Effect.tryPromise(() =>
            client.call("preview.answerFileChooser", {
              ...input,
              files: input.files.map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                data: file.buffer.toString("base64"),
              })),
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)));
        }).pipe(Effect.orDie),
      openDownload: (input) =>
        Effect.gen(function* () {
          const hash = yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(`${input.threadId}\0${input.tabId}\0${input.downloadId}`),
          );
          const filename = Array.from(hash)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const directory = path.join(config.attachmentsDir, "preview-downloads");
          const destination = path.join(directory, filename);
          const metadata = `${destination}.json`;
          if ((yield* fs.exists(destination)) && (yield* fs.exists(metadata))) {
            const saved = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ fileName: Schema.String })),
            )(yield* fs.readFileString(metadata));
            return Option.some({ path: destination, fileName: saved.fileName });
          }
          const current = yield* runtime.observeThread(C.ThreadId.make(input.threadId));
          if (current.kind === "stopped") return Option.none();
          const result = yield* Effect.tryPromise(() =>
            current.client.call("preview.download", input),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(P.DownloadResult)));
          if (result === null) return Option.none();
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFile(destination, yield* Effect.fromResult(Base64.decode(result.data)));
          yield* fs.writeFileString(
            metadata,
            yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Struct({ fileName: Schema.String })),
            )({ fileName: result.fileName }),
          );
          return Option.some({ path: destination, fileName: result.fileName });
        }).pipe(Effect.orDie),
      clearProfile: (profileId) => {
        if (profileId === C.DEFAULT_BROWSER_PROFILE_ID) {
          return Effect.fail(
            new C.PreviewClearProfileError({
              profileId,
              cause: new Error("The sandbox runtime owns the desktop browser profile."),
            }),
          );
        }
        if (profileId === C.INCOGNITO_BROWSER_PROFILE_ID) return Effect.void;
        return Effect.gen(function* () {
          const rows = yield* sql<{
            workspace_id: string;
          }>`SELECT workspace_id FROM agent_runtime_workspaces`;
          for (const row of rows) {
            const client = yield* runtime.forWorkspace(row.workspace_id);
            yield* Effect.tryPromise(() => client.call("preview.clearProfile", { profileId }));
          }
        }).pipe(Effect.mapError((cause) => new C.PreviewClearProfileError({ profileId, cause })));
      },
    });
    const bridges = new Map<
      string,
      { incarnation: string; broker: Broker.PreviewAutomationBroker["Service"] }
    >();
    const bridgeFor = (client: ExecutionClient, environmentId: C.EnvironmentId) =>
      Effect.gen(function* () {
        const prior = bridges.get(client.identity.workspaceId);
        if (prior?.incarnation === client.identity.incarnation) return prior.broker;
        const broker = yield* Broker.make.pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, scope),
        );
        const ready = yield* Deferred.make<void>();
        const stream = yield* broker.connect(
          {
            clientId: C.SERVER_BROWSER_AUTOMATION_CLIENT_ID,
            environmentId,
            supportedOperations: [...C.PREVIEW_AUTOMATION_SERVER_OPERATIONS],
          },
          { preferred: true },
        );
        yield* stream.pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
              : Effect.gen(function* () {
                  const outcome = yield* Effect.tryPromise(() =>
                    client.call("preview.automation", { request: event.request }),
                  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(P.AutomationOutcome)));
                  const retained =
                    outcome.ok && event.request.operation === "recordingStop"
                      ? {
                          ...outcome,
                          result: yield* PreviewRecording.retain(
                            client,
                            event.request.threadId,
                            outcome.result,
                          ).pipe(Effect.provide(recordingServices)),
                        }
                      : outcome;
                  yield* broker.respond({
                    clientId: C.SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                    connectionId: event.connectionId,
                    requestId: event.request.requestId,
                    ...retained,
                  });
                }).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning("Remote preview automation failed", { cause }).pipe(
                          Effect.andThen(
                            broker.respond({
                              clientId: C.SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                              connectionId: event.connectionId,
                              requestId: event.request.requestId,
                              ok: false,
                              error: {
                                _tag: "PreviewAutomationExecutionError",
                                message: "Sandbox browser operation failed.",
                              },
                            }),
                          ),
                        ),
                  ),
                  Effect.forkScoped,
                  Effect.asVoid,
                ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (bridges.get(client.identity.workspaceId)?.broker === broker)
                bridges.delete(client.identity.workspaceId);
            }),
          ),
          Effect.provideService(Scope.Scope, scope),
          Effect.forkIn(scope),
        );
        yield* Deferred.await(ready);
        bridges.set(client.identity.workspaceId, {
          incarnation: client.identity.incarnation,
          broker,
        });
        return broker;
      });
    const unusedHosts = yield* Broker.make;
    const broker = Broker.PreviewAutomationBroker.of({
      connect: unusedHosts.connect,
      focusHost: unusedHosts.focusHost,
      respond: unusedHosts.respond,
      invoke: <A = unknown>(request: Broker.PreviewAutomationInvokeInput) =>
        Effect.gen(function* () {
          const client = yield* runtime.forThread(request.scope.thread.threadId);
          yield* profileLock.withPermits(1)(syncProfiles(client));
          const bridge = yield* bridgeFor(client, request.scope.environmentId);
          const value = yield* bridge.invoke<A>(request);
          yield* watch(request.scope.thread.threadId);
          return value;
        }).pipe(
          Effect.mapError((cause) =>
            isPreviewAutomationError(cause)
              ? cause
              : new C.PreviewAutomationNoAvailableHostError({
                  operation: request.operation,
                  environmentId: request.scope.environmentId,
                  ...request.scope.thread,
                  cause,
                }),
          ),
        ),
    });
    return RemotePreview.of({ manager, browser, broker });
  }),
);
export const managerLayer = Layer.effect(
  PreviewManager.PreviewManager,
  Effect.map(RemotePreview, (value) => value.manager),
).pipe(Layer.provide(layerCore));
export const browserLayer = Layer.effect(
  ServerBrowser.ServerBrowser,
  Effect.map(RemotePreview, (value) => value.browser),
).pipe(Layer.provide(layerCore));
export const brokerLayer = Layer.effect(
  Broker.PreviewAutomationBroker,
  Effect.map(RemotePreview, (value) => value.broker),
).pipe(Layer.provide(layerCore));
