// @vitest-environment jsdom

import { EnvironmentId, ExecutionPoolId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  showContextMenu: vi.fn().mockResolvedValue("copy-path"),
  writeTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.showContextMenu } }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock("./BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getDraftThreadByRef: () => null, setDraftThreadContext: vi.fn() }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  }),
  useProject: () => ({ workspaceRoot: "/tmp/project" }),
  useThreadShellsForProjectRefs: () => [],
}));

import { BranchToolbar } from "./BranchToolbar";
import { ExecutionPoolSelector } from "./ExecutionPoolSelector";

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.worktreePath = worktreePath;
    state.showContextMenu.mockClear();
    state.writeTextToClipboard.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <BranchToolbar
            layout="panel"
            panelSection="workspace"
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            showGitControls
            envMode={envMode}
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={vi.fn()}
          />,
        );
      });
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => {
        container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(copiedPath !== null);
      if (copiedPath === null) {
        expect(state.showContextMenu).not.toHaveBeenCalled();
        expect(state.writeTextToClipboard).not.toHaveBeenCalled();
      } else {
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = "/tmp/worktree";
      vi.unstubAllGlobals();
    }
  },
);

it.each([true, false])(
  "renders one native pool picker in the composer with Git controls %s",
  async (showGitControls) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const poolId = ExecutionPoolId.make("gompers");
    const driver = ProviderDriverKind.make("codex");
    try {
      await act(async () =>
        root.render(
          <BranchToolbar
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            showGitControls={showGitControls}
            envMode="local"
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={vi.fn()}
            composerControlsHostRef={vi.fn()}
            executionPoolControl={
              <ExecutionPoolSelector
                catalog={{
                  snapshot: {
                    defaultPoolId: poolId,
                    pools: [
                      {
                        id: poolId,
                        label: "Gompers",
                        available: true,
                        resources: null,
                        providerDrivers: [driver],
                      },
                    ],
                  },
                  receivedAt: 0,
                  pending: false,
                  failed: false,
                  refresh: vi.fn(),
                }}
                selectedId={poolId}
                driver={driver}
                locked={false}
                automatic={false}
                onSelect={vi.fn()}
                onAutomatic={vi.fn()}
              />
            }
          />,
        ),
      );
      const pickers = container.querySelectorAll('button[aria-label="Execution pool"]');
      expect(pickers).toHaveLength(1);
      expect(pickers[0]?.textContent).toContain("Gompers");
      expect(pickers[0]?.getAttribute("data-composer-shortcut")).toBe("composer.host");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
      vi.unstubAllGlobals();
    }
  },
);
