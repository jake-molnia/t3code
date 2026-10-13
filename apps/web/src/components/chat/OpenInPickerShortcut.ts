import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useSandboxIde } from "../../useSandboxIde";
import { usePreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  threadId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const editors = useMemo<readonly EditorId[]>(
    () =>
      availableEditors.includes("vscode") ? availableEditors : ["vscode", ...availableEditors],
    [availableEditors],
  );
  const [preferredEditor] = usePreferredEditor(editors);
  const openSandboxIde = useSandboxIde(environmentId, threadId, openInCwd);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      if (preferredEditor === "vscode") {
        openSandboxIde();
        return;
      }
      void openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: preferredEditor,
        },
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    openInEditorMutation,
    openSandboxIde,
    preferredEditor,
  ]);
}
