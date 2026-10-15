import {
  AuthOrchestrationOperateScope,
  SandboxIdeError,
  type EnvironmentId,
  type SandboxIdeTarget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope, readPreparedConnection } from "./state/session";

export function useSandboxIde(
  environmentId: EnvironmentId | null,
  target: SandboxIdeTarget | null,
  cwd: string | null,
) {
  const open = useAtomCommand(shellEnvironment.openSandboxIde, "open VS Code");
  return useCallback(
    async (file?: string) => {
      if (
        !environmentId ||
        !target ||
        !cwd ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        return AsyncResult.failure(Cause.fail(new SandboxIdeError({ reason: "forbidden" })));
      }
      const connection = readPreparedConnection(environmentId);
      if (!connection)
        return AsyncResult.failure(Cause.fail(new SandboxIdeError({ reason: "unavailable" })));
      // Reserve the tab during the click/key event, before sandbox startup can yield.
      const tab = window.open("about:blank", "_blank");
      if (!tab)
        return AsyncResult.failure(Cause.fail(new SandboxIdeError({ reason: "unavailable" })));
      tab.opener = null;
      tab.document.title = "Opening VS Code";
      tab.document.body.textContent = "Starting the sandbox IDE…";
      const result = await open({
        environmentId,
        input: { target, cwd, ...(file ? { file } : {}) },
      });
      if (result._tag === "Success") {
        tab.location.replace(new URL(result.value.url, connection.httpBaseUrl).toString());
      } else {
        tab.close();
      }
      return result;
    },
    [cwd, environmentId, open, target],
  );
}
