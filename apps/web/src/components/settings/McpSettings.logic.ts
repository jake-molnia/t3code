import type { McpToolSelection, ProjectId } from "@t3tools/contracts";
import { validateSettingsScopeSearch } from "./settingsScope";

/** OAuth leaves Settings; restore its project without retaining callback or legacy machine fields. */
export function readMcpAuthReturnScope(savedSearch: string | null) {
  const params = new URLSearchParams(savedSearch ?? "");
  return validateSettingsScopeSearch({
    project: params.get("project"),
    checkout: params.get("checkout"),
  });
}

/** Bulk edits show mixed permissions until the user chooses a replacement. */
export function commonMcpSelection(
  projectIds: readonly ProjectId[],
  access: readonly { projectId: ProjectId; connectionId: string; tools: McpToolSelection }[],
  connectionId: string,
): McpToolSelection | null | "mixed" {
  const selections = projectIds.map(
    (projectId) =>
      access.find((entry) => entry.projectId === projectId && entry.connectionId === connectionId)
        ?.tools ?? null,
  );
  const first = selections[0] ?? null;
  const key = (value: McpToolSelection | null) =>
    value === null
      ? "off"
      : value.mode === "all"
        ? "all"
        : JSON.stringify([...new Set(value.toolIds)].sort());
  return selections.every((value) => key(value) === key(first)) ? first : "mixed";
}
