import { expect, test } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createMcpForwarder } from "./McpForwarder.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { cursorMcpServers } from "@t3tools/provider-cursor/testing";

test("native launch configuration carries Aperture and independently authenticated T3 MCP", () => {
  const forwarder = createMcpForwarder("http://worker", fetch, {
    APERTURE_UPSTREAM: "http://aperture",
    APERTURE_API_KEY: "aperture-key",
  });
  const threadId = ThreadId.make("native-mcp-launch");
  const local = forwarder.configure({
    environmentId: EnvironmentId.make("env"),
    threadId,
    providerSessionId: "provider",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://central/mcp",
    authorizationHeader: "Bearer central",
    browserToolsAvailable: true,
  });
  try {
    expect(codexThreadRuntimeParams({ mcpSession: local }).config.mcp_servers).toEqual({
      aperture: {
        url: "http://aperture/v1/mcp",
        http_headers: { Authorization: "Bearer aperture-key" },
      },
      "t3-code": {
        url: local.endpoint,
        http_headers: { Authorization: local.authorizationHeader },
      },
    });
    const claude = claudeMcpQueryOverrides({ mcpSession: local, readOnlySandbox: false });
    expect(claude.mcpServers?.aperture).toEqual({
      type: "http",
      url: "http://aperture/v1/mcp",
      headers: { Authorization: "Bearer aperture-key" },
    });
    expect(claude.allowedTools).toContain("mcp__aperture__*");
    expect(cursorMcpServers(local)?.aperture).toEqual({
      type: "http",
      url: "http://aperture/v1/mcp",
      headers: { Authorization: "Bearer aperture-key" },
    });
  } finally {
    forwarder.remove("provider");
  }
});
