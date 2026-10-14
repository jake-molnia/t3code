import { createMcpConnectionsAtoms } from "@t3tools/client-runtime/state/mcp-connections";
import { connectionAtomRuntime } from "../connection/runtime";

export const mcpConnections = createMcpConnectionsAtoms(connectionAtomRuntime);
