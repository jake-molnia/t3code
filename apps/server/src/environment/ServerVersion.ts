import {
  SERVER_IMAGE_WORKFLOW,
  SERVER_SOURCE_REPOSITORY,
  type ServerReleaseNotice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const PublishedImageBuilds = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      head_sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
      head_branch: Schema.Literal("main"),
      head_repository: Schema.Struct({ full_name: Schema.Literal(SERVER_SOURCE_REPOSITORY) }),
      path: Schema.Literal(`.github/workflows/${SERVER_IMAGE_WORKFLOW}`),
      event: Schema.Literals(["push", "workflow_dispatch"]),
      status: Schema.Literal("completed"),
      conclusion: Schema.Literal("success"),
    }),
  ),
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
    const builds = yield* get(
      `actions/workflows/${SERVER_IMAGE_WORKFLOW}/runs?branch=main&status=success&per_page=1`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PublishedImageBuilds)));
    const build = builds.workflow_runs[0];
    if (!build) return { status: "unavailable" } as const;
    // This workflow succeeds only after verifying and publishing both images.
    // Compare its source revision, never an unbuilt branch head or upstream version.
    const comparison = yield* get(`compare/${revision}...${build.head_sha}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Comparison)),
    );
    switch (comparison.status) {
      case "ahead":
        return {
          status: "available",
          revision: build.head_sha,
          url: `https://github.com/${SERVER_SOURCE_REPOSITORY}/actions/runs/${build.id}`,
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
