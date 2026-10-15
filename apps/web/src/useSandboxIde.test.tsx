import { EnvironmentId, ProjectId, ThreadId, type SandboxIdeTarget } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ run: vi.fn(), allowed: true }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openSandboxIde: {} } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: () => state.allowed,
  readPreparedConnection: () => ({ httpBaseUrl: "https://remote.example" }),
}));
import { useSandboxIde } from "./useSandboxIde";
import { useOpenFavoriteEditorShortcut } from "./components/chat/OpenInPickerShortcut";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
let renderer: ReactTestRenderer | undefined;
const tab = {
  opener: {},
  document: { title: "", body: { textContent: "" } },
  location: { replace: vi.fn() },
  close: vi.fn(),
};
const openTab = vi.fn(() => tab);
function Trigger({
  target = { threadId },
  file,
}: {
  target?: SandboxIdeTarget | null;
  file?: string;
}) {
  const open = useSandboxIde(environmentId, target, "/work/project");
  return (
    <button
      onClick={() => {
        void open(file);
      }}
    >
      Open VS Code
    </button>
  );
}
beforeEach(() => {
  state.allowed = true;
  state.run
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ url: "/api/sandbox-ide/session/?ticket=test" }));
  openTab.mockClear();
  tab.location.replace.mockClear();
  tab.close.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { open: openTab });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("reserves a tab before the sandbox starts and resolves the IDE path against the connected T3 head", async () => {
  let finish:
    | ((value: ReturnType<typeof AsyncResult.success<{ url: string }>>) => void)
    | undefined;
  state.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    renderer = create(<Trigger />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(openTab).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: { target: { threadId }, cwd: "/work/project" },
  });
  await act(async () => {
    finish?.(
      AsyncResult.success({
        url: "/api/sandbox-ide/session/?ticket=one-use",
      }),
    );
  });
  expect(tab.location.replace).toHaveBeenCalledWith(
    "https://remote.example/api/sandbox-ide/session/?ticket=one-use",
  );
});
it("checks the current destination grant before opening a tab", async () => {
  await act(async () => {
    renderer = create(<Trigger />);
  });
  state.allowed = false;
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(openTab).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
});

it.each([
  { threadId: ThreadId.make("root-one") },
  { threadId: ThreadId.make("root-two") },
  { threadId: ThreadId.make("child") },
  { projectId: ProjectId.make("before-thread") },
])("sends explicit workspace identity and file positions: %j", async (target) => {
  await act(async () => {
    renderer = create(<Trigger target={target} file="/work/project/a b.ts:12:4" />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: { target, cwd: "/work/project", file: "/work/project/a b.ts:12:4" },
  });
});
it("does not guess a workspace from a path", async () => {
  await act(async () => {
    renderer = create(<Trigger target={null} />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(openTab).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
});
it("closes the reserved tab on a worker failure without opening another target", async () => {
  state.run.mockResolvedValue({ _tag: "Failure" });
  await act(async () => {
    renderer = create(<Trigger />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(tab.close).toHaveBeenCalledOnce();
  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(openTab).toHaveBeenCalledOnce();
});
it("rechecks revocation and regrant for a retained callback", async () => {
  await act(async () => {
    renderer = create(<Trigger />);
  });
  const click = renderer!.root.findByType("button").props.onClick;
  state.allowed = false;
  await act(async () => {
    click();
  });
  expect(state.run).not.toHaveBeenCalled();
  state.allowed = true;
  await act(async () => {
    click();
  });
  expect(state.run).toHaveBeenCalledOnce();
});

it("routes the editor keybinding to the project sandbox and rechecks permission", async () => {
  type KeyEvent = Pick<
    KeyboardEvent,
    "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "preventDefault"
  >;
  const keydown = new Set<(event: KeyEvent) => void>();
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", {
    open: openTab,
    addEventListener: (_type: string, listener: (event: KeyEvent) => void) => keydown.add(listener),
    removeEventListener: (_type: string, listener: (event: KeyEvent) => void) =>
      keydown.delete(listener),
  });
  const projectId = ProjectId.make("before-thread");
  function Shortcut() {
    useOpenFavoriteEditorShortcut({
      enabled: true,
      environmentId,
      target: { projectId },
      openInCwd: "/work/project",
      availableEditors: [],
      keybindings: [
        {
          command: "editor.openFavorite",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Shortcut />);
  });
  const event = {
    key: "o",
    code: "KeyO",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault: vi.fn(),
  };
  const dispatch = () => {
    for (const listener of keydown) listener(event);
  };
  state.allowed = false;
  await act(async () => {
    dispatch();
  });
  expect(openTab).not.toHaveBeenCalled();
  state.allowed = true;
  await act(async () => {
    dispatch();
  });
  expect(state.run).toHaveBeenCalledWith({
    environmentId,
    input: { target: { projectId }, cwd: "/work/project" },
  });
});
