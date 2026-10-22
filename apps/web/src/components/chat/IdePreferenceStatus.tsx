import { IdeSetupControls } from "../settings/IdeSetupSettings";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CloudUploadIcon, PauseIcon, TriangleAlertIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SandboxIdeTarget } from "@t3tools/contracts";
import { useState } from "react";
import { shellEnvironment } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuItem, MenuItemLabel } from "../ui/menu";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function IdePreferenceStatus({
  environmentId,
  target,
  compact = false,
  presentation = "toolbar",
}: {
  environmentId: EnvironmentId;
  target: SandboxIdeTarget;
  compact?: boolean;
  presentation?: "toolbar" | "menu";
}) {
  const status = useEnvironmentQuery(
    shellEnvironment.idePreferenceStatus({ environmentId, input: { target } }),
  );
  const resolve = useAtomCommand(shellEnvironment.resolveIdePreference, "resolve VS Code settings");
  const canResolve = useAtomValue(
    shellEnvironment.resolveIdePreference.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const state = status.error ? "needs_attention" : status.data?.state;

  const label = status.error
    ? "Settings status unavailable"
    : state === "saved"
      ? "Settings saved"
      : state === "paused"
        ? "Remembering paused"
        : state === "pending"
          ? "Saving settings…"
          : state === "not_opened" || state === "offline" || !state
            ? "VS Code setup"
            : "Settings need attention";
  const resolveFile = async (path: string, choice: "workspace" | "saved") => {
    setPending(true);
    try {
      await resolve({ environmentId, input: { target, path, choice } });
      status.refresh();
    } finally {
      setPending(false);
    }
  };
  if (presentation === "menu")
    return (
      <>
        <MenuItem
          render={
            <Link
              to="/settings/ide"
              search={{
                machine: environmentId,
                ideEnvironment: environmentId,
                ...("threadId" in target
                  ? { ideThread: target.threadId }
                  : { ideProject: target.projectId }),
              }}
            />
          }
        >
          <MenuItemLabel>Manage VS Code setup</MenuItemLabel>
        </MenuItem>
        <MenuItem disabled>
          <MenuItemLabel>{label}</MenuItemLabel>
        </MenuItem>
        {status.data?.issues.map((issue) =>
          issue.reason === "conflict" || issue.reason === "import_required" ? (
            <div key={issue.path}>
              <MenuItem
                disabled={!canResolve || pending}
                onClick={() => void resolveFile(issue.path, "workspace")}
              >
                <MenuItemLabel>Save this sandbox's {issue.path}</MenuItemLabel>
              </MenuItem>
              <MenuItem
                disabled={!canResolve || pending}
                onClick={() => void resolveFile(issue.path, "saved")}
              >
                <MenuItemLabel>Use saved {issue.path}</MenuItemLabel>
              </MenuItem>
            </div>
          ) : (
            <MenuItem key={`${issue.path}:${issue.reason}`} disabled>
              <MenuItemLabel>
                {issue.path || "Settings sync"}:{" "}
                {issue.reason === "invalid_json"
                  ? "Fix JSON in VS Code"
                  : issue.reason === "too_large"
                    ? "File too large to sync"
                    : "Sync unavailable; retrying"}
              </MenuItemLabel>
            </MenuItem>
          ),
        )}
      </>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size={compact ? "icon-xs" : "xs"} variant="ghost" />}
        aria-label={`VS Code: ${label}`}
        title={label}
      >
        {state === "saved" && !status.error ? (
          <CheckIcon />
        ) : state === "paused" ? (
          <PauseIcon />
        ) : state === "pending" ? (
          <CloudUploadIcon />
        ) : (
          <TriangleAlertIcon />
        )}
        {!compact && label}
      </PopoverTrigger>
      <PopoverPopup width="md">
        <div className="space-y-3 text-sm">
          <p>
            {state === "saved"
              ? "Saved for new sandboxes."
              : state === "paused"
                ? "Changes stay in this sandbox while remembering is paused."
                : state === "pending"
                  ? "Changes waiting to save."
                  : "A change needs attention."}
          </p>
          <p>
            Settings, keyboard shortcuts and snippets are shared within this environment. Existing
            sandboxes keep their local settings.
          </p>
          <IdeSetupControls environmentId={environmentId} target={target} />
          {status.error && <p>Could not refresh the settings status. Retrying automatically.</p>}
          {status.data?.issues.map((issue) => (
            <div key={`${issue.path}:${issue.reason}`} className="space-y-2">
              <p>
                {issue.path || "Settings sync"}:{" "}
                {issue.reason === "invalid_json"
                  ? "Fix the JSON in VS Code to resume saving."
                  : issue.reason === "too_large"
                    ? "This file exceeds the settings sync size limit."
                    : issue.reason === "unavailable"
                      ? "Could not read or save changes. Retrying automatically."
                      : issue.reason === "import_required"
                        ? "This existing file has not been imported. Choose which version to keep."
                        : "This file was also changed in another sandbox."}
              </p>
              {(issue.reason === "conflict" || issue.reason === "import_required") && (
                <div className="flex flex-wrap gap-2">
                  {(["workspace", "saved"] as const).map((choice) => (
                    <Button
                      key={choice}
                      size="sm"
                      variant="outline"
                      disabled={!canResolve || pending}
                      onClick={() => void resolveFile(issue.path, choice)}
                    >
                      {choice === "workspace" ? "Save this sandbox's version" : "Use saved version"}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
