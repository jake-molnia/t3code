import type { McpToolSelection, ProjectId } from "@t3tools/contracts";

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
