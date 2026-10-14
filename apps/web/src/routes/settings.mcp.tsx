import { createFileRoute } from "@tanstack/react-router";
import { McpSettings } from "../components/settings/McpSettings";

export const Route = createFileRoute("/settings/mcp")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.code === "string" ? { mcpCode: search.code } : {}),
    ...(typeof search.state === "string" ? { mcpState: search.state } : {}),
    ...(typeof search.error === "string" ? { mcpError: search.error } : {}),
  }),
  component: McpSettings,
});
