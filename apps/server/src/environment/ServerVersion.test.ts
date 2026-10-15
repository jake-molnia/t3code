import {
  EnvironmentId,
  SERVER_SOURCE_REPOSITORY,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerEnvironment from "./ServerEnvironment.ts";
import * as ServerVersion from "./ServerVersion.ts";

const revision = "a".repeat(40);
const publishedRevision = "b".repeat(40);
const publishedBuild = {
  id: 123,
  head_sha: publishedRevision,
  head_branch: "main",
  head_repository: { full_name: SERVER_SOURCE_REPOSITORY },
  path: ".github/workflows/sandbox-images.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const environment = (sourceRevision: string | null) =>
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("test"),
      label: "Test server",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.1",
      capabilities: { repositoryIdentity: true },
      build: {
        sourceRepository: SERVER_SOURCE_REPOSITORY,
        revision: sourceRevision,
        packageVersion: "0.0.1.sandbox.8",
        upstreamVersion: "0.0.1",
      },
    } satisfies ExecutionEnvironmentDescriptor),
  });

function fixture(
  options: {
    revision?: string | null;
    status?: number;
    builds?: unknown;
    comparison?: unknown;
  } = {},
) {
  const requests: string[] = [];
  const http = HttpClient.make((request, url) => {
    requests.push(`${request.method} ${url}`);
    const body = url.pathname.endsWith("/runs")
      ? (options.builds ?? { workflow_runs: [publishedBuild] })
      : (options.comparison ?? { status: "ahead" });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(body, { status: options.status ?? 200 })),
    );
  });
  const layer = ServerVersion.layer.pipe(
    Layer.provide(environment(options.revision === undefined ? revision : options.revision)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { layer, requests };
}

it.effect("reports a published descendant image and caches read-only requests", () => {
  const { layer, requests } = fixture();
  return Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    expect(yield* service.check).toEqual({
      status: "available",
      revision: publishedRevision,
      url: "https://github.com/jake-molnia/t3code/actions/runs/123",
    });
    yield* service.check;
    expect(requests).toEqual([
      "GET https://api.github.com/repos/jake-molnia/t3code/actions/workflows/sandbox-images.yml/runs?branch=main&status=success&per_page=1",
      `GET https://api.github.com/repos/jake-molnia/t3code/compare/${revision}...${publishedRevision}`,
    ]);
    yield* TestClock.adjust("1 hour");
    yield* service.check;
    expect(requests).toHaveLength(4);
  }).pipe(Effect.provide(layer));
});

it.effect("accepts a successful manual publication from main", () =>
  Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    expect(yield* service.check).toMatchObject({
      status: "available",
      revision: publishedRevision,
    });
  }).pipe(
    Effect.provide(
      fixture({
        builds: { workflow_runs: [{ ...publishedBuild, event: "workflow_dispatch" }] },
      }).layer,
    ),
  ),
);

it.effect.each(["behind", "identical"])(
  "does not advertise an older or identical published image: %s",
  (status) =>
    Effect.gen(function* () {
      const service = yield* ServerVersion.ServerVersion;
      expect(yield* service.check).toEqual({ status: "current" });
    }).pipe(Effect.provide(fixture({ comparison: { status } }).layer)),
);

it.effect.each([
  { status: 404 },
  { status: 429 },
  { status: 503 },
  { builds: {} },
  { builds: { workflow_runs: [] } },
  ...[
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
    { head_branch: "feature" },
    { event: "pull_request" },
    { head_repository: { full_name: "other/fork" } },
    { path: ".github/workflows/ci.yml" },
    { head_sha: "not-a-revision" },
  ].map((overrides) => ({ builds: { workflow_runs: [{ ...publishedBuild, ...overrides }] } })),
  { comparison: { status: "diverged" } },
  { comparison: { status: "unexpected" } },
])("degrades unpublished or incomparable images to a passive notice: %j", (options) =>
  Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    expect(yield* service.check).toEqual({ status: "unavailable" });
  }).pipe(Effect.provide(fixture(options).layer)),
);

it.effect("does not guess a fork revision from the upstream version", () => {
  const { layer, requests } = fixture({ revision: null });
  return Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    expect(yield* service.check).toEqual({ status: "unconfigured" });
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("bounds an offline check to five seconds", () =>
  Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    const fiber = yield* service.check.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toEqual({ status: "unavailable" });
  }).pipe(
    Effect.provide(
      ServerVersion.layer.pipe(
        Layer.provide(environment(revision)),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.never),
          ),
        ),
      ),
    ),
  ),
);
