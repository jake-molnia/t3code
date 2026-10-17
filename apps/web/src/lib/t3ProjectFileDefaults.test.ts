import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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
  vi.restoreAllMocks();
});

describe("new chat project defaults", () => {
  it("cancels an abandoned defaults wait without cancelling another reader", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make(null));
    const pending = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult>>(
      AsyncResult.initial(true),
    );
    mocks.readFile.mockReturnValue(pending);
    const controller = new AbortController();
    const abandoned = readT3ProjectFile(environmentId, "/repo", { signal: controller.signal });
    const current = readT3ProjectFile(environmentId, "/repo");
    controller.abort();
    expect(await abandoned).toBeNull();
    appAtomRegistry.set(pending, AsyncResult.success(projectFile));
    expect(await current).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("reuses warm passive defaults and honors a shared query refresh", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make(null));
    let file = projectFile;
    const fetchFile = vi.fn(() => file);
    const query = Atom.make(Effect.sync(fetchFile)).pipe(
      Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
    );
    mocks.readFile.mockReturnValue(query);

    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({
      defaultThreadEnvMode: "worktree",
    });
    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({
      defaultThreadEnvMode: "worktree",
    });
    expect(fetchFile).toHaveBeenCalledTimes(1);

    file = { ...projectFile, contents: '{"defaultThreadEnvMode":"local"}' };
    appAtomRegistry.refresh(query);
    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({
      defaultThreadEnvMode: "local",
    });
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("uses an optimistic preference without starting or waiting for a remote read", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make({ data: projectFile }));
    const pending = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult>>(
      AsyncResult.initial(true),
    );
    mocks.readFile.mockReturnValue(pending);

    const read = readT3ProjectFile(environmentId, "/repo");
    const immediate = await Promise.race([read, Promise.resolve("pending")]);
    // Settle the remote read so a regression fails without a test timeout.
    appAtomRegistry.set(pending, AsyncResult.success(projectFile));

    expect(await read).toEqual({ defaultThreadEnvMode: "worktree" });
    expect(immediate).toEqual({ defaultThreadEnvMode: "worktree" });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("preserves a reset optimistic preference instead of resurrecting the remote default", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make({ data: { ...projectFile, contents: "{}" } }));
    mocks.readFile.mockReturnValue(Atom.make(AsyncResult.success(projectFile)));

    expect(await readT3ProjectFile(environmentId, "/repo")).toEqual({});
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("waits for an uncached passive read and uses the checked-in default", async () => {
    mocks.optimisticFile.mockReturnValue(Atom.make(null));
    const pending = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult>>(
      AsyncResult.initial(true),
    );
    mocks.readFile.mockReturnValue(pending);
    let settled = false;
    const read = readT3ProjectFile(environmentId, "/repo").then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.readFile).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", relativePath: "t3.json", passive: true },
    });
    appAtomRegistry.set(pending, AsyncResult.success(projectFile));
    expect(await read).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("uses an edit made while the passive read is pending", async () => {
    const optimistic = Atom.make<{ data: ProjectReadFileResult } | null>(null);
    mocks.optimisticFile.mockReturnValue(optimistic);
    const pending = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult>>(
      AsyncResult.initial(true),
    );
    mocks.readFile.mockReturnValue(pending);
    const read = readT3ProjectFile(environmentId, "/repo");

    appAtomRegistry.set(optimistic, { data: projectFile });
    appAtomRegistry.set(
      pending,
      AsyncResult.success({ ...projectFile, contents: '{"defaultThreadEnvMode":"local"}' }),
    );

    expect(await read).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it.each([
    { ...projectFile, contents: "invalid json" },
    { ...projectFile, truncated: true },
  ])("does not replace an invalid or truncated edit with stale remote defaults", async (data) => {
    mocks.optimisticFile.mockReturnValue(Atom.make({ data }));
    mocks.readFile.mockReturnValue(Atom.make(AsyncResult.success(projectFile)));

    expect(await readT3ProjectFile(environmentId, "/repo")).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

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
