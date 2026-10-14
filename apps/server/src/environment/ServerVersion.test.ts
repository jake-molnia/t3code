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
const release = { tag_name: "sandbox-v8", draft: false, prerelease: false };
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
    release?: unknown;
    comparison?: unknown;
  } = {},
) {
  const requests: string[] = [];
  const http = HttpClient.make((request) => {
    requests.push(`${request.method} ${request.url}`);
    const body = request.url.endsWith("releases/latest")
      ? (options.release ?? release)
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

it.effect("reports only a descendant fork release and caches read-only requests", () => {
  const { layer, requests } = fixture();
  return Effect.gen(function* () {
    const service = yield* ServerVersion.ServerVersion;
    expect(yield* service.check).toEqual({
      status: "available",
      tag: "sandbox-v8",
      url: "https://github.com/jake-molnia/t3code/releases/tag/sandbox-v8",
    });
    yield* service.check;
    expect(requests).toEqual([
      "GET https://api.github.com/repos/jake-molnia/t3code/releases/latest",
      `GET https://api.github.com/repos/jake-molnia/t3code/compare/${revision}...sandbox-v8`,
    ]);
    yield* TestClock.adjust("1 hour");
    yield* service.check;
    expect(requests).toHaveLength(4);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["behind", "identical"])(
  "does not advertise an older or identical release: %s",
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
  { release: { tag_name: "bad" } },
  { release: { ...release, draft: true } },
  { release: { ...release, prerelease: true } },
  { comparison: { status: "diverged" } },
  { comparison: { status: "unexpected" } },
])("degrades unavailable or incomparable releases to a passive notice: %j", (options) =>
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
