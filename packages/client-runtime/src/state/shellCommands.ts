import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createShellEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    ideSetup: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shell:ide-setup",
      tag: WS_METHODS.sandboxIdeSetupGet,
      refreshIntervalMs: 5000,
    }),
    manageIdeSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:manage-ide-setup",
      tag: WS_METHODS.sandboxIdeSetupManage,
    }),
    exportIdeSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:export-ide-setup",
      tag: WS_METHODS.sandboxIdeSetupExport,
    }),
    idePreferenceStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shell:ide-preference-status",
      tag: WS_METHODS.sandboxIdePreferenceStatus,
      refreshIntervalMs: 5000,
    }),
    resolveIdePreference: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:resolve-ide-preference",
      tag: WS_METHODS.sandboxIdePreferenceResolve,
    }),
    openSandboxIde: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-sandbox-ide",
      tag: WS_METHODS.sandboxIdeOpen,
    }),
  };
}
