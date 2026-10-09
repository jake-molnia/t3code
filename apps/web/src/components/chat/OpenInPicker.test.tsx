import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type EditorId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RemoteOpenState } from "../../remoteOpen";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  run: vi.fn(),
  openIde: vi.fn(),
  openUrl: vi.fn(),
  setPreferred: vi.fn(),
  markHintSeen: vi.fn(),
  keydown: null as ((event: KeyboardEvent) => void) | null,
  listeners: new Set<() => void>(),
}));

vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId);
  return {
    readEnvironmentScope,
    useEnvironmentScope: (environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      ),
  };
});
vi.mock("../../useSandboxIde", () => ({ useSandboxIde: () => state.openIde }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => state.allowed.has(environmentId),
}));
vi.mock("../../state/shell", () => ({
  shellEnvironment: {
    openInEditor: "openInEditor",
    openSandboxIde: { permissionAtom: (environmentId: string) => environmentId },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "Test host" }) }));
vi.mock("../../editorPreferences", () => ({
  usePreferredEditor: (available: readonly EditorId[]) => [
    available[0] ?? null,
    state.setPreferred,
  ],
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => editors,
  useRemoteOpenHint: () => [false, state.markHintSeen],
  openRemoteEditorUrl: state.openUrl,
}));
vi.mock("../../keybindings", () => ({
  isOpenFavoriteEditorShortcut: () => true,
  shortcutLabelForCommand: () => "Ctrl+O",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/group", () => ({ Group: "div", GroupSeparator: "span" }));
vi.mock("../ui/menu", () => ({
  Menu: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) => {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const visible = open ?? uncontrolledOpen;
    return (
      <div
        data-menu-open={visible}
        onDoubleClick={() => {
          setUncontrolledOpen(!visible);
          onOpenChange?.(!visible);
        }}
      >
        {children}
      </div>
    );
  },
  MenuTrigger: ({
    render,
    children,
    disabled,
  }: {
    render: ReactElement<{ disabled?: boolean }>;
    children: ReactNode;
    disabled?: boolean;
  }) => cloneElement(render, disabled === undefined ? {} : { disabled }, children),
  MenuPopup: "section",
  MenuItem: "button",
  MenuItemLabel: "span",
  MenuShortcut: "span",
}));

import { OpenInPicker } from "./OpenInPicker";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const editors: readonly EditorId[] = ["vscode"];
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.allowed.clear();
  state.openIde.mockReset();
  state.remote = { mode: "local-exec" };
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.keydown = null;
  state.listeners.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", {
    addEventListener: (_type: string, callback: (event: KeyboardEvent) => void) => {
      state.keydown = callback;
    },
    removeEventListener: (_type: string, callback: (event: KeyboardEvent) => void) => {
      if (state.keydown === callback) state.keydown = null;
    },
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderPicker() {
  await act(async () => {
    for (const listener of state.listeners) listener();
    const node = (
      <OpenInPicker
        environmentId={selected}
        threadId={ThreadId.make("thread")}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={editors}
        openInCwd="/work/project"
        compact
      />
    );
    if (renderer) renderer.update(node);
    else renderer = create(node);
  });
}

function primaryButton() {
  return renderer!.root.findByProps({ "aria-label": "Open file in preferred editor" });
}

function keyboardEvent() {
  return { preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe("host editor access", () => {
  it("uses the selected grant for both the button and a retained shortcut", async () => {
    state.allowed.add(selected);
    await renderPicker();
    const open = primaryButton().props.onClick;
    const keydown = state.keydown!;
    state.allowed.delete(selected);
    state.allowed.add(primary);
    const event = keyboardEvent();
    await act(async () => {
      open();
      keydown(event);
    });
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openIde).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();

    await renderPicker();
    expect(primaryButton().props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Choose editor" }).props.disabled).toBe(true);
    expect(state.keydown).toBeNull();
  });

  it("closes an open picker on revocation and launches only after a fresh grant", async () => {
    state.allowed.add(selected);
    await renderPicker();
    await act(async () => {
      renderer!.root.findByProps({ "data-menu-open": false }).props.onDoubleClick();
    });
    expect(renderer!.root.findByProps({ "data-menu-open": true })).toBeDefined();
    state.allowed.delete(selected);
    await renderPicker();
    expect(renderer!.root.findByProps({ "data-menu-open": false })).toBeDefined();
    state.allowed.add(selected);
    await renderPicker();
    expect(renderer!.root.findByProps({ "data-menu-open": false })).toBeDefined();
    await act(async () => primaryButton().props.onClick());
    expect(state.openIde).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
  });
});

describe("sandbox VS Code", () => {
  it("uses the browser IDE for a remote connection without launching an SSH editor", async () => {
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    state.allowed.add(selected);
    await renderPicker();
    await act(async () => primaryButton().props.onClick());
    expect(state.openIde).toHaveBeenCalledOnce();
    expect(state.openUrl).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
  it("requires sandbox operate permission even when an SSH route exists", async () => {
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    await renderPicker();
    expect(primaryButton().props.disabled).toBe(true);
    await act(async () => primaryButton().props.onClick());
    expect(state.openIde).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();
  });
});
