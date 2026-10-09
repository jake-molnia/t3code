import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope, readPreparedConnection } from "./state/session";

export function useSandboxIde(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string | null,
) {
  const open = useAtomCommand(shellEnvironment.openSandboxIde, "open VS Code");
  return useCallback(() => {
    if (!cwd || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const connection = readPreparedConnection(environmentId);
    if (!connection) return;
    // Reserve the tab inside the click/key event so slow sandbox startup cannot trigger popup blocking.
    const tab = window.open("about:blank", "_blank");
    if (!tab) return;
    tab.opener = null;
    tab.document.title = "Opening VS Code";
    tab.document.body.textContent = "Starting the sandbox IDE…";
    void open({ environmentId, input: { threadId, cwd } }).then((result) => {
      if (result._tag === "Success") {
        tab.location.replace(new URL(result.value.url, connection.httpBaseUrl).toString());
      } else {
        tab.close();
      }
    });
  }, [cwd, environmentId, open, threadId]);
}
