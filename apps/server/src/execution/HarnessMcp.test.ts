import { expect, test } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createMcpForwarder } from "./McpForwarder.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { cursorMcpServers } from "@t3tools/provider-cursor/testing";

test("native launch configuration carries only the session-scoped T3 MCP", () => {
  const forwarder = createMcpForwarder("http://worker");
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
      "t3-code": {
        url: local.endpoint,
        http_headers: { Authorization: local.authorizationHeader },
      },
    });
    const claude = claudeMcpQueryOverrides({ mcpSession: local, readOnlySandbox: false });
    expect(Object.keys(claude.mcpServers ?? {})).toEqual(["t3-code"]);
    expect(claude.allowedTools).toContain("mcp__t3-code__*");
    expect(Object.keys(cursorMcpServers(local) ?? {})).toEqual(["t3-code"]);
  } finally {
    forwarder.remove("provider");
  }
});
