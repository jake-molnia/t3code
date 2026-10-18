import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";
import { commonMcpSelection, readMcpAuthReturnScope } from "./McpSettings.logic";

const a = ProjectId.make("project-a");
const b = ProjectId.make("project-b");

describe("bulk MCP project access", () => {
  it("does not treat an unassigned project as sharing another project's access", () => {
    expect(
      commonMcpSelection(
        [a, b],
        [{ projectId: a, connectionId: "shared", tools: { mode: "all" } }],
        "shared",
      ),
    ).toBe("mixed");
  });
  it("compares selected tools as a set and ignores other connections", () => {
    expect(
      commonMcpSelection(
        [a, b],
        [
          {
            projectId: a,
            connectionId: "shared",
            tools: { mode: "selected", toolIds: ["read", "search"] },
          },
          {
            projectId: b,
            connectionId: "shared",
            tools: { mode: "selected", toolIds: ["search", "read"] },
          },
          { projectId: b, connectionId: "other", tools: { mode: "all" } },
        ],
        "shared",
      ),
    ).toEqual({ mode: "selected", toolIds: ["read", "search"] });
  });
  it("distinguishes selected current tools from access to future tools", () => {
    expect(
      commonMcpSelection(
        [a, b],
        [
          { projectId: a, connectionId: "shared", tools: { mode: "selected", toolIds: ["read"] } },
          { projectId: b, connectionId: "shared", tools: { mode: "all" } },
        ],
        "shared",
      ),
    ).toBe("mixed");
  });
  it("keeps empty and unassigned selections disabled", () => {
    expect(commonMcpSelection([], [], "shared")).toBeNull();
    expect(commonMcpSelection([a, b], [], "shared")).toBeNull();
  });
});

describe("MCP sign-in project return", () => {
  it("restores the shared project and checkout selection after OAuth", () => {
    const search = new URLSearchParams({
      project: "repo:team/my project",
      checkout: "central:123",
    });
    expect(readMcpAuthReturnScope(search.toString())).toEqual({
      project: "repo:team/my project",
      checkout: "central:123",
    });
  });

  it("preserves a stale explicit project instead of redirecting access edits to another project", () => {
    expect(readMcpAuthReturnScope("project=removed-project")).toEqual({
      project: "removed-project",
    });
  });

  it("drops OAuth callback fields and the old environment selector", () => {
    expect(
      readMcpAuthReturnScope("project=chosen&machine=old&code=secret&state=state&error=denied"),
    ).toEqual({
      project: "chosen",
    });
  });

  it("lets the shared scope choose a project for callbacks started before project restoration existed", () => {
    expect(readMcpAuthReturnScope(null)).toEqual({});
    expect(readMcpAuthReturnScope("project=%20")).toEqual({});
  });
});
