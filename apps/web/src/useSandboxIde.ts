import {
  AuthOrchestrationOperateScope,
  SandboxIdeError,
  type EnvironmentId,
  type SandboxIdeTarget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { appAtomRegistry } from "./rpc/atomRegistry";
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
      tab.document.body.textContent = "Opening the sandbox IDE…";
      const setup = shellEnvironment.ideSetup({ environmentId, input: { target } });
      const stopStatus = appAtomRegistry.subscribe(setup, (value) => {
        if (tab.closed || value._tag !== "Success") return;
        const labels = {
          not_opened: "Opening the sandbox IDE…",
          waking: "Waking the sandbox…",
          applying_settings: "Applying saved VS Code settings…",
          restoring_extensions: "Restoring saved extensions…",
          starting: "Starting VS Code…",
          ready: "VS Code is ready…",
          ready_with_errors: "Opening VS Code with incomplete extension setup…",
          unavailable: "The sandbox IDE is unavailable.",
        };
        try {
          tab.document.body.textContent = labels[value.value.stage];
        } catch {
          // The user may have navigated the reserved tab to another origin.
        }
      });
      appAtomRegistry.refresh(setup);
      const result = await open({
        environmentId,
        input: { target, cwd, ...(file ? { file } : {}) },
      });
      stopStatus();
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
