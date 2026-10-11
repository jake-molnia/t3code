import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";
import { ideIdentityHeader, workerIdePrefix } from "../execution/WorkerIdeProxy.ts";
import * as SandboxIde from "./SandboxIde.ts";

const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(ExecutionIdentity));

const strippedHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "x-t3-ide-identity",
  "x-t3-ide-base",
]);

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const ide = yield* SandboxIde.SandboxIde;
    const client = yield* HttpClient.HttpClient;
    const construct = yield* Socket.WebSocketConstructor;
    yield* router.add(
      "*",
      `${SandboxIde.routePrefix}*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, "http://gateway");
        const relative = url.pathname.slice(SandboxIde.routePrefix.length);
        const separator = relative.indexOf("/");
        if (separator < 0) return HttpServerResponse.empty({ status: 404 });
        const id = relative.slice(0, separator);
        const requestUrl = HttpServerRequest.toURL(request);
        if (Option.isNone(requestUrl)) return HttpServerResponse.empty({ status: 400 });
        const authorizationInput = {
          sessionId: id,
          requestOrigin: requestUrl.value.origin,
          ...(request.headers.origin ? { origin: request.headers.origin } : {}),
          ...(url.searchParams.has("ticket")
            ? { ticket: url.searchParams.get("ticket") ?? "" }
            : {}),
          ...(request.cookies[SandboxIde.cookieName]
            ? { cookie: request.cookies[SandboxIde.cookieName] }
            : {}),
        };
        const authorization = yield* ide.authorize(authorizationInput);
        if (authorization.kind === "bootstrap") {
          return HttpServerResponse.empty({
            status: 303,
            headers: {
              location: authorization.url,
              "set-cookie": `${SandboxIde.cookieName}=${authorization.cookie}; Path=${SandboxIde.routePrefix}${id}/; HttpOnly; ${authorization.secure ? "Secure; " : ""}SameSite=Lax`,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          });
        }
        const access = authorization.access;
        const base = `${SandboxIde.routePrefix}${id}/`;
        const target = new URL(access.endpoint);
        target.pathname = `${target.pathname.replace(/\/+$/, "")}${workerIdePrefix}${relative.slice(separator + 1)}`;
        target.search = url.search;
        const headers: Record<string, string> = Object.fromEntries(
          Object.entries(request.headers).filter(([key]) => !strippedHeaders.has(key)),
        );
        headers["accept-encoding"] = "identity";
        headers.authorization = `Bearer ${access.token}`;
        headers[ideIdentityHeader] = yield* encodeIdentity(access.identity).pipe(Effect.orDie);
        headers["x-t3-ide-base"] = base;
        headers["x-forwarded-prefix"] = base.slice(0, -1);
        headers["x-forwarded-host"] = request.headers.host ?? "";
        if (request.headers.upgrade?.toLowerCase() === "websocket") {
          target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
          const upstream = yield* Socket.fromWebSocket(
            Effect.acquireRelease(
              Effect.sync(() => construct(target.toString(), { headers })),
              (socket) => Effect.sync(() => socket.close()),
            ),
          );
          // Connect upstream before accepting the browser upgrade, including identity/auth rejection.
          const reader = yield* upstream.reader;
          yield* authorization.connected;
          const downstream = yield* request.upgrade;
          const downstreamReader = yield* downstream.reader;
          const upstreamWriter = yield* upstream.writer;
          const downstreamWriter = yield* downstream.writer;
          yield* Effect.raceFirst(
            Effect.raceFirst(
              Effect.forever(reader.pull.pipe(Effect.flatMap(downstreamWriter.writeAll))),
              Effect.forever(downstreamReader.pull.pipe(Effect.flatMap(upstreamWriter.writeAll))),
            ),
            Effect.forever(
              Effect.sleep("5 seconds").pipe(Effect.andThen(ide.authorize(authorizationInput))),
            ),
          ).pipe(Effect.catch(() => Effect.void));
          return HttpServerResponse.empty();
        }
        let outgoing = HttpClientRequest.make(request.method)(target.toString(), { headers });
        if (request.method !== "GET" && request.method !== "HEAD") {
          outgoing = HttpClientRequest.bodyStream(outgoing, request.stream, {
            contentType: request.headers["content-type"],
          });
        }
        const response = yield* client
          .execute(outgoing)
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const responseHeaders = Object.fromEntries(
          Object.entries(response.headers).filter(
            ([key]) =>
              ![
                "set-cookie",
                "transfer-encoding",
                "connection",
                "content-length",
                "content-encoding",
              ].includes(key),
          ),
        );
        responseHeaders["cache-control"] = "no-store";
        responseHeaders["referrer-policy"] = "no-referrer";
        delete responseHeaders["access-control-allow-origin"];
        delete responseHeaders["access-control-allow-credentials"];
        return HttpServerResponse.stream(response.stream, {
          status: response.status,
          headers: responseHeaders,
        });
      }).pipe(
        Effect.catchTags({
          SandboxIdeError: (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, {
                status:
                  error.reason === "unavailable" ? 503 : error.reason === "forbidden" ? 401 : 410,
              }),
            ),
        }),
      ),
    );
  }),
);
