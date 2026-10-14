import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as C from "../../../../../packages/contracts/src/sandboxComputer.ts";
import * as P from "./Protocol.ts";

const Info = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    available: Schema.Boolean,
    display: Schema.NullOr(Schema.String),
    screen_resolution: C.SandboxComputerStatus.fields.resolution,
    capabilities: C.SandboxComputerStatus.fields.capabilities,
  }),
});
const ActionResponse = Schema.Struct({ success: Schema.Literal(true) });
const decodeInfo = Schema.decodeUnknownEffect(Info);
const decodeActionResponse = Schema.decodeUnknownEffect(ActionResponse);
const decodeScreenshot = Schema.decodeUnknownEffect(C.SandboxComputerScreenshot);
const decodeAction = Schema.decodeUnknownEffect(C.SandboxComputerAction);

const backendAction = (input: C.SandboxComputerAction) => {
  switch (input.kind) {
    case "move":
      return { action_type: "MOVE_TO", x: input.x, y: input.y };
    case "click":
      return {
        action_type: "CLICK",
        x: input.x,
        y: input.y,
        button: input.button ?? "left",
        num_clicks: input.clicks ?? 1,
      };
    case "drag":
      return { action_type: "DRAG_TO", x: input.x, y: input.y };
    case "type":
      return { action_type: "TYPING", text: input.text };
    case "press":
      return { action_type: "PRESS", key: input.key };
    case "hotkey":
      return { action_type: "HOTKEY", keys: input.keys };
    case "scroll":
      return { action_type: "SCROLL", dx: input.dx, dy: input.dy };
    case "wait":
      return { action_type: "WAIT", duration: input.seconds };
  }
};

/** Only the execution worker talks to the sandbox-owned desktop daemon. */
export const makeComputerExecutor = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const configured = yield* Config.option(Config.String("T3CODE_SANDBOX_COMPUTER_URL"));
  const request = Effect.fn("ComputerExecutor.request")(function* (path: string, body?: unknown) {
    if (Option.isNone(configured))
      return yield* new P.WorkspaceExecutionError({ code: "computer_unavailable" });
    const url = yield* Effect.try(() => new URL(configured.value));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
      return yield* new P.WorkspaceExecutionError({ code: "computer_endpoint_invalid" });
    const target = new URL(`/v2/computer/${path}`, url).toString();
    const outgoing =
      body === undefined
        ? HttpClientRequest.get(target)
        : yield* HttpClientRequest.bodyJson(HttpClientRequest.post(target), body);
    const response = yield* http.execute(outgoing);
    if (path === "info" && response.status === 503)
      return yield* new P.WorkspaceExecutionError({ code: "computer_backend_starting" });
    if (response.status < 200 || response.status >= 300)
      return yield* new P.WorkspaceExecutionError({ code: "computer_backend_failed" });
    return response;
  });
  const readInfo = request("info").pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeInfo),
  );
  const readinessLock = yield* Semaphore.make(1);
  let ready = false;
  const awaitReady = readinessLock.withPermit(
    Effect.gen(function* () {
      if (ready) return;
      yield* readInfo.pipe(
        Effect.flatMap(({ data }) =>
          data.available
            ? Effect.void
            : Effect.fail(new P.WorkspaceExecutionError({ code: "computer_backend_starting" })),
        ),
        Effect.timeout("2 seconds"),
        Effect.retry({
          schedule: Schedule.spaced("250 millis"),
          while: (error) =>
            error._tag === "TimeoutError" ||
            (error._tag === "HttpClientError" && error.reason._tag === "TransportError") ||
            (error._tag === "WorkspaceExecutionError" &&
              error.code === "computer_backend_starting"),
        }),
      );
      ready = true;
    }),
  );
  let activeOperations = 0;
  const execute = (method: string, raw: unknown) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        activeOperations++;
      }),
      () =>
        Effect.gen(function* () {
          switch (method) {
            case "computer.status": {
              yield* awaitReady;
              const { data } = yield* readInfo;
              return {
                available: data.available,
                display: data.display,
                resolution: data.screen_resolution,
                capabilities: data.capabilities,
              };
            }
            case "computer.screenshot": {
              yield* awaitReady;
              const response = yield* request("screenshot");
              const bytes = Buffer.from(yield* response.arrayBuffer);
              if (
                bytes.length < 24 ||
                bytes.length > 24_000_000 ||
                !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
                bytes.toString("ascii", 12, 16) !== "IHDR"
              )
                return yield* new P.WorkspaceExecutionError({
                  code: "computer_screenshot_invalid",
                });
              return yield* decodeScreenshot({
                screenshot: {
                  mimeType: "image/png",
                  data: bytes.toString("base64"),
                  width: bytes.readUInt32BE(16),
                  height: bytes.readUInt32BE(20),
                },
              });
            }
            case "computer.action": {
              const input = yield* decodeAction(raw);
              yield* awaitReady;
              const response = yield* request("actions", backendAction(input));
              yield* response.json.pipe(Effect.flatMap(decodeActionResponse));
              return { ok: true };
            }
            default:
              return yield* new P.WorkspaceExecutionError({ code: "unsupported_computer_method" });
          }
        }).pipe(Effect.timeout("30 seconds")),
      () =>
        Effect.sync(() => {
          activeOperations--;
        }),
    );
  return { execute, activity: Effect.sync(() => ({ activeOperations, pendingCallbacks: 0 })) };
});
