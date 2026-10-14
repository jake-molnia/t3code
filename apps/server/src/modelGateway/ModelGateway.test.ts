// @effect-diagnostics nodeBuiltinImport:off -- Real upstream HTTP fixture verifies authentication and request serialization.
import * as NodeHttp from "node:http";
import { AuthSessionId, GatewayAccountId, ModelGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as ModelGateway from "./ModelGateway.ts";

const owner = AuthSessionId.make("owner");
const other = AuthSessionId.make("other");
const accountId = GatewayAccountId.make("account.json");
let groups: Array<Record<string, unknown>> = [];
let refreshCount = 0;
let failRefresh = false;
let status = "wait";
let disabled = false;
let removed = false;
let fail = false;
let callbackCount = 0;
let cancelCount = 0;
let currentState = "";
let requests: string[] = [];
let server: ReturnType<typeof NodeHttp.createServer>;
let url: string;

beforeEach(async () => {
  groups = [];
  refreshCount = 0;
  failRefresh = false;
  status = "wait";
  disabled = false;
  removed = false;
  fail = false;
  callbackCount = 0;
  cancelCount = 0;
  requests = [];
  server = NodeHttp.createServer(async (request, response) => {
    const target = new URL(request.url ?? "/", "http://localhost");
    requests.push(`${request.method} ${target.pathname}`);
    if (fail) {
      response.writeHead(503).end();
      return;
    }
    expect(request.headers.authorization).toBe(
      target.pathname === "/v1/models" ? "Bearer inference" : "Bearer management",
    );
    let payload: unknown;
    if (target.pathname.endsWith("config/api-keys/openai-compatibility")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      groups = JSON.parse(body);
      payload = { status: "ok" };
    } else if (target.pathname.endsWith("/config"))
      payload = { "api-keys": { "openai-compatibility": groups } };
    else if (target.pathname.endsWith("auth-url")) {
      currentState = `state-${requests.length}`;
      const device = target.searchParams.get("provider") === "codex";
      payload = {
        status: "ok",
        url: "https://login.example/device",
        state: currentState,
        ...(device ? { flow: "device", user_code: "ABCD-EFGH" } : {}),
      };
    } else if (target.pathname.endsWith("oauth/status")) payload = { status };
    else if (target.pathname.endsWith("oauth/session")) {
      cancelCount++;
      payload = { status: "ok", cancelled: status === "wait" };
    } else if (target.pathname.endsWith("oauth/callback")) {
      callbackCount++;
      status = "ok";
      payload = { status: "ok" };
    } else if (target.pathname.endsWith("credentials/status")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      disabled = JSON.parse(body).disabled;
      payload = { status: "ok" };
    } else if (target.pathname.endsWith("credentials") && request.method === "DELETE") {
      removed = true;
      payload = { status: "ok" };
    } else if (target.pathname.endsWith("credentials"))
      payload = {
        files: removed
          ? []
          : [
              {
                name: "account.json",
                provider: "codex",
                email: "person@example.com",
                disabled,
                status: "active",
                access_token: "never-send-this",
              },
            ],
      };
    else payload = { data: removed || disabled ? [] : [{ id: "cross-provider-model" }] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const run = <A>(
  f: (service: ModelGateway.ModelGateway["Service"]) => Effect.Effect<A, ModelGatewayError>,
) => Effect.flatMap(ModelGateway.ModelGateway, f);
const fixture = Layer.unwrap(
  Effect.sync(() =>
    ModelGateway.layerWithConfiguration(
      { url, managementKey: "management", apiKey: "inference" },
      Effect.sync(() => {
        refreshCount++;
        if (failRefresh) throw new Error("catalog unavailable");
      }),
    ),
  ),
);

describe("ModelGateway", () => {
  it.effect("expires abandoned enrollment without leaving an upstream login active", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      yield* TestClock.adjust("601 seconds");
      expect(yield* run((service) => service.status({ flowId: auth.flowId }, owner))).toMatchObject(
        { kind: "failed", reason: "expired" },
      );
      expect(cancelCount).toBe(1);
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("recognizes completion that won the race against local expiry", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      status = "ok";
      yield* TestClock.adjust("601 seconds");
      expect(yield* run((service) => service.status({ flowId: auth.flowId }, owner))).toMatchObject(
        { kind: "succeeded" },
      );
      expect(refreshCount).toBe(1);
    }).pipe(Effect.provide(fixture)),
  );

  it.effect("projects accounts without tokens and distinguishes an unavailable gateway", () =>
    Effect.gen(function* () {
      expect(yield* run((service) => service.snapshot())).toEqual({
        kind: "ready",
        accounts: [
          {
            id: accountId,
            provider: "codex",
            label: "person@example.com",
            disabled: false,
            status: "ready",
            message: null,
          },
        ],
        models: [{ id: "cross-provider-model" }],
      });
      fail = true;
      expect(yield* run((service) => service.snapshot())).toEqual({ kind: "unavailable" });
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("chooses device enrollment and tracks completion", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      expect(auth).toMatchObject({
        kind: "waiting",
        interaction: { type: "deviceCode", userCode: "ABCD-EFGH" },
      });
      status = "ok";
      expect(yield* run((service) => service.status({ flowId: auth.flowId }, owner))).toEqual({
        kind: "succeeded",
        flowId: auth.flowId,
      });
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("rejects another session and mismatched callback state before forwarding", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "claude" }, owner));
      expect(auth).toMatchObject({ interaction: { type: "browser", acceptsCallback: true } });
      expect(
        yield* run((service) => service.status({ flowId: auth.flowId }, other)).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-flow" });
      expect(
        yield* run((service) => service.cancel({ flowId: auth.flowId }, other)).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-flow" });
      expect(
        yield* run((service) =>
          service.complete(
            {
              flowId: auth.flowId,
              callbackUrl: "http://localhost/callback?state=wrong&code=secret",
            },
            owner,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-callback" });
      expect(callbackCount).toBe(0);
      expect(cancelCount).toBe(0);
      expect(
        yield* run((service) =>
          service.complete(
            {
              flowId: auth.flowId,
              callbackUrl: `http://localhost/callback?state=${currentState}&code=secret`,
            },
            owner,
          ),
        ),
      ).toMatchObject({ kind: "succeeded" });
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("cancels upstream and ignores late completion", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      expect(yield* run((service) => service.cancel({ flowId: auth.flowId }, owner))).toMatchObject(
        {
          kind: "cancelled",
        },
      );
      status = "ok";
      expect(yield* run((service) => service.status({ flowId: auth.flowId }, owner))).toMatchObject(
        {
          kind: "cancelled",
        },
      );
      expect(cancelCount).toBe(1);
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("shows success when upstream completion wins cancellation", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      status = "ok";
      expect(yield* run((service) => service.cancel({ flowId: auth.flowId }, owner))).toMatchObject(
        {
          kind: "succeeded",
        },
      );
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("allows retry after rejection and prevents duplicate pending enrollment", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      expect(
        yield* run((service) => service.start({ provider: "codex" }, owner)).pipe(Effect.flip),
      ).toMatchObject({ reason: "busy" });
      status = "error";
      expect(yield* run((service) => service.status({ flowId: auth.flowId }, owner))).toMatchObject(
        {
          kind: "failed",
          reason: "rejected",
        },
      );
      expect(yield* run((service) => service.start({ provider: "codex" }, owner))).toMatchObject({
        kind: "waiting",
      });
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("disables, enables, and removes an account with fresh models", () =>
    Effect.gen(function* () {
      expect(
        yield* run((service) => service.setEnabled({ accountId, enabled: false })),
      ).toMatchObject({ accounts: [{ disabled: true }], models: [] });
      expect(
        yield* run((service) => service.setEnabled({ accountId, enabled: true })),
      ).toMatchObject({
        accounts: [{ disabled: false }],
        models: [{ id: "cross-provider-model" }],
      });
      expect(yield* run((service) => service.remove({ accountId }))).toEqual({
        kind: "ready",
        accounts: [],
        models: [],
      });
    }).pipe(Effect.provide(fixture)),
  );
  it.effect(
    "creates endpoints concurrently without losing existing configuration and removes them durably",
    () =>
      Effect.gen(function* () {
        groups = [
          {
            name: "existing",
            "base-url": "https://old.example",
            keys: [{ "api-key": "retained" }],
            headers: { custom: "retained" },
          },
        ];
        yield* Effect.all(
          ["first", "second"].map((name) =>
            run((service) =>
              service.addEndpoint({
                name,
                baseUrl: "https://api.example/v1",
                apiKey: "secret",
                models: ["model-a"],
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(groups.map((group) => group.name)).toEqual(["existing", "first", "second"]);
        expect(groups[0]).toMatchObject({
          keys: [{ "api-key": "retained" }],
          headers: { custom: "retained" },
        });
        const id = GatewayAccountId.make("endpoint:first");
        expect(
          yield* run((service) => service.setEnabled({ accountId: id, enabled: false })),
        ).toMatchObject({
          accounts: expect.arrayContaining([
            {
              id,
              provider: "openai-compatible",
              label: "first",
              disabled: true,
              status: "ready",
              message: null,
            },
          ]),
        });
        expect(groups[1]).toMatchObject({ disabled: true });
        yield* run((service) => service.setEnabled({ accountId: id, enabled: true }));
        yield* run((service) => service.remove({ accountId: id }));
        expect(groups.map((group) => group.name)).toEqual(["existing", "second"]);
        expect(JSON.stringify(yield* run((service) => service.snapshot()))).not.toContain("secret");
        expect(refreshCount).toBe(5);
      }).pipe(Effect.provide(fixture)),
  );
  it.effect("rejects unsafe endpoint URLs without writing configuration", () =>
    Effect.gen(function* () {
      expect(
        yield* run((service) =>
          service.addEndpoint({
            name: "bad",
            baseUrl: "https://user:password@api.example",
            apiKey: "key",
            models: ["model"],
          }),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-endpoint" });
      expect(groups).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("does not report a committed mutation as failed when catalog refresh fails", () =>
    Effect.gen(function* () {
      failRefresh = true;
      expect(
        yield* run((service) => service.setEnabled({ accountId, enabled: false })),
      ).toMatchObject({ kind: "ready", accounts: [{ disabled: true }] });
      expect(refreshCount).toBe(1);
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("expires pending flows on central restart while saved accounts remain", () =>
    Effect.gen(function* () {
      const auth = yield* run((service) => service.start({ provider: "codex" }, owner));
      const restarted = ModelGateway.layerWithConfiguration({
        url,
        managementKey: "management",
        apiKey: "inference",
      });
      const error = yield* run((service) => service.status({ flowId: auth.flowId }, owner)).pipe(
        Effect.provide(restarted),
        Effect.flip,
      );
      expect(error.reason).toBe("invalid-flow");
      expect(
        yield* run((service) => service.snapshot()).pipe(Effect.provide(restarted)),
      ).toMatchObject({ kind: "ready", accounts: [{ id: accountId }] });
    }).pipe(Effect.provide(fixture)),
  );
});
