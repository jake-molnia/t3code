import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  optimisticFile: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: mocks }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readT3ProjectFile } from "./t3ProjectFileDefaults";

const environmentId = EnvironmentId.make("environment-new-chat");
const contents = JSON.stringify({ defaultThreadEnvMode: "worktree" });
const projectFile: ProjectReadFileResult = {
  relativePath: "t3.json",
  contents,
  byteLength: contents.length,
  truncated: false,
};

afterEach(() => {
  appAtomRegistry.reset();
  vi.clearAllMocks();
});

describe("new chat project defaults", () => {
  it("does not allocate a stopped project worker before opening the composer", async () => {
    let allocations = 0;
    mocks.optimisticFile.mockReturnValue(Atom.make(null));
    mocks.readFile.mockImplementation(({ input }: { input: { passive?: boolean } }) => {
      if (input.passive) {
        return Atom.make(AsyncResult.failure(Cause.fail(new Error("Workspace is stopped."))));
      }
      allocations += 1;
      return Atom.make(AsyncResult.success(projectFile));
    });

    const result = await readT3ProjectFile(environmentId, "/repo");

    expect(allocations).toBe(0);
    expect(result).toBeNull();
  });

  it("preserves project defaults from a running worker", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make(null));
    mocks.readFile.mockReturnValue(Atom.make(AsyncResult.success(projectFile)));

    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("preserves an optimistic project preference when the worker is stopped", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make({ data: projectFile }));
    mocks.readFile.mockReturnValue(
      Atom.make(AsyncResult.failure(Cause.fail(new Error("Workspace is stopped.")))),
    );

    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });
});
