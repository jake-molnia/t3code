import { hydrateCachedProvider } from "../provider/providerStatusCache.ts";
import * as Schema from "effect/Schema";
import { ServerProvider } from "@t3tools/contracts";
import { mergeProviderSnapshot } from "../provider/ProviderRegistry.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Integration test of retained native harness files.
import { expect, test } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import {
  createModelGatewayCatalog,
  nativeGatewayConfigs,
  projectGatewaySnapshot,
} from "./ModelGatewayCatalog.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

const decodeSnapshot = Schema.decodeSync(ServerProvider);

const snapshot = (driver: string) => ({
  ...buildServerProvider({
    presentation: { displayName: driver },
    enabled: true,
    checkedAt: "2026-10-14T00:00:00Z",
    probe: {
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
    },
    models: [{ slug: "native-model", name: "Native", isCustom: false, capabilities: null }],
  }),
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
});

test.each(["codex", "claudeAgent", "grok", "opencode", "pi"])(
  "%s offers gateway models absent from the native catalog",
  (driver) => {
    const projected = projectGatewaySnapshot(snapshot(driver), {
      kind: "ready",
      catalog: { data: [{ id: "cross-provider-model", owned_by: "other" }] },
    });
    expect(projected.models.map((model) => model.slug)).toEqual([
      driver === "opencode" || driver === "pi"
        ? "gateway/cross-provider-model"
        : "cross-provider-model",
    ]);
    expect(projected.models[0]?.capabilities).toBeNull();
    expect(projected.setup?.canAuthenticate).toBe(false);
  },
);

test.each(["cursor", "muse", "antigravity"])(
  "%s remains explicitly unsupported with gateway credentials",
  (driver) => {
    const projected = projectGatewaySnapshot(snapshot(driver), {
      kind: "ready",
      catalog: { data: [{ id: "model" }] },
    });
    expect(projected.availability).toBe("unavailable");
    expect(projected.models).toEqual([]);
  },
);

test("gateway native files reference the inference key and contain one route per model", () => {
  const configs = nativeGatewayConfigs(
    { data: [{ id: "claude-model" }, { id: "gpt-model" }] },
    "http://head:3773/api/model-gateway",
  );
  expect(configs.opencode.providers.gateway.settings).toEqual({
    baseURL: "http://head:3773/api/model-gateway/v1",
    apiKey: "{env:T3_GATEWAY_API_KEY}",
  });
  expect(configs.pi.providers.gateway.apiKey).toBe("${T3_GATEWAY_API_KEY}");
  expect(configs.pi.providers.gateway.models.map((model) => model.id)).toEqual([
    "claude-model",
    "gpt-model",
  ]);
});

