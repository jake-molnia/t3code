import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import * as ServerConfig from "../config.ts";

export const PublicUrl = Schema.URLFromString.pipe(
  Schema.check(
    Schema.makeFilter(
      (url) =>
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        !url.href.includes("?") &&
        !url.href.includes("#"),
      { message: "Expected an HTTP(S) base URL without credentials, query, or fragment." },
    ),
  ),
  Schema.decodeTo(
    Schema.URL,
    SchemaTransformation.transform({
      decode: (url) => new URL(`${url.href.replace(/\/+$/, "")}/`),
      encode: (url) => url,
    }),
  ),
);

/** Operator-configured address; never inferred from a request's Host or forwarded headers. */
export class PublicAddress extends Context.Reference<URL | null>("t3/environment/PublicAddress", {
  defaultValue: () => null,
}) {}

export const layer = Layer.effect(
  PublicAddress,
  Effect.map(ServerConfig.ServerConfig, (config) => config.publicUrl ?? null),
);
