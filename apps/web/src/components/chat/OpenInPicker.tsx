import { useAtomValue } from "@effect/atom-react";
import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  SandboxIdeTarget,
} from "@t3tools/contracts";
import { memo } from "react";
import { VisualStudioCode } from "../Icons";
import { MenuItem, MenuItemLabel, MenuShortcut } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { shellEnvironment } from "../../state/shell";
import { useSandboxIde } from "../../useSandboxIde";
import { shortcutLabelForCommand } from "../../keybindings";
import { useOpenFavoriteEditorShortcut } from "./OpenInPickerShortcut";

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  target,
  file,
  keybindings,
  availableEditors,
  openInCwd,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
}: {
  environmentId: EnvironmentId;
  target: SandboxIdeTarget | null;
  file?: string;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: readonly EditorId[];
  openInCwd: string | null;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
}) {
  const open = useSandboxIde(environmentId, target, openInCwd);
  const canOpen = useAtomValue(shellEnvironment.openSandboxIde.permissionAtom(environmentId));
  useOpenFavoriteEditorShortcut({
    enabled: enableShortcut && canOpen,
    environmentId,
    target,
    keybindings,
    availableEditors,
    openInCwd,
  });
  const disabled = !canOpen || !target || !openInCwd;
  if (presentation === "menu")
    return (
      <MenuItem
        density="touch"
        disabled={disabled}
        onClick={() => {
          void open(file);
        }}
      >
        <VisualStudioCode />
        <MenuItemLabel>Open in VS Code</MenuItemLabel>
        <MenuShortcut>{shortcutLabelForCommand(keybindings, "editor.openFavorite")}</MenuShortcut>
      </MenuItem>
    );
  return (
    <ThreadDetailsControl
      aria-label="Open in VS Code"
      size={displayMode === "panel" ? "sm" : "xs"}
      variant={displayMode === "panel" ? "ghost" : "outline"}
      panel={displayMode === "panel"}
      disabled={disabled}
      onClick={() => {
        void open(file);
      }}
    >
      <VisualStudioCode />
      {!compact && <span>Open in VS Code</span>}
    </ThreadDetailsControl>
  );
});
