import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
function Trigger() {
  const open = useSandboxIde(environmentId, threadId, "/work/project");
  return <button onClick={open}>Open VS Code</button>;
}
beforeEach(() => {
  state.allowed = true;
  state.run.mockReset();
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
    input: { threadId, cwd: "/work/project" },
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
