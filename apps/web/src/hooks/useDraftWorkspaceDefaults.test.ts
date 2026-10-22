import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type T3ProjectFile,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { guardDraftSend } from "../lib/draftSend";
import { resolveSendEnvMode, resolveWorktreeBootstrap } from "../components/ChatView.logic";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  threads: vi.fn(() => []),
  navigate: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map([[project.environmentId, config]]),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router, useParams: () => ({}) }));
vi.mock("./useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: mocks.readFile }));
vi.mock("../state/entities", () => ({
  readThreadShells: mocks.threads,
  readProjects: () => [project],
  readThreadShell: () => null,
  useThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));

import { resolveDraftWorkspaceDefaults } from "./useDraftWorkspaceDefaults";
import { useNewThreadHandler } from "./useHandleNewThread";

const project: EnvironmentProject = {
  id: ProjectId.make("project-defaults"),
  environmentId: EnvironmentId.make("environment-defaults"),
  title: "Defaults",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const projectRef = { environmentId: project.environmentId, projectId: project.id };
const draftId = DraftId.make("draft-defaults");
const config = {
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    defaultThreadEnvMode: null,
    newWorktreesStartFromOrigin: true,
  },
  newProjectsRoot: "/projects",
};
const routeParams: Record<string, string> = {};
const router = {
  state: { location: { href: "/" }, matches: [{ params: routeParams }] },
  navigate: mocks.navigate,
};

function deferFile() {
  let resolve!: (value: T3ProjectFile | null) => void;
  const promise = new Promise<T3ProjectFile | null>((complete) => {
    resolve = complete;
  });
  mocks.readFile.mockReturnValue(promise);
  return { promise, resolve };
}

function resolve(signal = new AbortController().signal) {
  return resolveDraftWorkspaceDefaults({ draftId, project, config, signal });
}

beforeEach(() => {
  vi.clearAllMocks();
  router.state.location.href = "/";
  router.state.matches = [{ params: {} }];
  mocks.navigate.mockImplementation(async (input: { params: { draftId: string } }) => {
    router.state.location.href = `/draft/${input.params.draftId}`;
    router.state.matches = [{ params: input.params }];
  });
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
    threadId: ThreadId.make("thread-defaults"),
    branch: "main",
    envMode: "local",
    pendingWorkspaceDefaults: {},
  });
});

