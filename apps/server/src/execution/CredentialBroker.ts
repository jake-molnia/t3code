import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Runtime from "../agentRuntime/RuntimeClient.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { CodexAccess } from "./credentialSources.ts";

export const PATH = "/internal/execution/provider-access";
const Input = Schema.Struct({ threadId: C.ThreadId, instanceId: C.ProviderInstanceId });
const Configuration = Schema.Struct({
  instanceId: C.ProviderInstanceId,
  config: C.ProviderInstanceConfig,
  settings: C.ServerSettings,
});
const decodeInput = Schema.decodeUnknownOption(Input);
const encodeConfiguration = Schema.encodeEffect(Schema.toCodecJson(Configuration));
const decodeAccess = Schema.decodeUnknownEffect(CodexAccess);
const rejected = (status: number) => ({ status, body: { error: "Provider access unavailable" } });

/** Resolves the owner for every access so retained credentials survive utility worker replacement. */
export const access = Effect.fn("CredentialBroker.access")(function* (
  authorization: string | undefined,
  body: unknown,
) {
  if (!authorization?.startsWith("Bearer ")) return rejected(401);
  const sessions = yield* Sessions.McpSessionRegistry;
  const scope = yield* sessions.resolve(authorization.slice("Bearer ".length));
  if (!scope) return rejected(401);
  const decoded = decodeInput(body);
  if (decoded._tag === "None") return rejected(400);
  const input = decoded.value;
  if (
    scope.thread.threadId !== input.threadId ||
    scope.thread.providerInstanceId !== input.instanceId ||
    !scope.capabilities.has("orchestration")
  )
    return rejected(403);
  const registry = yield* Registry.ProviderInstanceRegistry;
  const instance = yield* registry.getInstance(input.instanceId);
  if (!instance?.enabled || instance.driverKind !== "codex") return rejected(403);
  const runtime = yield* Runtime.RuntimeClient;
  const settings = yield* Settings.ServerSettingsService;
  return yield* Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const config = current.providerInstances[input.instanceId] ?? { driver: instance.driverKind };
    const encoded = yield* encodeConfiguration({
      instanceId: input.instanceId,
      config,
      settings: current,
    });
    const owner = yield* runtime.forUtility(input.instanceId);
    yield* Effect.tryPromise(() => owner.transient("configureProvider", encoded));
    const grant = yield* Effect.tryPromise(() =>
      owner.transient("auth.executionCredentials", {
        instanceId: input.instanceId,
        input: null,
      }),
    ).pipe(Effect.flatMap(decodeAccess));
    return { status: 200, body: grant };
  }).pipe(Effect.catch(() => Effect.succeed(rejected(503))));
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | Runtime.RuntimeClient
      | Sessions.McpSessionRegistry
      | Registry.ProviderInstanceRegistry
      | Settings.ServerSettingsService
    >();
    return HttpRouter.add(
      "POST",
      PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const result = yield* access(request.headers.authorization, body).pipe(
          Effect.provide(services),
        );
        return yield* HttpServerResponse.json(result.body, {
          status: result.status,
          headers: { "cache-control": "no-store" },
        }).pipe(Effect.orDie);
      }),
    );
  }),
);
