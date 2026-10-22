import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IdeSetupCommandInput, SandboxIdeTarget } from "@t3tools/contracts";
import { useAssetUrlState } from "../../assets/assetUrls";
import { shellEnvironment } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

export function IdeSetupControls({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target?: SandboxIdeTarget;
}) {
  const query = useEnvironmentQuery(
    shellEnvironment.ideSetup({ environmentId, input: target ? { target } : {} }),
  );
  const manage = useAtomCommand(shellEnvironment.manageIdeSetup, "update saved VS Code setup");
  const exportSetup = useAtomCommand(shellEnvironment.exportIdeSetup, "export saved VS Code setup");
  const allowed = useAtomValue(shellEnvironment.manageIdeSetup.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [archive, setArchive] = useState("");
  const [exportedAttachment, setExportedAttachment] = useState<string | null>(null);
  const download = useAssetUrlState(
    environmentId,
    exportedAttachment
      ? {
          _tag: "attachment",
          attachmentId: exportedAttachment,
          fileName: "vscode-setup.tar",
          mimeType: "application/x-tar",
        }
      : null,
  );
  const run = async (command: IdeSetupCommandInput["command"]) => {
    setPending(true);
    try {
      await manage({ environmentId, input: { command, ...(target ? { target } : {}) } });
      query.refresh();
    } finally {
      setPending(false);
    }
  };
  const data = query.data;
  if (!data) return <p>{query.error ? "Saved setup is unavailable." : "Loading saved setup…"}</p>;
  const disabled = pending || !allowed;
  return (
    <div className="space-y-4 text-sm">
      <p>
        Change settings and install extensions in VS Code. T3 remembers them for new sandboxes in
        this environment.
      </p>
      <p role="status">
        {!data.remembering ? "Remembering is paused." : "Remembering changes."}{" "}
        {data.build.state === "building"
          ? "Building the saved Nix extension set…"
          : data.build.state === "failed"
            ? data.build.reason === "conflict"
              ? "Extensions changed in another sandbox. Import this sandbox to keep its set, or apply the saved setup."
              : "The extension build failed. New sandboxes keep the last successful set. Retry the build, or import the original VSIX for a private extension."
            : data.build.state === "ready"
              ? "Extensions are ready for new sandboxes."
              : "No saved extension build yet."}
      </p>
      {target && data.settingsMatch !== null && (
        <p>
          {data.settingsMatch
            ? "Native settings match the saved setup."
            : "Native settings currently differ from the saved setup."}
        </p>
      )}
      {data.stage === "ready_with_errors" && (
        <p>Some extensions could not be restored. Apply the saved setup to retry.</p>
      )}
      {target && (
        <p>
          {data.publishedRevision === null
            ? "No extension set has been published yet."
            : data.appliedRevision === data.publishedRevision
              ? "This sandbox has the published extension set."
              : "A different extension set is saved. Apply it when you are ready to restart the editor."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run({ kind: "remember", enabled: !data.remembering })}
        >
          {data.remembering ? "Pause remembering" : "Resume remembering"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || data.build.state === "building"}
          onClick={() => void run({ kind: "retry" })}
        >
          Retry extension build
        </Button>
        {target && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run({ kind: "apply" })}
            >
              Apply saved setup
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run({ kind: "import" })}
            >
              Import this sandbox
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setPending(true);
                void exportSetup({ environmentId, input: { target } })
                  .then((result) => {
                    if (result._tag !== "Success") return;
                    setExportedAttachment(result.value.attachmentId);
                  })
                  .finally(() => setPending(false));
              }}
            >
              Export setup
            </Button>
          </>
        )}
      </div>
      {download._tag === "Success" && (
        <Button
          size="sm"
          variant="outline"
          render={<a href={download.url} download="vscode-setup.tar" />}
        >
          Download setup archive
        </Button>
      )}
      <div>
        <h3 className="mb-2 font-medium">Saved extensions</h3>
        {data.extensions.length === 0 ? (
          <p>No extensions saved.</p>
        ) : (
          <ul className="space-y-1">
            {data.extensions.map((extension) => (
              <li key={extension.id} className="break-all">
                {extension.id} · {extension.version}
                {extension.archive ? " · private VSIX" : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      {target && (
        <div className="space-y-2">
          <label htmlFor="ide-vsix-path">Original private VSIX path in this sandbox</label>
          <Input
            id="ide-vsix-path"
            value={archive}
            onChange={(event) => setArchive(event.target.value)}
            placeholder="/workspace/extension.vsix"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !archive.startsWith("/")}
            onClick={() => void run({ kind: "import_vsix", path: archive })}
          >
            Save private VSIX
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run({ kind: "reset_settings" })}
        >
          Reset saved settings
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run({ kind: "reset_extensions" })}
        >
          Reset saved extensions
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || data.previousSettingsRevision === null}
          onClick={() => void run({ kind: "rollback_settings" })}
        >
          Restore previous settings
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || data.previousPublishedRevision === null}
          onClick={() => void run({ kind: "rollback_extensions" })}
        >
          Restore previous extensions
        </Button>
      </div>
      <p>
        Reset and rollback change the defaults for new sandboxes. Existing sandboxes keep their
        local setup until you apply the saved setup. Apply restarts the editor and may interrupt its
        terminals and tasks.
      </p>
      {!target && (
        <p>Open the VS Code setup menu in a sandbox to import, apply or export its setup.</p>
      )}
    </div>
  );
}

export function IdeSetupSettingsPanel({
  target,
  targetEnvironmentId,
}: { target?: SandboxIdeTarget; targetEnvironmentId?: EnvironmentId } = {}) {
  const { environment } = useSettingsScope();
  if (
    !environment ||
    (targetEnvironmentId !== undefined && targetEnvironmentId !== environment.environmentId)
  )
    return (
      <SettingsScopeNotice target="environment">
        Choose an environment to manage its saved VS Code setup.
      </SettingsScopeNotice>
    );
  return (
    <SettingsPageContainer>
      <section id="ide-setup" className="space-y-4">
        <h2 className="text-lg font-medium">VS Code</h2>
        <IdeSetupControls
          environmentId={environment.environmentId}
          {...(target && targetEnvironmentId === environment.environmentId ? { target } : {})}
        />
      </section>
    </SettingsPageContainer>
  );
}
