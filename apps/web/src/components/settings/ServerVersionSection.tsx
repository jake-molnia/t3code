import { useAtomValue } from "@effect/atom-react";
import { SERVER_RELEASES_URL } from "@t3tools/contracts";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ServerVersionSection() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const config = useAtomValue(primaryServerConfigAtom);
  const build = config?.environment.build;
  const notice = useEnvironmentQuery(
    environmentId && build ? serverEnvironment.releaseNotice({ environmentId, input: {} }) : null,
  );
  const release = notice.data;
  return (
    <SettingsRow
      id={searchableSetting("app-version").id}
      title="Server version"
      description={
        <span className="block space-y-1 break-words">
          <span className="block">
            Fork revision: <code>{build?.revision ?? "Not recorded in this build"}</code>
          </span>
          <span className="block">
            Package version:{" "}
            {build?.packageVersion ?? config?.environment.serverVersion ?? "Loading…"}
          </span>
          <span className="block">
            Upstream baseline: {build?.upstreamVersion ?? "Not recorded"}
          </span>
          {release?.status === "available" ? (
            <span className="block">
              A newer fork release is available: {release.tag}. Updates are managed by the
              deployment administrator.
            </span>
          ) : release?.status === "current" ? (
            <span className="block">No newer fork release found.</span>
          ) : notice.isPending ? (
            <span className="block">Checking fork releases…</span>
          ) : release?.status === "unavailable" || notice.error ? (
            <span className="block">Release check unavailable. You can still view releases.</span>
          ) : (
            <span className="block">Release comparison requires a recorded fork revision.</span>
          )}
        </span>
      }
      control={
        <Button
          size="sm"
          variant="outline"
          render={
            <a
              href={release?.status === "available" ? release.url : SERVER_RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
            />
          }
        >
          View releases
        </Button>
      }
    />
  );
}
