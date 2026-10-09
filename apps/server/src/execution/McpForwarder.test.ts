import { expect, test } from "@effect/vitest";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { createMcpForwarder } from "./McpForwarder.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

test("each session keeps its local credential while upstream auth rotates", async () => {
  const seen: Array<string | null> = [];
  const upstream = await listenWorker({
    host: "127.0.0.1",
    port: 0,
    handle: async (request) => {
      seen.push(request.headers.get("authorization"));
      return new Response(await request.text(), {
        headers: { "content-type": "application/json", "mcp-session-id": "remote-session" },
      });
    },
  });
  const forwarder = createMcpForwarder("http://worker");
  const config = {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: `http://127.0.0.1:${upstream.port}/mcp`,
    authorizationHeader: "Bearer old",
    browserToolsAvailable: false,
  };
  try {
    const local = forwarder.configure(config);
    const call = (authorization = local.authorizationHeader) =>
      forwarder.handle(
        new Request(local.endpoint, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: '{"id":1,"method":"tools/list"}',
        }),
      );
    const first = await call();
    expect(first.headers.get("mcp-session-id")).toBe("remote-session");
    expect(await first.json()).toEqual({ id: 1, method: "tools/list" });
    expect(
      forwarder.configure({ ...config, authorizationHeader: "Bearer renewed" }).authorizationHeader,
    ).toBe(local.authorizationHeader);
    await call();
    expect(seen).toEqual(["Bearer old", "Bearer renewed"]);
    expect((await call("Bearer another-session")).status).toBe(401);
    expect(seen).toHaveLength(2);
    forwarder.remove(config.providerSessionId);
    expect((await call()).status).toBe(401);
  } finally {
    forwarder.remove(config.providerSessionId);
    await upstream.close();
  }
});

test("Aperture MCP supplements central session routing without changing its credentials", () => {
  const forwarder = createMcpForwarder("http://worker", fetch, {
    APERTURE_UPSTREAM: "http://aperture",
    APERTURE_API_KEY: "private",
  });
  const local = forwarder.configure({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("aperture-thread"),
    providerSessionId: "provider",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://central/mcp",
    authorizationHeader: "Bearer central",
    browserToolsAvailable: true,
  });
  expect(local.additionalHttpServers).toEqual({
    aperture: { url: "http://aperture/v1/mcp", headers: { Authorization: "Bearer private" } },
  });
  expect(local.endpoint).toContain("http://worker/mcp/");
  expect(forwarder.upstreamForProvider(ProviderInstanceId.make("codex"))?.authorizationHeader).toBe(
    "Bearer central",
  );
  forwarder.remove("provider");
});
