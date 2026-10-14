import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    reason: Schema.Literals(["unavailable", "upstream", "invalid_input", "not_found", "oauth"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "The MCP connection service is unavailable.";
      case "upstream":
        return "The MCP service could not complete the request.";
      case "invalid_input":
        return "The MCP connection or tool selection is invalid.";
      case "not_found":
        return "The MCP connection or project was not found.";
      case "oauth":
        return "Sign-in could not be completed. Reconnect and try again.";
    }
  }
}

export const McpConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  account: Schema.NullOr(Schema.String),
});
export type McpConnection = typeof McpConnection.Type;
export const McpConnectionTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});
export const McpToolSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("all") }),
  Schema.Struct({ mode: Schema.Literal("selected"), toolIds: Schema.Array(Schema.String) }),
]);
export type McpToolSelection = typeof McpToolSelection.Type;
export const McpProjectAccess = Schema.Struct({
  projectId: ProjectId,
  connectionId: Schema.String,
  tools: McpToolSelection,
});
export const McpConnectionsState = Schema.Struct({
  available: Schema.Boolean,
  connections: Schema.Array(McpConnection),
  access: Schema.Array(McpProjectAccess),
});
export const McpConnectInput = Schema.Struct({
  connectionId: Schema.optionalKey(Schema.String),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  auth: Schema.Union([
    Schema.Struct({ type: Schema.Literal("none") }),
    Schema.Struct({
      type: Schema.Literal("token"),
      token: Schema.String.check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      type: Schema.Literal("oauth"),
      redirectUri: Schema.String,
      clientId: Schema.optionalKey(Schema.String),
      clientSecret: Schema.optionalKey(Schema.String),
    }),
  ]),
});
export type McpConnectInput = typeof McpConnectInput.Type;
export const McpConnectResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({
    status: Schema.Literal("authorize"),
    authorizationUrl: Schema.String,
    state: Schema.String,
  }),
]);
export const McpConnectionIdInput = Schema.Struct({ connectionId: Schema.String });
export const McpSetAccessInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1)),
  connectionId: Schema.String,
  tools: Schema.NullOr(McpToolSelection),
});
export type McpSetAccessInput = typeof McpSetAccessInput.Type;
export const McpCompleteAuthInput = Schema.Struct({ state: Schema.String, code: Schema.String });
