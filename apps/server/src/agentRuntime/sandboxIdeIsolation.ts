import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { routePrefix } from "./SandboxIde.ts";

/** IDE content can execute arbitrary workspace code, so it never receives central app routes. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.String("T3CODE_SANDBOX_IDE_ORIGIN"));
    const base = Option.isSome(configured) ? new URL(configured.value) : undefined;
    const belongsToIde = (hostname: string) =>
      base !== undefined && (hostname === base.hostname || hostname.endsWith(`.${base.hostname}`));
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
          const ideHost = belongsToIde(url.value.hostname);
          let ideOrigin = false;
          const originHeader = request.headers.origin;
          if (originHeader !== undefined) {
            const origin = yield* Effect.try(() => new URL(originHeader)).pipe(Effect.option);
            ideOrigin = Option.isSome(origin) && belongsToIde(origin.value.hostname);
          }
          const idePath = url.value.pathname.startsWith(routePrefix);
          if (ideHost !== idePath || (ideOrigin && !ideHost)) {
            return HttpServerResponse.empty({ status: 403 });
          }
          return yield* httpEffect;
        }),
      { global: true },
    );
  }),
);
