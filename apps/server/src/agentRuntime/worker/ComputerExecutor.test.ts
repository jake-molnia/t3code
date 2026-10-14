import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import { makeComputerExecutor } from "./ComputerExecutor.ts";

const desktopInfo = {
  success: true,
  data: {
    available: true,
    display: ":99",
    screen_resolution: { width: 1440, height: 900 },
    capabilities: { screenshot: true, actions: true },
  },
};

const make = (
  respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Response | Effect.Effect<Response, HttpClientError.HttpClientError>,
  url: string | undefined = "http://127.0.0.1:18091",
) =>
  makeComputerExecutor.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: url === undefined ? {} : { T3CODE_SANDBOX_COMPUTER_URL: url },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.suspend(() => {
          const response = respond(request);
          return response instanceof Response ? Effect.succeed(response) : response;
        }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
      ),
    ),
  );

it.effect("maps actions to the sandbox AIO v2 protocol and verifies backend success", () =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const executor = yield* make((request) => {
      if (request.url.endsWith("/info")) return Response.json(desktopInfo);
      expect(request.url).toBe("http://127.0.0.1:18091/v2/computer/actions");
      expect(request.method).toBe("POST");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array")
        sent.push(JSON.parse(new TextDecoder().decode(request.body.body)));
      return Response.json({
        success: true,
        data: { status: "success", action_performed: "CLICK" },
      });
    });
    for (const action of [
      { kind: "click", x: 12, y: 34, button: "right", clicks: 2 },
      { kind: "type", text: "λ" },
      { kind: "hotkey", keys: ["ctrl", "a"] },
      { kind: "scroll", dx: 0, dy: -3 },
      { kind: "wait", seconds: 0.5 },
    ])
      expect(yield* executor.execute("computer.action", action)).toEqual({ ok: true });
    expect(sent).toEqual([
      { action_type: "CLICK", x: 12, y: 34, button: "right", num_clicks: 2 },
      { action_type: "TYPING", text: "λ" },
      { action_type: "HOTKEY", keys: ["ctrl", "a"] },
      { action_type: "SCROLL", dx: 0, dy: -3 },
      { action_type: "WAIT", duration: 0.5 },
    ]);
  }),
);

it.effect("returns desktop metadata and PNG bytes with dimensions", () =>
  Effect.gen(function* () {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const executor = yield* make((request) =>
      request.url.endsWith("/info")
        ? Response.json({
            success: true,
            data: {
              available: true,
              display: ":99",
              screen_resolution: { width: 1440, height: 900 },
              capabilities: { screenshot: true, actions: true, clipboard: true },
            },
          })
        : new Response(png, { headers: { "content-type": "image/png" } }),
    );
    expect(yield* executor.execute("computer.status", {})).toEqual({
      available: true,
      display: ":99",
      resolution: { width: 1440, height: 900 },
      capabilities: { screenshot: true, actions: true },
    });
    expect(yield* executor.execute("computer.screenshot", {})).toEqual({
      screenshot: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 },
    });
  }),
);

it.effect(
  "rejects foreign endpoints, invalid actions, failed actions, and non-PNG screenshots",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const foreign = yield* make(() => {
        calls++;
        return Response.json({});
      }, "http://example.com:18091");
      expect(yield* foreign.execute("computer.status", {}).pipe(Effect.flip)).toMatchObject({
        code: "computer_endpoint_invalid",
      });
      const failed = yield* make((request) => {
        if (request.url.endsWith("/info")) return Response.json(desktopInfo);
        calls++;
        return Response.json({ success: false, data: null });
      });
      yield* failed
        .execute("computer.action", { kind: "scroll", dx: 0, dy: 101 })
        .pipe(Effect.flip);
      expect(calls).toBe(0);
      yield* failed.execute("computer.action", { kind: "press", key: "enter" }).pipe(Effect.flip);
      const invalidScreenshot = yield* make((request) =>
        request.url.endsWith("/info") ? Response.json(desktopInfo) : Response.json({}),
      );
      expect(
        yield* invalidScreenshot.execute("computer.screenshot", {}).pipe(Effect.flip),
      ).toMatchObject({
        code: "computer_screenshot_invalid",
      });
      expect(calls).toBe(1);
      const unavailable = yield* make(() => new Response(null, { status: 401 }));
      expect(yield* unavailable.execute("computer.status", {}).pipe(Effect.flip)).toMatchObject({
        code: "computer_backend_failed",
      });
    }),
);

it.effect("waits for desktop readiness before sending an action once", () =>
  Effect.gen(function* () {
    let probes = 0;
    let actions = 0;
    const executor = yield* make((request) => {
      if (request.url.endsWith("/info")) {
        probes++;
        if (probes === 1) return new Response(null, { status: 503 });
        return Response.json({
          ...desktopInfo,
          data: { ...desktopInfo.data, available: probes > 2 },
        });
      }
      actions++;
      return Response.json({ success: true });
    });
    const action = yield* executor
      .execute("computer.action", { kind: "press", key: "enter" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("250 millis");
    expect(probes).toBe(2);
    expect(actions).toBe(0);
    yield* TestClock.adjust("250 millis");
    expect(yield* Fiber.join(action)).toEqual({ ok: true });
    expect(actions).toBe(1);
    yield* executor.execute("computer.action", { kind: "press", key: "enter" });
    expect(probes).toBe(3);
    expect(actions).toBe(2);
  }),
);

it.effect("waits through a connection refusal before the computer daemon listens", () =>
  Effect.gen(function* () {
    let probes = 0;
    let actions = 0;
    const executor = yield* make((request) => {
      if (request.url.endsWith("/info")) {
        probes++;
        if (probes === 1)
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("ECONNREFUSED"),
              }),
            }),
          );
        return Response.json(desktopInfo);
      }
      actions++;
      return Response.json({ success: true });
    });
    const action = yield* executor
      .execute("computer.action", { kind: "press", key: "enter" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("250 millis");
    expect(yield* Fiber.join(action)).toEqual({ ok: true });
    expect(probes).toBe(2);
    expect(actions).toBe(1);
  }),
);

it.effect("bounds readiness waiting and never retries failed actions", () =>
  Effect.gen(function* () {
    let actions = 0;
    const unavailable = yield* make(() => new Response(null, { status: 503 }));
    const pending = yield* unavailable
      .execute("computer.action", { kind: "press", key: "enter" })
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    expect((yield* Fiber.join(pending))._tag).toBe("TimeoutError");
    expect(yield* unavailable.activity).toEqual({ activeOperations: 0, pendingCallbacks: 0 });
    const failed = yield* make((request) => {
      if (request.url.endsWith("/info")) return Response.json(desktopInfo);
      actions++;
      return new Response(null, { status: 503 });
    });
    expect(
      yield* failed.execute("computer.action", { kind: "press", key: "enter" }).pipe(Effect.flip),
    ).toMatchObject({ code: "computer_backend_failed" });
    expect(actions).toBe(1);
  }),
);

it.effect("counts an in-flight computer request until interruption finishes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const executor = yield* makeComputerExecutor.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { T3CODE_SANDBOX_COMPUTER_URL: "http://127.0.0.1:18091" } }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    );
    const request = yield* executor
      .execute("computer.action", { kind: "press", key: "enter" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* executor.activity).toEqual({ activeOperations: 1, pendingCallbacks: 0 });
    yield* Fiber.interrupt(request);
    expect(yield* executor.activity).toEqual({ activeOperations: 0, pendingCallbacks: 0 });
  }),
);
