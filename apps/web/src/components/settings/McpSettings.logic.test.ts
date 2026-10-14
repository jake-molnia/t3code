import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";
import { commonMcpSelection } from "./McpSettings.logic";

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
