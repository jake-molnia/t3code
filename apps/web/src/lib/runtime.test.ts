import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as ClientTracer from "../observability/clientTracer";
import { runtime } from "./runtime";

describe("web runtime", () => {
  it("routes client spans to the exporter client tracing configured", async () => {
    const exported: Array<string> = [];
    ClientTracer.setDelegate(
      Tracer.make({
        span(options) {
          exported.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );

    try {
      await runtime.runPromise(Effect.void.pipe(Effect.withSpan("client.work")));
    } finally {
      ClientTracer.setDelegate(null);
    }

    expect(exported).toEqual(["client.work"]);
  });
});

it("does not initialize or flush vendor exporters with legacy telemetry configuration", async () => {
  const { vi } = await import("vite-plus/test");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://vendor.invalid/v1/traces");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "legacy-dataset");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "legacy-token");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json({ healthy: true });
  });
  vi.resetModules();
  const isolated = await import("./runtime");
  const { HttpClient } = await import("effect/http");
  try {
    await isolated.runtime.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        yield* http.get("https://environment.test/api/health");
        yield* Effect.void.pipe(Effect.withSpan("client.navigation"));
        yield* Effect.fail("test failure").pipe(
          Effect.withSpan("client.action.failed"),
          Effect.ignore,
        );
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await isolated.runtime.dispose();
    expect(requests).toEqual(["https://environment.test/api/health"]);
  } finally {
    await isolated.runtime.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
