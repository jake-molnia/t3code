import { createFileRoute } from "@tanstack/react-router";
import { ProjectId, ThreadId, EnvironmentId } from "@t3tools/contracts";
import { IdeSetupSettingsPanel } from "../components/settings/IdeSetupSettings";

import { validateIdeSettingsSearch } from "../components/settings/settingsScopeNavigation";

export const Route = createFileRoute("/settings/ide")({
  validateSearch: validateIdeSettingsSearch,
  component: IdeSettingsRoute,
});
function IdeSettingsRoute() {
  const search = Route.useSearch();
  const target = search.ideThread
    ? { threadId: ThreadId.make(search.ideThread) }
    : search.ideProject
      ? { projectId: ProjectId.make(search.ideProject) }
      : undefined;
  return (
    <IdeSetupSettingsPanel
      {...(target ? { target } : {})}
      {...(search.ideEnvironment
        ? { targetEnvironmentId: EnvironmentId.make(search.ideEnvironment) }
        : {})}
    />
  );
}
