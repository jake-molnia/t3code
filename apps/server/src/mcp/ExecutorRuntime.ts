import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

export class ExecutorRuntimeError extends Schema.TaggedError<ExecutorRuntimeError>()(
  "ExecutorRuntimeError",
  {
    operation: Schema.String,
  },
) {
  override get message() {
    return `The MCP connection service could not ${this.operation}.`;
  }
}

export class ExecutorRuntime extends Context.Service<
  ExecutorRuntime,
  {
    readonly request: (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, ExecutorRuntimeError>;
    readonly callTool: (
      toolkitSlug: string,
      sessionKey: string,
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<unknown, ExecutorRuntimeError>;
    readonly status: Effect.Effect<{ readonly available: boolean }>;
  }
>()("t3/mcp/ExecutorRuntime") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ApiKey = Schema.Struct({ value: Schema.String });
const isRuntimeError = Schema.is(ExecutorRuntimeError);
const failure = (operation: string) => new ExecutorRuntimeError({ operation });

const reservePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const socket = NodeNet.createServer();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        if (!address || typeof address === "string") {
          socket.close();
          reject(new Error("No loopback port"));
          return;
        }
        socket.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    }),
  catch: () => failure("allocate its loopback listener"),
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fetch = yield* FetchHttpClient.Fetch;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const runtimeDir = env.T3_EXECUTOR_RUNTIME_DIR;
  const sessions = new Map<
    string,
    { client: Promise<Client>; lastUsed: number; active: number; retired: boolean }
  >();
  let running: {
    child: ChildProcessSpawner.ChildProcessHandle;
    origin: string;
    key: string;
  } | null = null;

  const closeSessions = Effect.promise(async () => {
    const clients = [...sessions.values()].map((entry) => entry.client);
    sessions.clear();
    await Promise.all(
      clients.map((client) => client.then((value) => value.close()).catch(() => undefined)),
    );
  });
  yield* Effect.addFinalizer(() => closeSessions);

  const fetchResponse = (url: string, init: RequestInit) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }),
      catch: () => failure("reach its local runtime"),
    });
  const readJson = (response: Response) =>
    response.ok
      ? Effect.tryPromise({
          try: () => (response.status === 204 ? Promise.resolve(null) : response.json()),
          catch: () => failure("decode the runtime response"),
        })
      : Effect.fail(failure(`complete a request (HTTP ${response.status})`));

  const start = Effect.gen(function* () {
    if (!runtimeDir || !(yield* fs.exists(path.join(runtimeDir, "t3-supervisor.mjs"))))
      return yield* failure("start; the runtime is not installed");
    const passwordBytes = yield* secrets.getOrCreateRandom("executor-bootstrap-password", 32);
    const password = Buffer.from(passwordBytes).toString("hex");
    const dataDir = path.join(config.stateDir, "executor");
    yield* fs.makeDirectory(dataDir, { recursive: true, mode: 0o700 });
    const port = yield* reservePort;
    const origin = `http://127.0.0.1:${port}`;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          env.T3_EXECUTOR_BUN ?? "/opt/executor/bin/bun",
          [path.join(runtimeDir, "t3-supervisor.mjs")],
          {
            cwd: runtimeDir,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
            env: {
              PATH: env.PATH,
              HOME: dataDir,
              NODE_ENV: "production",
              EXECUTOR_HOST: "127.0.0.1",
              PORT: String(port),
              EXECUTOR_DATA_DIR: dataDir,
              EXECUTOR_WEB_BASE_URL: origin,
              EXECUTOR_BOOTSTRAP_ADMIN_EMAIL: "t3-head@localhost.local",
              EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD: password,
              EXECUTOR_BOOTSTRAP_ADMIN_NAME: "T3",
              EXECUTOR_ORGANIZATION_NAME: "T3",
              EXECUTOR_ALLOW_STDIO_MCP: "false",
              EXECUTOR_ALLOW_LOCAL_NETWORK:
                env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true" ? "true" : "false",
              DO_NOT_TRACK: "1",
            },
          },
        ),
      )
      .pipe(Effect.provideService(Scope.Scope, scope));
    const bootstrap = Effect.gen(function* () {
      yield* fetchResponse(`${origin}/api/health`, { method: "GET" }).pipe(
        Effect.flatMap((response) =>
          response.ok ? Effect.void : Effect.fail(failure("become ready")),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
        Effect.timeout("20 seconds"),
      );
      const savedKey = yield* secrets.get("executor-management-key");
      if (Option.isSome(savedKey)) {
        const key = new TextDecoder().decode(savedKey.value);
        const response = yield* fetchResponse(`${origin}/api/account/me`, {
          headers: { "x-api-key": key },
        });
        if (response.ok) return { child, origin, key };
        if (response.status !== 401 && response.status !== 403)
          return yield* failure("validate its management credential");
      }
      const signIn = yield* fetchResponse(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: encodeJson({ email: "t3-head@localhost.local", password }),
      });
      const token = signIn.headers.get("set-auth-token");
      if (!signIn.ok || !token)
        return yield* failure(
          `authenticate its management account (HTTP ${signIn.status}; token ${token ? "present" : "missing"})`,
        );
      const response = yield* fetchResponse(`${origin}/api/account/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin },
        body: encodeJson({ name: "T3 head" }),
      });
      const { value: key } = yield* readJson(response).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ApiKey)),
      );
      yield* secrets.set("executor-management-key", new TextEncoder().encode(key));
      return { child, origin, key };
    });
    return yield* bootstrap.pipe(Effect.onError(() => child.kill().pipe(Effect.ignore)));
  }).pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : failure("start its managed runtime"),
    ),
  );

  const ensure = lock
    .withPermit(
      Effect.gen(function* () {
        if (running && (yield* running.child.isRunning)) return running;
        running = null;
        yield* closeSessions;
        running = yield* start;
        return running;
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        isRuntimeError(error) ? error : failure("start its managed runtime"),
      ),
    );

  const request: ExecutorRuntime["Service"]["request"] = Effect.fn("ExecutorRuntime.request")(
    function* (method, route, body) {
      if (!route.startsWith("/api/") || route.includes("\\"))
        return yield* failure("route an invalid management request");
      const runtime = yield* ensure;
      const url = new URL(route, runtime.origin);
      if (url.origin !== runtime.origin || !url.pathname.startsWith("/api/"))
        return yield* failure("route an invalid management request");
      const response = yield* fetchResponse(url.href, {
        method,
        headers: { "content-type": "application/json", "x-api-key": runtime.key },
        ...(body === undefined ? {} : { body: encodeJson(body) }),
      });
      return yield* readJson(response);
    },
  );

  const callTool: ExecutorRuntime["Service"]["callTool"] = Effect.fn("ExecutorRuntime.callTool")(
    function* (toolkitSlug, sessionKey, name, args) {
      if (!toolkitSlug || !sessionKey) return yield* failure("resolve the agent's project");
      const runtime = yield* ensure;
      const key = encodeJson([toolkitSlug, sessionKey]);
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: async (signal) => {
          for (const [id, entry] of sessions) {
            if (entry.active === 0 && now - entry.lastUsed > 30 * 60_000) {
              sessions.delete(id);
              await entry.client.then((client) => client.close()).catch(() => undefined);
            }
          }
          let entry = sessions.get(key);
          if (!entry) {
            if (sessions.size >= 512) throw failure("open more concurrent tool sessions");
            const client = new Client(
              { name: "t3-executor", version: "1.0.0" },
              { capabilities: {} },
            );
            const transport = new StreamableHTTPClientTransport(
              new URL(
                `/mcp/toolkits/${encodeURIComponent(toolkitSlug)}?elicitation_mode=model`,
                runtime.origin,
              ),
              {
                requestInit: { headers: { authorization: `Bearer ${runtime.key}` } },
                fetch,
              },
            );
            // The SDK exposes sessionId as string | undefined while its Transport contract
            // declares an optional string. The wire transport owns that session value.
            const protocolTransport: Transport = {
              start: () => transport.start(),
              send: (message, options) => transport.send(message, options),
              close: () => transport.close(),
              setProtocolVersion: (version) => transport.setProtocolVersion(version),
            };
            // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties.
            transport.onclose = () => {
              if (sessions.get(key) === entry) sessions.delete(key);
              protocolTransport.onclose?.();
            };
            // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties.
            transport.onerror = (error) => {
              // A missing upstream session needs a new handshake. Let other requests finish
              // before closing its client; request cancellation is never session invalidation.
              if (error instanceof StreamableHTTPError && error.code === 404 && entry) {
                entry.retired = true;
                if (sessions.get(key) === entry) sessions.delete(key);
                if (entry.active === 0)
                  void entry.client.then((value) => value.close()).catch(() => undefined);
              }
              protocolTransport.onerror?.(error);
            };
            // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties.
            transport.onmessage = (message) => protocolTransport.onmessage?.(message);
            entry = {
              client: client
                .connect(protocolTransport)
                .then(() => client)
                .catch(async (error: unknown) => {
                  if (sessions.get(key) === entry) sessions.delete(key);
                  await client.close().catch(() => undefined);
                  throw error;
                }),
              lastUsed: now,
              active: 0,
              retired: false,
            };
            sessions.set(key, entry);
          }
          entry.lastUsed = now;
          entry.active++;
          try {
            const client = await entry.client;
            return await client.callTool({ name, arguments: args }, undefined, {
              signal,
              timeout: 360_000,
            });
          } finally {
            entry.active--;
            if (entry.active === 0 && entry.retired)
              await entry.client.then((value) => value.close()).catch(() => undefined);
          }
        },
        catch: () => failure("run the project tool"),
      });
    },
  );

  return ExecutorRuntime.of({
    request,
    callTool,
    status: ensure.pipe(
      Effect.as({ available: true }),
      Effect.orElseSucceed(() => ({ available: false })),
    ),
  });
});

export const layer = Layer.effect(ExecutorRuntime, make);
