// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type SandboxIdePreferenceStatus } from "@t3tools/contracts";

const state = vi.hoisted(() => ({ status: "paused" as SandboxIdePreferenceStatus["state"] }));
vi.mock("../../state/shell", () => ({
  shellEnvironment: {
    idePreferenceStatus: () => null,
    resolveIdePreference: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { state: state.status, issues: [] },
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../settings/IdeSetupSettings", () => ({ IdeSetupControls: () => null }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));

import { IdePreferenceStatus } from "./IdePreferenceStatus";

it("shows paused remembering in the toolbar and explains that local changes are not saved", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IdePreferenceStatus
          environmentId={EnvironmentId.make("central")}
          target={{ threadId: ThreadId.make("thread") }}
        />,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Remembering paused");
    expect(container.textContent).not.toContain("Settings saved");
    await act(async () => button?.click());
    expect(document.body.textContent).toContain(
      "Changes stay in this sandbox while remembering is paused.",
    );
    expect(document.body.textContent).not.toContain("Saved for new sandboxes.");
    state.status = "saved";
    await act(async () =>
      root.render(
        <IdePreferenceStatus
          environmentId={EnvironmentId.make("central")}
          target={{ threadId: ThreadId.make("thread") }}
        />,
      ),
    );
    expect(document.body.textContent).toContain("Saved for new sandboxes.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.status = "paused";
  }
});
