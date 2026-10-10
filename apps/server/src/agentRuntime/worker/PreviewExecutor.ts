import * as PortScanner from "../../preview/PortScanner.ts";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Playwright accepts Node buffers for inline uploaded files.
import * as NodeBuffer from "node:buffer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as C from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as PreviewManager from "../../preview/Manager.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as P from "./PreviewProtocol.ts";
import { WorkspaceExecutionError } from "./Protocol.ts";

export const makePreviewExecutor = (options: {
  publish: (sessionId: string, event: unknown) => Promise<void>;
}) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const html = yield* HtmlRender.HtmlRender;
    const ports = yield* Effect.serviceOption(PortScanner.PortDiscovery);
    const browser = yield* ServerBrowser.ServerBrowser;
    const broker = yield* Broker.PreviewAutomationBroker;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const executorScope = yield* Effect.scope;
    const tabs = new Set<string>();
    const viewers = new Map<
      string,
      {
        viewer: ServerBrowser.ServerBrowserViewer;
        tabKey: string;
        closed: Deferred.Deferred<void>;
        scope: Scope.Closeable;
        acks: Map<number, Effect.Effect<void>>;
        sequence: number;
      }
    >();
    const closeViewer = (viewerId: string) =>
      Effect.gen(function* () {
        const value = viewers.get(viewerId);
        if (!value) return;
        viewers.delete(viewerId);
        yield* Deferred.succeed(value.closed, undefined);
        const acks = Array.from(value.acks.values());
        value.acks.clear();
        for (const ack of acks) yield* ack.pipe(Effect.ignore);
        const queued = yield* Queue.takeBetween(
          value.viewer.output,
          0,
          Number.MAX_SAFE_INTEGER,
        ).pipe(Effect.exit);
        if (Exit.isSuccess(queued))
          for (const item of queued.value)
            if (item._tag === "frame") yield* item.ack.pipe(Effect.ignore);
        yield* Scope.close(value.scope, Exit.void);
      }).pipe(Effect.uninterruptible);
    const subscription = yield* manager.subscribeEvents;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const key = `${event.threadId}\0${event.tabId}`;
          if (event.type === "closed") {
            tabs.delete(key);
            for (const [viewerId, value] of viewers)
              if (value.tabKey === key) yield* closeViewer(viewerId);
          } else tabs.add(key);
          yield* Effect.promise(() => options.publish(`preview:${event.threadId}`, event));
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        Effect.forEach(Array.from(viewers.keys()), closeViewer, {
          discard: true,
        }),
      ),
    );
    const lookupViewer = (id: string) =>
      Effect.gen(function* () {
        const viewer = viewers.get(id);
        if (!viewer) return yield* new WorkspaceExecutionError({ code: "preview_viewer_missing" });
        return viewer;
      });
    const execute = (method: string, raw: unknown) =>
      Effect.gen(function* () {
        switch (method) {
          case "preview.discover": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ configuredUrls: Schema.optional(Schema.Array(Schema.String)) }),
            )(raw);
            if (Option.isNone(ports))
              return yield* new WorkspaceExecutionError({ code: "port_discovery_unavailable" });
            return yield* ports.value.scan(input.configuredUrls);
          }
          case "html.prepare": {
            const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ html: Schema.String }))(
              raw,
            );
            return yield* html.prepare(input.html);
          }
          case "html.preview":
            return yield* html.preview(yield* Schema.decodeUnknownEffect(P.HtmlPreviewInput)(raw));
          case "preview.open": {
            const input = yield* Schema.decodeUnknownEffect(C.PreviewOpenInput)(raw);
            return yield* manager.open({ ...input, runtime: "server" });
          }
          case "preview.navigate":
            return yield* manager.navigate(
              yield* Schema.decodeUnknownEffect(C.PreviewNavigateInput)(raw),
            );
          case "preview.resize":
            return yield* manager.resize(
              yield* Schema.decodeUnknownEffect(C.PreviewResizeInput)(raw),
            );
          case "preview.adjust":
            return yield* manager.adjust(
              yield* Schema.decodeUnknownEffect(C.PreviewAdjustInput)(raw),
            );
          case "preview.refresh":
            yield* manager.refresh(yield* Schema.decodeUnknownEffect(C.PreviewRefreshInput)(raw));
            return null;
          case "preview.close":
            yield* manager.close(yield* Schema.decodeUnknownEffect(C.PreviewCloseInput)(raw));
            return null;
          case "preview.list":
            return yield* manager.list(yield* Schema.decodeUnknownEffect(C.PreviewListInput)(raw));
          case "preview.reportStatus":
            yield* manager.reportStatus(
              yield* Schema.decodeUnknownEffect(C.PreviewReportStatusInput)(raw),
            );
            return null;
          case "preview.reveal":
            yield* manager.requestReveal(
              yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  ...C.PreviewCloseInput.fields,
                  tabId: Schema.String,
                  force: Schema.Boolean,
                }),
              )(raw),
            );
            return null;
          case "preview.clearProfile":
            yield* browser.clearProfile(
              (yield* Schema.decodeUnknownEffect(C.PreviewClearProfileInput)(raw)).profileId,
            );
            return null;
          case "preview.reportProfiles":
            yield* browser.reportProfiles(
              yield* Schema.decodeUnknownEffect(C.PreviewReportProfilesInput)(raw),
            );
            return null;
          case "preview.automation": {
            const { request } = yield* Schema.decodeUnknownEffect(P.Automation)(raw);
            return yield* broker
              .invoke({
                scope: {
                  environmentId,
                  capabilities: new Set(["preview"]),
                  issuedAt: 0,
                  requestNamespace: request.agentSessionId ?? request.requestId,
                  client: undefined,
                  thread: {
                    threadId: request.threadId,
                    providerSessionId: request.agentSessionId ?? request.requestId,
                    providerInstanceId: C.ProviderInstanceId.make("sandbox-preview"),
                  },
                },
                operation: request.operation,
                input: request.input,
                ...(request.tabId ? { tabId: request.tabId } : {}),
                timeoutMs: request.timeoutMs,
              })
              .pipe(
                Effect.match({
                  onFailure: (error) => ({
                    ok: false,
                    error: { _tag: error._tag, message: error.message },
                  }),
                  onSuccess: (result) => ({ ok: true, result }),
                }),
              );
          }
          case "preview.answerFileChooser": {
            const input = yield* Schema.decodeUnknownEffect(P.FileChooser)(raw);
            return yield* browser.answerFileChooser({
              ...input,
              files: input.files.map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                buffer: NodeBuffer.Buffer.from(file.data, "base64"),
              })),
            });
          }
          case "preview.download": {
            const input = yield* Schema.decodeUnknownEffect(P.Download)(raw);
            const download = yield* browser.openDownload(input);
            if (Option.isNone(download)) return null;
            const stat = yield* fs.stat(download.value.path);
            if (stat.size > 32n * 1024n * 1024n)
              return yield* new WorkspaceExecutionError({ code: "preview_download_too_large" });
            return {
              fileName: download.value.fileName,
              data: Base64.encode(yield* fs.readFile(download.value.path)),
            };
          }
          case "preview.viewerOpen": {
            const input = yield* Schema.decodeUnknownEffect(P.ViewerOpen)(raw);
            const scope = yield* Scope.make();
            const viewer = yield* browser.attachViewer(input).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            );
            const viewerId = yield* crypto.randomUUIDv4;
            const closed = yield* Deferred.make<void>();
            viewers.set(viewerId, {
              viewer,
              scope,
              closed,
              tabKey: `${input.threadId}\0${input.tabId}`,
              acks: new Map(),
              sequence: 0,
            });
            yield* Queue.await(viewer.output).pipe(
              Effect.ignoreCause,
              Effect.onExit(() =>
                closeViewer(viewerId).pipe(Effect.forkIn(executorScope), Effect.asVoid),
              ),
              Effect.forkIn(scope),
            );
            return { viewerId };
          }
          case "preview.viewerClose": {
            const { viewerId } = yield* Schema.decodeUnknownEffect(P.ViewerRef)(raw);
            yield* closeViewer(viewerId);
            return null;
          }
          case "preview.viewerInput": {
            const input = yield* Schema.decodeUnknownEffect(P.ViewerInput)(raw);
            yield* (yield* lookupViewer(input.viewerId)).viewer.input(input.message);
            return null;
          }
          case "preview.viewerAck": {
            const input = yield* Schema.decodeUnknownEffect(P.ViewerAck)(raw);
            const viewer = yield* lookupViewer(input.viewerId);
            const ack = viewer.acks.get(input.ackId);
            if (ack) {
              viewer.acks.delete(input.ackId);
              yield* ack;
            }
            return null;
          }
          case "preview.viewerPoll": {
            const input = yield* Schema.decodeUnknownEffect(P.ViewerRef)(raw);
            const viewer = yield* lookupViewer(input.viewerId);
            const outputs = yield* Queue.takeAll(viewer.viewer.output).pipe(
              Effect.raceFirst(Deferred.await(viewer.closed).pipe(Effect.as([]))),
            );
            const batch: Array<typeof P.ViewerOutput.Type> = [];
            for (const output of outputs) {
              if (output._tag === "frame") {
                if (viewer.acks.size >= 8) {
                  yield* output.ack;
                  continue;
                }
                const ackId = ++viewer.sequence;
                viewer.acks.set(ackId, output.ack);
                batch.push({ _tag: "frame", data: Base64.encode(output.data), ackId });
              } else batch.push(output);
            }
            if (batch.some((output) => output._tag === "gone" || output._tag === "reconnect"))
              yield* closeViewer(input.viewerId);
            return batch;
          }
          default:
            return yield* new WorkspaceExecutionError({ code: "unsupported_preview_method" });
        }
      });
    return {
      execute,
      activity: Effect.sync(() => ({
        activeOperations: tabs.size + viewers.size,
        pendingCallbacks: 0,
      })),
    };
  });
