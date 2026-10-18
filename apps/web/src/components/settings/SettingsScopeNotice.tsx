import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const groups = useSettingsProjectGroups();
  const choices: { label: string; search: SettingsScopeSearch }[] = groups
    .filter(
      (group) =>
        eligibleEnvironmentIds === undefined ||
        group.memberProjects.some((member) =>
          eligibleEnvironmentIds.includes(member.environmentId),
        ),
    )
    .flatMap((group) =>
      target === "checkout"
        ? group.memberProjects.map((member) => ({
            label: `${group.displayName} · ${member.workspaceRoot}`,
            search: { project: group.projectKey, checkout: member.physicalProjectKey },
          }))
        : [{ label: group.displayName, search: { project: group.projectKey } }],
    );
  return (
    <SettingsPageContainer>
      <Alert role="status">
        <AlertDescription>
          <p>{children}</p>
          <AlertAction className="flex-wrap">
            {choices.map((choice) => (
              <Button
                key={JSON.stringify(choice.search)}
                size="sm-multiline"
                variant="outline"
                className="max-w-full break-all text-left"
                onClick={() => {
                  if (targetId)
                    void navigate({ to: pathname, search: () => choice.search, hash: targetId });
                  else selectScope(choice.search);
                }}
              >
                {choice.label}
              </Button>
            ))}
          </AlertAction>
        </AlertDescription>
      </Alert>
    </SettingsPageContainer>
  );
}
