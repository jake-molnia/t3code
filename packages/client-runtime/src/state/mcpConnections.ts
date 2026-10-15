import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Connection credentials and project permissions belong to their destination environment. */
export function createMcpConnectionsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "mcp:list",
      tag: WS_METHODS.mcpConnectionsList,
    }),
    tools: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "mcp:tools",
      tag: WS_METHODS.mcpConnectionsTools,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "connect MCP",
      tag: WS_METHODS.mcpConnectionsConnect,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "disconnect MCP",
      tag: WS_METHODS.mcpConnectionsRemove,
      scheduler,
      concurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "refresh MCP tools",
      tag: WS_METHODS.mcpConnectionsRefresh,
      scheduler,
      concurrency,
    }),
    setAccess: createEnvironmentRpcCommand(runtime, {
      label: "save MCP project access",
      tag: WS_METHODS.mcpConnectionsSetAccess,
      scheduler,
      concurrency,
    }),
    completeAuth: createEnvironmentRpcCommand(runtime, {
      label: "complete MCP sign-in",
      tag: WS_METHODS.mcpConnectionsCompleteAuth,
      scheduler,
      concurrency,
    }),
  };
}
