import { type EnvironmentId, type SandboxIdeTarget } from "@t3tools/contracts";
import { mapAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import { useSandboxIde } from "./useSandboxIde";

export function useOpenSandboxFile(
  environmentId: EnvironmentId | null,
  workspace?: { target: SandboxIdeTarget; cwd: string },
) {
  const open = useSandboxIde(environmentId, workspace?.target ?? null, workspace?.cwd ?? null);
  return useCallback(
    async (file: string) => mapAtomCommandResult(await open(file), () => "vscode" as const),
    [open],
  );
}