test("a running worker discovers added accounts, removes stale models, and recovers after an outage", async () => {
  let ids: string[] = [];
  let unavailable = false;
  const seen: string[] = [];
  const server = await listenWorker({
    host: "127.0.0.1",
    port: 0,
    handle: async (request) => {
      seen.push(new URL(request.url).pathname);
      expect(request.headers.get("authorization")).toBe("Bearer inference-key");
      return unavailable
        ? new Response(null, { status: 503 })
        : Response.json({
            object: "list",
            data: ids.map((id) => ({ id, object: "model", owned_by: "provider" })),
          });
    },
  });
  const directory = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-gateway-catalog-`);
  const gateway = createModelGatewayCatalog({
    directory,
    environment: {
      T3_GATEWAY_URL: `http://127.0.0.1:${server.port}/api/model-gateway`,
      T3_GATEWAY_API_KEY: "inference-key",
    },
  });
  try {
    await gateway.refresh();
    expect(gateway.snapshot(snapshot("codex")).unavailableReason).toContain("Connect an account");
    await expect(gateway.prepareInference("codex", "new-model")).rejects.toThrow(
      "Connect an account",
    );
    ids = ["new-model"];
    await gateway.prepareInference("codex", "new-model");
    expect(gateway.snapshot(snapshot("codex")).models.map((model) => model.slug)).toEqual(ids);
    expect(
      JSON.parse(await NodeFSP.readFile(`${directory}/pi/models.json`, "utf8")).providers.gateway
        .models[0].id,
    ).toBe("new-model");
    await expect(gateway.prepareInference("pi", "native-model")).rejects.toThrow(
      "no longer available",
    );
    ids = [];
    await gateway.refresh();
    expect(gateway.snapshot(snapshot("codex")).models).toEqual([]);
    unavailable = true;
    await expect(gateway.prepareInference("codex", "new-model")).rejects.toThrow(
      "gateway is unavailable",
    );
    expect(gateway.snapshot(snapshot("codex")).models).toEqual([]);
    unavailable = false;
    ids = ["replacement-model"];
    await gateway.prepareInference("opencode", "gateway/replacement-model");
    expect(gateway.snapshot(snapshot("opencode")).models[0]?.slug).toBe(
      "gateway/replacement-model",
    );
    expect(new Set(seen)).toEqual(new Set(["/api/model-gateway/v1/models"]));
  } finally {
    await server.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

test("independent worker catalogs do not share account models or failures", async () => {
  const directory = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-gateway-isolation-`);
  const environment = {
    T3_GATEWAY_URL: "http://head/api/model-gateway",
    T3_GATEWAY_API_KEY: "key",
  };
  const a = createModelGatewayCatalog({
    directory: `${directory}/a`,
    environment,
    request: async () => Response.json({ data: [{ id: "a" }] }),
  });
  const b = createModelGatewayCatalog({
    directory: `${directory}/b`,
    environment,
    request: async () => new Response(null, { status: 503 }),
  });
  try {
    await Promise.all([a.refresh(), b.refresh()]);
    expect(a.snapshot(snapshot("codex")).models[0]?.slug).toBe("a");
    expect(b.snapshot(snapshot("codex")).models).toEqual([]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

test("gateway entries keep native metadata without retaining custom-model ownership", () => {
  const current = {
    ...snapshot("codex"),
    models: [{ slug: "shared-model", name: "Useful label", isCustom: true, capabilities: null }],
  };
  const next = projectGatewaySnapshot(current, {
    kind: "ready",
    catalog: { data: [{ id: "shared-model" }] },
  });
  expect(next.models).toEqual([{ ...current.models[0], isCustom: false }]);
});
test.each(["pi", "grok", "claudeAgent"])(
  "%s replaces its central inventory after gateway removal",
  (driver) => {
    const initial = projectGatewaySnapshot(snapshot(driver), {
      kind: "ready",
      catalog: { data: [{ id: "keep" }, { id: "remove" }] },
    });
    const refreshed = decodeSnapshot(
      projectGatewaySnapshot(snapshot(driver), {
        kind: "ready",
        catalog: { data: [{ id: "keep" }] },
      }),
    );
    const merged = mergeProviderSnapshot(initial, refreshed);
    expect(merged.models.map((model) => model.slug)).toEqual([
      driver === "pi" ? "gateway/keep" : "keep",
    ]);
    const unavailable = decodeSnapshot(
      projectGatewaySnapshot(snapshot(driver), { kind: "unavailable" }),
    );
    expect(mergeProviderSnapshot(merged, unavailable).models).toEqual([]);
  },
);
test("gateway authentication replaces a stale native Pi sign-in warning", () => {
  const current: ServerProvider = {
    ...snapshot("pi"),
    status: "warning",
    auth: { status: "unauthenticated" },
    message: "Sign in to Pi.",
  };
  const next = projectGatewaySnapshot(current, {
    kind: "ready",
    catalog: { data: [{ id: "connected" }] },
  });
  expect(next.auth.status).toBe("authenticated");
  expect(next.status).toBe("ready");
  expect(next.message).toBeUndefined();
});
test("gateway authentication preserves executable and launch failures", () => {
  const failure: ServerProvider = {
    ...snapshot("pi"),
    status: "error",
    auth: { status: "unknown" },
    message: "Pi CLI failed to run.",
  };
  const next = projectGatewaySnapshot(failure, {
    kind: "ready",
    catalog: { data: [{ id: "connected" }] },
  });
  expect(next.status).toBe("error");
  expect(next.message).toBe(failure.message);
  expect(
    projectGatewaySnapshot(
      { ...failure, installed: false },
      { kind: "ready", catalog: { data: [{ id: "connected" }] } },
    ).installed,
  ).toBe(false);
});

test("cached complete gateway inventories do not regain native models during restart", () => {
  const native = snapshot("pi");
  const cached = projectGatewaySnapshot(native, {
    kind: "ready",
    catalog: { data: [{ id: "keep" }] },
  });
  const hydrated = hydrateCachedProvider({
    cachedProvider: decodeSnapshot(cached),
    fallbackProvider: native,
  });
  expect(hydrated.models.map((model) => model.slug)).toEqual(["gateway/keep"]);
  expect(hydrated.modelsComplete).toBe(true);
});

test("OpenCode's generated registry preserves discovered image support without guessing unknown models", async () => {
  const directory = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-gateway-images-`);
  const gateway = createModelGatewayCatalog({
    directory,
    environment: { T3_GATEWAY_URL: "http://head/api/model-gateway", T3_GATEWAY_API_KEY: "key" },
    request: async () =>
      Response.json({
        data: [{ id: "vision", supported_input_modalities: ["TEXT", "IMAGE"] }, { id: "unknown" }],
      }),
  });
  try {
    await gateway.refresh();
    const written = JSON.parse(await NodeFSP.readFile(`${directory}/opencode2.json`, "utf8"));
    expect(written.providers.gateway.models.vision.capabilities.input).toEqual(["text", "image"]);
    expect(written.providers.gateway.models.unknown.capabilities.input).toEqual(["text"]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

test("Pi refresh makes the deployment credential authoritative without touching other accounts", async () => {
  const directory = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-pi-credential-`);
  await NodeFSP.mkdir(`${directory}/pi`);
  const other = { type: "oauth", refresh: "unrelated-refresh", access: "unrelated-access" };
  const gateway = createModelGatewayCatalog({
    directory,
    environment: { T3_GATEWAY_URL: "http://head", T3_GATEWAY_API_KEY: "current-deployment-key" },
    request: async () => Response.json({ data: [{ id: "model" }] }),
  });
  try {
    for (const stale of ["stale-key", "another-stale-key"]) {
      await NodeFSP.writeFile(
        `${directory}/pi/auth.json`,
        JSON.stringify({ gateway: { type: "api_key", key: stale }, other }),
      );
      await gateway.prepareInference("pi", "gateway/model");
      const saved = JSON.parse(await NodeFSP.readFile(`${directory}/pi/auth.json`, "utf8"));
      expect(saved).toEqual({ gateway: { type: "api_key", key: "${T3_GATEWAY_API_KEY}" }, other });
      expect(JSON.stringify(saved)).not.toContain("current-deployment-key");
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
test("Pi generated models keep known text and image modalities", () => {
  const result = nativeGatewayConfigs(
    {
      data: [
        { id: "vision", supported_input_modalities: ["TEXT", "IMAGE", "AUDIO"] },
        { id: "unknown" },
      ],
    },
    "http://head",
  );
  expect(result.pi.providers.gateway.models[0]).toMatchObject({ input: ["text", "image"] });
  expect(result.pi.providers.gateway.models[1]).toMatchObject({ input: ["text"] });
});
test("saved Pi default resolves its configured available model before catalog admission", async () => {
  const directory = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-pi-default-`);
  await NodeFSP.mkdir(`${directory}/pi`);
  await NodeFSP.writeFile(
    `${directory}/pi/settings.json`,
    JSON.stringify({ defaultProvider: "gateway", defaultModel: "preferred", theme: "dark" }),
  );
  const gateway = createModelGatewayCatalog({
    directory,
    environment: { T3_GATEWAY_URL: "http://head", T3_GATEWAY_API_KEY: "key" },
    request: async () => Response.json({ data: [{ id: "other" }, { id: "preferred" }] }),
  });
  try {
    await gateway.prepareInference("pi", "default");
    expect(
      gateway.normalizeSelection("pi", {
        instanceId: ProviderInstanceId.make("pi"),
        model: "default",
      }).model,
    ).toBe("gateway/preferred");
    const noSettings = createModelGatewayCatalog({
      directory: `${directory}/new`,
      environment: { T3_GATEWAY_URL: "http://head", T3_GATEWAY_API_KEY: "key" },
      request: async () => Response.json({ data: [{ id: "available" }] }),
    });
    await noSettings.prepareInference("pi", "default");
    expect(
      noSettings.normalizeSelection("pi", {
        instanceId: ProviderInstanceId.make("pi"),
        model: "default",
      }).model,
    ).toBe("gateway/available");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
