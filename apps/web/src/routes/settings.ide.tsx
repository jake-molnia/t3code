import { createFileRoute } from "@tanstack/react-router";
import { ProjectId, ThreadId, EnvironmentId } from "@t3tools/contracts";
import { IdeSetupSettingsPanel } from "../components/settings/IdeSetupSettings";

const value = (input: unknown) =>
  typeof input === "string" && input.length > 0 && input.length < 256 ? input : undefined;
export const Route = createFileRoute("/settings/ide")({
  validateSearch: (raw: Record<string, unknown>) => {
    const ideThread = value(raw.ideThread);
    const ideProject = value(raw.ideProject);
    const ideEnvironment = value(raw.ideEnvironment);
    return {
      ...(ideThread === undefined ? {} : { ideThread }),
      ...(ideProject === undefined ? {} : { ideProject }),
      ...(ideEnvironment === undefined ? {} : { ideEnvironment }),
    };
  },
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
