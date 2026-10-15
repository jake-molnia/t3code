import {
  type ContextMenuItem,
  type EnvironmentId,
  type SandboxIdeTarget,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { readLocalApi } from "./localApi";
import { shellEnvironment } from "./state/shell";
import { useSandboxIde } from "./useSandboxIde";

export type FileContextMenuAction = "open";

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

/**
 * Absolute path on the sandbox for a diff-style target, resolving
 * repo-relative paths through the workspace root like every other diff
 * surface. Returns null when the path cannot be resolved, which callers must
 * treat as "no file actions available".
 */
export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

export function buildFileContextMenuItems(input: {
  hasAbsolutePath: boolean;
  canOpen: boolean;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  return input.hasAbsolutePath && input.canOpen
    ? [{ id: "open", label: "Open in VS Code", icon: "pencil" }]
    : [];
}

export function useFileContextMenu(
  environmentId: EnvironmentId | null,
  workspace: SandboxIdeTarget | null,
  cwd: string | null,
) {
  const open = useSandboxIde(environmentId, workspace, cwd);
  const allowed = useAtomValue(shellEnvironment.openSandboxIde.permissionAtom(environmentId));
  return useMemo(() => {
    const buildItems = (target: FileContextMenuTarget) =>
      buildFileContextMenuItems({
        hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
        canOpen:
          allowed && workspace !== null && cwd !== null && target.environmentId === environmentId,
      });
    const activate = async (_action: FileContextMenuAction, target: FileContextMenuTarget) => {
      const file = resolveFileContextMenuAbsolutePath(target);
      if (file && buildItems(target).length > 0) await open(file);
    };
    const show = async (target: FileContextMenuTarget, position?: { x: number; y: number }) => {
      const items = buildItems(target);
      if (!items.length) return;
      const clicked = await readLocalApi()?.contextMenu.show(items, position);
      if (clicked === "open") await activate(clicked, target);
    };
    return { buildItems, activate, show };
  }, [allowed, cwd, environmentId, open, workspace]);
}

export function useFileContextMenuHandler(
  environmentId: EnvironmentId | null,
  workspace: SandboxIdeTarget | null,
  cwd: string | null,
) {
  const contextMenu = useFileContextMenu(environmentId, workspace, cwd);
  return useCallback(
    (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
      void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
    },
    [contextMenu],
  );
}
