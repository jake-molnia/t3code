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
