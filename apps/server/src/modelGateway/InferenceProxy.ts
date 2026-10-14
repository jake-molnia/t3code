import { readConfiguration } from "./configuration.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

const PREFIX = "/api/model-gateway";
const POST_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/completions",
]);
const REQUEST_HEADERS = [
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "x-request-id",
];
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "request-id",
  "x-request-id",
];
type Configuration = { readonly url: string; readonly apiKey: string };

class InferenceProxy extends Context.Service<
  InferenceProxy,
  {
    readonly forward: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3/modelGateway/InferenceProxy") {}

const make = (configuration: Configuration | undefined) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return InferenceProxy.of({
      forward: (request) =>
        Effect.gen(function* () {
          if (!configuration) return HttpServerResponse.empty({ status: 503 });
          const key =
            request.headers.authorization?.replace(/^Bearer /i, "") ?? request.headers["x-api-key"];
          if (key !== configuration.apiKey) return HttpServerResponse.empty({ status: 401 });
          const incoming = new URL(request.url, "http://localhost");
          const path = incoming.pathname.slice(PREFIX.length);
          if (
            !(request.method === "GET" && path === "/v1/models") &&
            !(request.method === "POST" && POST_PATHS.has(path))
          ) {
            return HttpServerResponse.empty({ status: 404 });
          }
          const headers: Record<string, string> = {
            authorization: `Bearer ${configuration.apiKey}`,
          };
          for (const name of REQUEST_HEADERS) {
            const value = request.headers[name];
            if (value !== undefined) headers[name] = value;
          }
          const outgoing = HttpClientRequest.make(request.method)(
            new URL(path + incoming.search, configuration.url),
            {
              headers,
              ...(request.method === "POST"
                ? {
                    body: HttpBody.stream(
                      request.stream,
                      request.headers["content-type"] ?? "application/json",
                    ),
                  }
                : {}),
            },
          );
          const response = yield* client.execute(outgoing);
          const responseHeaders: Record<string, string> = {};
          for (const name of RESPONSE_HEADERS) {
            const value = response.headers[name];
            if (value !== undefined) responseHeaders[name] = value;
          }
          return HttpServerResponse.stream(response.stream, {
            status: response.status,
            headers: responseHeaders,
          });
        }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 })))),
    });
  });

export const layerWithConfiguration = (configuration: Configuration | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* InferenceProxy;
      return HttpRouter.add(
        "*",
        `${PREFIX}/*`,
        Effect.flatMap(HttpServerRequest.HttpServerRequest, service.forward),
      );
    }),
  ).pipe(
    Layer.provide(Layer.effect(InferenceProxy, make(configuration))),
    Layer.provide(FetchHttpClient.layer),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    return layerWithConfiguration(yield* readConfiguration(process.env));
  }),
);
