import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as PreviewManager from "../../preview/Manager.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makePreviewExecutor } from "./PreviewExecutor.ts";
import * as P from "./PreviewProtocol.ts";
import { captureRunPromise } from "../../execution/EffectHttpBoundary.ts";

const services = Layer.mergeAll(
  PreviewManager.layer,
  Broker.layer,
  Layer.succeed(HtmlRender.HtmlRender, {
    prepare: (html) => Effect.succeed(html),
    preview: () => Effect.die("browser not used in viewer tests"),
    publish: () => Effect.die("publication not used in viewer tests"),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.layer(services, { excludeTestServices: true })("sandbox preview execution", (it) => {
  it.effect.each(["tab", "stream"] as const)(
    "closing the %s releases its viewers and tolerates late viewer close",
    (closing) =>
      Effect.gen(function* () {
        const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
        const closed = yield* Deferred.make<void>();
        const viewerReleased = yield* Deferred.make<void>();
        let released = 0;
        const runPromise = yield* captureRunPromise;
        const executor = yield* makePreviewExecutor({
          publish: (_session, event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "closed"
              ? runPromise(Deferred.succeed(closed, undefined)).then(() => {})
              : Promise.resolve(),
        }).pipe(
          Effect.provideService(ServerBrowser.ServerBrowser, {
            attachViewer: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    released++;
                  }).pipe(Effect.andThen(Deferred.succeed(viewerReleased, undefined))),
                );
                return { output, input: () => Effect.void };
              }),
            answerFileChooser: () => Effect.succeed(false),
            openDownload: () => Effect.succeed(Option.none()),
            clearProfile: () => Effect.void,
            reportProfiles: () => Effect.void,
          }),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
            getDescriptor: Effect.die("unused"),
          }),
        );
        const tab = yield* Schema.decodeUnknownEffect(C.PreviewSessionSnapshot)(
          yield* executor.execute("preview.open", {
            threadId: "close-thread",
            url: "http://localhost:3000",
            runtime: "server",
          }),
        );
        const viewer = yield* executor.execute("preview.viewerOpen", {
          threadId: "close-thread",
          tabId: tab.tabId,
          maxWidth: 100,
          maxHeight: 100,
          quality: 50,
          canOperate: false,
        });
        if (closing === "stream") {
          yield* Queue.shutdown(output);
          yield* Deferred.await(viewerReleased);
          expect(released).toBe(1);
        }
        yield* executor.execute("preview.close", { threadId: "close-thread", tabId: tab.tabId });
        yield* Deferred.await(closed);
        expect(yield* executor.activity).toEqual({ activeOperations: 0, pendingCallbacks: 0 });
        expect(released).toBe(1);
        yield* executor.execute("preview.viewerClose", viewer);
        expect(released).toBe(1);
      }),
  );
  it.effect(
    "forces server tabs and holds native frame acknowledgements until the viewer acks",
    () =>
      Effect.gen(function* () {
        const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({ capacity: 16 });
        let acknowledged = 0;
        const inputs: unknown[] = [];
        const browser = ServerBrowser.ServerBrowser.of({
          attachViewer: () =>
            Effect.succeed({
              output,
              input: (message) =>
                Effect.sync(() => {
                  inputs.push(message);
                }),
            }),
          answerFileChooser: () => Effect.succeed(true),
          openDownload: () => Effect.succeed(Option.none()),
          clearProfile: () => Effect.void,
          reportProfiles: () => Effect.void,
        });
        const executor = yield* makePreviewExecutor({ publish: async () => {} }).pipe(
          Effect.provideService(ServerBrowser.ServerBrowser, browser),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
            getDescriptor: Effect.die("descriptor not used"),
          }),
        );
        const opened = yield* Schema.decodeUnknownEffect(C.PreviewSessionSnapshot)(
          yield* executor.execute("preview.open", {
            threadId: "thread",
            url: "http://localhost:3000",
            runtime: "desktop",
          }),
        );
        expect(opened.runtime).toBe("server");
        const viewer = yield* Schema.decodeUnknownEffect(P.ViewerRef)(
          yield* executor.execute("preview.viewerOpen", {
            threadId: "thread",
            tabId: opened.tabId,
            maxWidth: 1280,
            maxHeight: 720,
            quality: 70,
            canOperate: true,
          }),
        );
        yield* Queue.offer(output, {
          _tag: "frame",
          data: new Uint8Array([1, 2, 3]),
          ack: Effect.sync(() => {
            acknowledged++;
          }),
        });
        const frames = yield* Schema.decodeUnknownEffect(P.ViewerBatch)(
          yield* executor.execute("preview.viewerPoll", { ...viewer, afterSequence: 0 }),
        );
        expect(frames).toEqual({ sequence: 1, items: [{ _tag: "frame", data: "AQID", ackId: 1 }] });
        expect(
          yield* executor.execute("preview.viewerPoll", { ...viewer, afterSequence: 0 }),
        ).toEqual(frames);
        expect(
          (yield* executor
            .execute("preview.viewerPoll", { ...viewer, afterSequence: 2 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(acknowledged).toBe(0);
        yield* executor.execute("preview.viewerAck", { ...viewer, ackId: 1 });
        yield* executor.execute("preview.viewerAck", { ...viewer, ackId: 1 });
        expect(acknowledged).toBe(1);
        yield* executor.execute("preview.viewerInput", {
          ...viewer,
          message: { type: "pointerMove", x: 1, y: 2 },
        });
        expect(inputs).toHaveLength(1);
        yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 720 });
        expect(
          yield* executor.execute("preview.viewerPoll", { ...viewer, afterSequence: 1 }),
        ).toEqual({ sequence: 2, items: [{ _tag: "viewport", width: 1280, height: 720 }] });
        expect(
          (yield* executor
            .execute("preview.viewerPoll", { ...viewer, afterSequence: 0 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        const pendingPoll = yield* executor
          .execute("preview.viewerPoll", { ...viewer, afterSequence: 2 })
          .pipe(Effect.exit, Effect.forkScoped);
        const queuedPoll = yield* executor
          .execute("preview.viewerPoll", { ...viewer, afterSequence: 2 })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* executor.execute("preview.viewerClose", viewer);
        expect((yield* Fiber.join(pendingPoll).pipe(Effect.timeout("1 second")))._tag).toBe(
          "Success",
        );
        expect((yield* Fiber.join(queuedPoll).pipe(Effect.timeout("1 second")))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* Effect.exit(
            executor.execute("preview.viewerPoll", { ...viewer, afterSequence: 0 }),
          ))._tag,
        ).toBe("Failure");
      }),
  );
  it.effect("bounds total close cleanup with stored and queued stalled acknowledgements", () =>
    Effect.gen(function* () {
      const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({ capacity: 64 });
      let acknowledged = 0;
      let interrupted = 0;
      let released = false;
      const executor = yield* makePreviewExecutor({ publish: async () => {} }).pipe(
        Effect.provideService(ServerBrowser.ServerBrowser, {
          attachViewer: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true;
                }),
              );
              return { output, input: () => Effect.void };
            }),
          answerFileChooser: () => Effect.succeed(false),
          openDownload: () => Effect.succeed(Option.none()),
          clearProfile: () => Effect.void,
          reportProfiles: () => Effect.void,
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
          getDescriptor: Effect.die("unused"),
        }),
      );
      const viewer = yield* Schema.decodeUnknownEffect(P.ViewerRef)(
        yield* executor.execute("preview.viewerOpen", {
          threadId: "thread",
          tabId: "tab",
          maxWidth: 100,
          maxHeight: 100,
          quality: 50,
          canOperate: false,
        }),
      );
      const frame = {
        _tag: "frame" as const,
        data: new Uint8Array([0]),
        ack: Effect.gen(function* () {
          acknowledged++;
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interrupted++;
            }),
          ),
        ),
      };
      for (let i = 0; i < 8; i++) yield* Queue.offer(output, frame);
      yield* executor.execute("preview.viewerPoll", { ...viewer, afterSequence: 0 });
      for (let i = 0; i < 64; i++) yield* Queue.offer(output, frame);
      const started = yield* Clock.currentTimeMillis;
      yield* executor.execute("preview.viewerClose", viewer);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2500);
      expect(acknowledged).toBe(72);
      expect(interrupted).toBe(72);
      expect(released).toBe(true);
      expect((yield* executor.activity).activeOperations).toBe(0);
    }),
  );
  it.effect("bounds unacknowledged frames and acknowledges dropped frames", () =>
    Effect.gen(function* () {
      const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>({ capacity: 20 });
      let acknowledgements = 0;
      const droppedStarted = yield* Deferred.make<void>();
      const allDropped = yield* Deferred.make<void>();
      const releaseDropped = yield* Deferred.make<void>();
      const executor = yield* makePreviewExecutor({ publish: async () => {} }).pipe(
        Effect.provideService(ServerBrowser.ServerBrowser, {
          attachViewer: () => Effect.succeed({ output, input: () => Effect.void }),
          answerFileChooser: () => Effect.succeed(false),
          openDownload: () => Effect.succeed(Option.none()),
          clearProfile: () => Effect.void,
          reportProfiles: () => Effect.void,
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(C.EnvironmentId.make("worker-env")),
          getDescriptor: Effect.die("unused"),
        }),
      );
      const viewer = yield* Schema.decodeUnknownEffect(P.ViewerRef)(
        yield* executor.execute("preview.viewerOpen", {
          threadId: "thread",
          tabId: "tab",
          maxWidth: 100,
          maxHeight: 100,
          quality: 50,
          canOperate: false,
        }),
      );
      for (let i = 0; i < 12; i++)
        yield* Queue.offer(output, {
          _tag: "frame",
          data: new Uint8Array([i]),
          ack: Effect.gen(function* () {
            acknowledgements++;
            if (acknowledgements === 4) yield* Deferred.succeed(allDropped, undefined);
            if (i === 8) {
              yield* Deferred.succeed(droppedStarted, undefined);
              yield* Deferred.await(releaseDropped);
            }
          }),
        });
      const control = {
        _tag: "control" as const,
        canOperate: true,
        controller: "you" as const,
        generation: 7,
        dialog: null,
      };
      yield* Queue.offer(output, control);
      const lostPoll = yield* executor
        .execute("preview.viewerPoll", { ...viewer, afterSequence: 0 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(droppedStarted).pipe(Effect.timeout("1 second"));
      yield* Fiber.interrupt(lostPoll);
      const batch = yield* Schema.decodeUnknownEffect(P.ViewerBatch)(
        yield* executor
          .execute("preview.viewerPoll", { ...viewer, afterSequence: 0 })
          .pipe(Effect.timeout("1 second")),
      );
      expect(batch.items.filter((item) => item._tag === "frame")).toHaveLength(8);
      expect(batch.items.at(-1)).toEqual(control);
      yield* Deferred.await(allDropped).pipe(Effect.timeout("1 second"));
      expect(acknowledgements).toBe(4);
      yield* executor.execute("preview.viewerClose", viewer);
      expect(acknowledgements).toBe(12);
      expect((yield* executor.activity).activeOperations).toBe(0);
      for (const terminal of ["gone", "reconnect"] as const) {
        const ended = yield* Schema.decodeUnknownEffect(P.ViewerRef)(
          yield* executor.execute("preview.viewerOpen", {
            threadId: "thread",
            tabId: "tab",
            maxWidth: 100,
            maxHeight: 100,
            quality: 50,
            canOperate: true,
          }),
        );
        const firstPoll = yield* executor
          .execute("preview.viewerPoll", { ...ended, afterSequence: 0 })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const queuedRetry = yield* executor
          .execute("preview.viewerPoll", { ...ended, afterSequence: 0 })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Queue.offer(output, { _tag: terminal });
        const first = yield* Fiber.join(firstPoll);
        expect(yield* Fiber.join(queuedRetry)).toEqual(first);
        expect(first).toEqual({ sequence: 1, items: [{ _tag: terminal }] });
        expect((yield* executor.activity).activeOperations).toBe(0);
        expect(
          yield* executor.execute("preview.viewerPoll", { ...ended, afterSequence: 0 }),
        ).toEqual(first);
        expect(
          (yield* executor
            .execute("preview.viewerPoll", { ...ended, afterSequence: 2 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* executor.execute("preview.viewerClose", ended);
        expect(
          (yield* executor
            .execute("preview.viewerPoll", { ...ended, afterSequence: 0 })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }
    }),
  );
});
