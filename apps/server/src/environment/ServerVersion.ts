import {
  SERVER_RELEASES_URL,
  SERVER_SOURCE_REPOSITORY,
  type ServerReleaseNotice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const Release = Schema.Struct({
  tag_name: Schema.String.check(Schema.isMinLength(1)),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const Comparison = Schema.Struct({
  status: Schema.Literals(["ahead", "behind", "identical", "diverged"]),
});

export class ServerVersion extends Context.Service<
  ServerVersion,
  { readonly check: Effect.Effect<ServerReleaseNotice> }
>()("t3/environment/ServerVersion") {}

const make = Effect.gen(function* () {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const revision = (yield* environment.getDescriptor).build?.revision;
  const get = (path: string) =>
    http
      .execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${SERVER_SOURCE_REPOSITORY}/${path}`,
        ).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            "User-Agent": "t3-sandbox-version-notice",
          }),
        ),
      )
      .pipe(Effect.flatMap((response) => response.json));

  const check = yield* Effect.gen(function* () {
    if (!revision) return { status: "unconfigured" } as const;
    const release = yield* get("releases/latest").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Release)),
    );
    if (release.draft || release.prerelease) return { status: "unavailable" } as const;
    // Fork commits do not inherit the ordering of upstream package versions.
    // Only a release descending from the deployed revision is a newer release.
    const comparison = yield* get(
      `compare/${revision}...${encodeURIComponent(release.tag_name)}`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Comparison)));
    switch (comparison.status) {
      case "ahead":
        return {
          status: "available",
          tag: release.tag_name,
          url: `${SERVER_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
        } as const;
      case "behind":
      case "identical":
        return { status: "current" } as const;
      case "diverged":
        return { status: "unavailable" } as const;
    }
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed((): ServerReleaseNotice => ({ status: "unavailable" })),
    Effect.cachedWithTTL("1 hour"),
  );
  return ServerVersion.of({ check });
});

export const layer = Layer.effect(ServerVersion, make);