describe("draft workspace defaults", () => {
  it("registers one draft synchronously across clicks while navigation is pending", async () => {
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    mocks.navigate.mockImplementation(() => navigation);
    deferFile();
    const open = useNewThreadHandler();
    const first = open(projectRef);
    const second = open(projectRef);
    const drafts = useComposerDraftStore.getState().draftThreadsByThreadKey;
    expect(Object.keys(drafts)).toHaveLength(1);
    expect(Object.values(drafts)[0]?.pendingWorkspaceDefaults).toEqual({});
    finishNavigation();
    expect(await first).toEqual(await second);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("keeps an open pending draft's identity, but preserves typed work in a separate draft", async () => {
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    deferFile();
    const open = useNewThreadHandler();
    const first = (await open(projectRef))!;
    const store = useComposerDraftStore.getState();
    const originalPending = store.getDraftSession(first.draftId)?.pendingWorkspaceDefaults;
    expect(await open(projectRef)).toEqual(first);
    expect(store.getDraftSession(first.draftId)?.pendingWorkspaceDefaults).toBe(originalPending);
    store.setPrompt(first.draftId, "keep this work");
    const second = (await open(projectRef))!;
    expect(second.draftId).not.toBe(first.draftId);
    expect(store.getComposerDraft(first.draftId)?.prompt).toBe("keep this work");
    expect(store.getDraftSession(second.draftId)?.pendingWorkspaceDefaults).toEqual({});
  });

  it("keeps typing usable and blocks all send side effects until the resolved render", async () => {
    const file = deferFile();
    const pending = resolve();
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "typed while defaults load");
    const upload = vi.fn();
    const dispatch = vi.fn();
    const submit = async () => {
      upload();
      const draft = store.getDraftSession(draftId)!;
      dispatch(
        resolveWorktreeBootstrap({
          isFirstMessage: true,
          envMode: resolveSendEnvMode({ requestedEnvMode: draft.envMode, isGitRepo: true }),
          worktreePath: draft.worktreePath,
          branch: draft.branch,
          projectCwd: project.workspaceRoot,
          startFromOrigin: draft.startFromOrigin,
        }),
      );
    };
    const staleSend = guardDraftSend(draftId, true, submit);
    // A stale ready handler also has to consult the live pending draft.
    await guardDraftSend(draftId, false, submit)();
    const event = { preventDefault: vi.fn() };
    await staleSend(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getComposerDraft(draftId)?.prompt).toBe("typed while defaults load");

    file.resolve({ defaultThreadEnvMode: "worktree" });
    await pending;
    const ready = store.getDraftSession(draftId);
    expect(ready).toMatchObject({ envMode: "worktree", branch: "main", startFromOrigin: true });
    expect(ready?.pendingWorkspaceDefaults).toBeUndefined();
    expect(resolveSendEnvMode({ requestedEnvMode: ready!.envMode, isGitRepo: true })).toBe(
      "worktree",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await staleSend();
    expect(dispatch).not.toHaveBeenCalled();
    await guardDraftSend(draftId, false, submit)();
    expect(upload).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main", startFromOrigin: true },
      runSetupScript: true,
    });
  });

  it("recovers pending defaults and typed content after persistence and reload", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "survive reload");
    const saved = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(saved, useComposerDraftStore.getInitialState()), true);
    expect(store.getDraftSession(draftId)?.pendingWorkspaceDefaults).toEqual({});
    expect(store.getComposerDraft(draftId)?.prompt).toBe("survive reload");
    const file = deferFile();
    const pending = resolve();
    file.resolve({ defaultThreadEnvMode: "worktree" });
    await pending;
    expect(store.getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      startFromOrigin: true,
    });
    expect(store.getDraftSession(draftId)?.pendingWorkspaceDefaults).toBeUndefined();
  });

  it("does not overwrite an explicit workspace choice with a late result", async () => {
    const file = deferFile();
    const pending = resolve();
    const store = useComposerDraftStore.getState();
    store.setDraftThreadContext(draftId, { envMode: "local", startFromOrigin: false });
    file.resolve({ defaultThreadEnvMode: "worktree" });
    await pending;
    expect(store.getDraftSession(draftId)).toMatchObject({
      envMode: "local",
      startFromOrigin: false,
    });
    expect(store.getDraftSession(draftId)?.pendingWorkspaceDefaults).toBeUndefined();
  });

  it("preserves an origin-only edit while still resolving the checked-in workspace mode", async () => {
    const file = deferFile();
    const pending = resolve();
    const store = useComposerDraftStore.getState();
    store.setDraftThreadContext(draftId, { startFromOrigin: false });
    expect(store.getDraftSession(draftId)?.pendingWorkspaceDefaults).toBeDefined();
    const updated = resolve();
    file.resolve({ defaultThreadEnvMode: "worktree" });
    await pending;
    await updated;
    expect(store.getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it.each(["abort", "replace", "project", "promote", "delete"] as const)(
    "ignores the late result after %s",
    async (change) => {
      const file = deferFile();
      const controller = new AbortController();
      const pending = resolve(controller.signal);
      const store = useComposerDraftStore.getState();
      switch (change) {
        case "abort":
          controller.abort();
          break;
        case "replace":
          store.setDraftThreadContext(draftId, { pendingWorkspaceDefaults: {} });
          break;
        case "project":
          store.setDraftThreadContext(draftId, {
            projectRef: { ...projectRef, projectId: ProjectId.make("other") },
          });
          store.setDraftThreadContext(draftId, { projectRef });
          break;
        case "promote":
          store.markDraftThreadPromoting(draftId);
          break;
        case "delete":
          store.clearDraftThread(draftId);
          break;
      }
      const before = store.getDraftSession(draftId);
      file.resolve({ defaultThreadEnvMode: "worktree" });
      await pending;
      expect(store.getDraftSession(draftId)).toEqual(before);
    },
  );

  it("uses a higher-priority configured mode without reading the file", async () => {
    await resolveDraftWorkspaceDefaults({
      draftId,
      project,
      signal: new AbortController().signal,
      config: { ...config, settings: { ...config.settings, defaultThreadEnvMode: "local" } },
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().getDraftSession(draftId)?.pendingWorkspaceDefaults,
    ).toBeUndefined();
  });

  it("settles a stopped or missing passive file using the existing fallback", async () => {
    mocks.readFile.mockResolvedValue(null);
    await resolve();
    expect(
      useComposerDraftStore.getState().getDraftSession(draftId)?.pendingWorkspaceDefaults,
    ).toBeUndefined();
  });
});
