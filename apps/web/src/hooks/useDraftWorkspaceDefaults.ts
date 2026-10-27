import { useEffect } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ServerConfig } from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { readThreadShells, useProjects, useServerConfigs } from "../state/entities";

export async function resolveDraftWorkspaceDefaults(input: {
  draftId: DraftId;
  project: EnvironmentProject;
  config: Pick<ServerConfig, "settings" | "newProjectsRoot">;
  signal: AbortSignal;
}): Promise<void> {
  const { draftId, project, config, signal } = input;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  const pending = draft?.pendingWorkspaceDefaults;
  if (
    !draft ||
    !pending ||
    draft.environmentId !== project.environmentId ||
    draft.projectId !== project.id
  )
    return;
  const settings = resolveProjectSettings(config.settings, project.id, project);
  const file =
    settings.settings.defaultThreadEnvMode === null
      ? await readT3ProjectFile(project.environmentId, project.workspaceRoot, { signal })
      : null;
  if (signal.aborted) return;
  const envMode = resolveNewThreadEnvMode({
    projectSettings: resolveProjectSettings(config.settings, project.id, project, file),
    workspaceRoot: project.workspaceRoot,
    newProjectsRoot: config.newProjectsRoot,
    projectHasThreads: readThreadShells().some(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    ),
  });
  useComposerDraftStore.getState().resolveDraftWorkspaceDefaults(
    draftId,
    {
      pending,
      projectRef: { environmentId: project.environmentId, projectId: project.id },
    },
    {
      envMode,
      startFromOrigin:
        pending.startFromOrigin ??
        resolveNewDraftStartFromOrigin({
          envMode,
          newWorktreesStartFromOrigin: settings.settings.newWorktreesStartFromOrigin,
        }),
    },
  );
}

/** The draft remains editable while its passive defaults read waits for a connection. */
export function useDraftWorkspaceDefaults(draftId: DraftId | null): void {
  const draft = useComposerDraftStore((state) => (draftId ? state.getDraftSession(draftId) : null));
  const projects = useProjects();
  const configs = useServerConfigs();
  const project = projects.find(
    (candidate) =>
      candidate.id === draft?.projectId && candidate.environmentId === draft.environmentId,
  );
  const config = draft ? configs.get(draft.environmentId) : undefined;
  const pending = draft?.pendingWorkspaceDefaults;
  useEffect(() => {
    if (!draftId || !pending || !project || !config) return;
    const controller = new AbortController();
    void resolveDraftWorkspaceDefaults({ draftId, project, config, signal: controller.signal });
    return () => controller.abort();
  }, [draftId, pending, project, config]);
}
