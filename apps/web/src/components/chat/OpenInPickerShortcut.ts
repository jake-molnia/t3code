import type {
  EditorId,
  EnvironmentId,
  SandboxIdeTarget,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { useSandboxIde } from "../../useSandboxIde";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  target,
  keybindings,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  target: SandboxIdeTarget | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: readonly EditorId[];
  openInCwd: string | null;
}) {
  const open = useSandboxIde(environmentId, target, openInCwd);
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!openInCwd || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      event.preventDefault();
      void open();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings, open, openInCwd]);
}
