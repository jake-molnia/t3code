import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as P from "./worker/PreviewProtocol.ts";

// Central publication stores immutable HTML; browser execution belongs to the worker.
const publicationBrowser = Layer.succeed(PreviewBrowser.PreviewBrowser, {
  installed: Effect.succeed(Option.none()),
  executable: Effect.fail(
    new PreviewBrowser.PreviewBrowserUnavailableError({
      detail: "HTML browser execution must use the sandbox.",
    }),
  ),
});
export const layer = Layer.effect(
  HtmlRender.HtmlRender,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const nativeContext = yield* Layer.build(
      HtmlRender.layer.pipe(Layer.provide(publicationBrowser)),
    );
    const publication = Context.get(nativeContext, HtmlRender.HtmlRender);
    const clientForCaller = Effect.gen(function* () {
      const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
      if (Option.isNone(scope) || !scope.value.thread)
        return yield* new HtmlRender.HtmlRenderRemoteError({
          cause: "HTML execution requires an authenticated thread caller.",
        });
      return yield* runtime.forThread(scope.value.thread.threadId);
    }).pipe(Effect.mapError((cause) => new HtmlRender.HtmlRenderRemoteError({ cause })));
    return HtmlRender.HtmlRender.of({
      prepare: (html) =>
        Effect.gen(function* () {
          const client = yield* clientForCaller;
          return yield* Effect.tryPromise(() => client.call("html.prepare", { html })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
          );
        }).pipe(Effect.mapError((cause) => new HtmlRender.HtmlRenderRemoteError({ cause }))),
      preview: (input) =>
        Effect.gen(function* () {
          const client = yield* clientForCaller;
          return yield* Effect.tryPromise(() => client.call("html.preview", input)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(P.HtmlPreviewResult)),
          );
        }).pipe(Effect.mapError((cause) => new HtmlRender.HtmlRenderRemoteError({ cause }))),
      publish: (input) =>
        Effect.gen(function* () {
          const client = yield* runtime.forThread(input.threadId);
          const html = yield* Effect.tryPromise(() =>
            client.call("html.prepare", { html: input.html }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)));
          return yield* publication.publish({ ...input, html });
        }).pipe(Effect.mapError((cause) => new HtmlRender.HtmlRenderRemoteError({ cause }))),
    });
  }),
);
