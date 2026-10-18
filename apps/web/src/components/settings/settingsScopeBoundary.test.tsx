// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SettingsScopeSearch } from "./settingsScope";

const state = vi.hoisted(() => ({
  pathname: "/settings/mcp",
  search: {} as SettingsScopeSearch,
  groups: [] as SidebarProjectSnapshot[],
  navigate: vi.fn(),
  completeAuth: vi.fn(),
  persist: vi.fn(),
  toast: vi.fn(),
  query: Symbol("mcp-state"),
  permission: Symbol("mcp-permission"),
  update: Symbol("update-settings"),
}));
const environmentId = EnvironmentId.make("central");
const projectId = ProjectId.make("selected-project");
const environment = {
  environmentId,
  label: "T3 Code",
  connection: { phase: "connected" as const },
  serverConfig: {
    providers: [],
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { capabilities: { projectSettingsOverrides: true } },
  },
};
const member = {
  id: projectId,
  environmentId,
  title: "Selected project",
  workspaceRoot: "/repo",
  physicalProjectKey: "central:/repo",
  environmentLabel: "T3 Code",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18",
};
const project: SidebarProjectSnapshot = {
  ...member,
  projectKey: "selected",
  displayName: "Selected project",
  memberProjects: [member],
  memberProjectRefs: [{ environmentId, projectId }],
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [],
};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useSearch: () => state.search,
    useNavigate: () => state.navigate,
  }),
  useNavigate: () => state.navigate,
  useLocation: (options?: { select: (location: unknown) => unknown }) => {
    const location = {
      pathname: state.pathname,
      hash: "",
      searchStr: window.location.search,
      state: {},
    };
    return options ? options.select(location) : location;
  },
  Outlet: () =>
    state.pathname === "/settings/mcp" ? (
      <McpSettings />
    ) : (
      <SettingsPageContainer>
        <ProjectDefaultsSettings category="integrations" />
      </SettingsPageContainer>
    ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [environment] }),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  const data = AsyncResult.success({ available: true, connections: [], access: [] });
  const files = new Map();
  return {
    useAtomValue: (atom: unknown) =>
      atom === state.permission ? true : atom === state.query ? data : files,
    useAtomRefresh: () => vi.fn(),
  };
});
vi.mock("../../state/mcpConnections", () => ({
  mcpConnections: {
    state: () => state.query,
    connect: { permissionAtom: () => state.permission },
    completeAuth: { permissionAtom: () => state.permission },
  },
}));
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { updateSettings: state.update },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.update ? state.persist : state.completeAuth,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([environmentId]),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useMigrateModelPreferences: () => undefined,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: (value: unknown) => state.toast(value) } }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => (
    <div>
      <SettingsScopeSentence />
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  SettingResetButton: () => null,
}));
vi.mock("./SettingsBreadcrumb", () => ({ SettingsBreadcrumb: () => null }));
vi.mock("../sidebar/mainAppLocation", () => ({ useNavigateToMainApp: () => vi.fn() }));
vi.mock("../../hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => undefined }));
vi.mock("./SettingsPanels", () => ({ useSettingsRestore: () => ({ changedSettingLabels: [] }) }));

import { McpSettings } from "./McpSettings";
import { SettingsPageContainer } from "./settingsLayout";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { SettingsScopeSentence } from "./SettingsScopeSentence";
import { Route } from "../../routes/settings";
const Layout = Route.options.component!;
await Layout.preload?.();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.groups = [];
  state.search = {};
  state.pathname = "/settings/mcp";
  state.navigate.mockReset();
  state.completeAuth.mockReset().mockResolvedValue({ _tag: "Success" });
  state.persist.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, input.patch),
  }));
  state.toast.mockReset();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/settings/mcp");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<Layout />));

it("completes MCP OAuth after the last project is deleted, without exposing access controls", async () => {
  window.history.replaceState({}, "", "/settings/mcp?state=pending&code=authorization-code");
  sessionStorage.setItem("t3:mcp-oauth:pending", environmentId);
  sessionStorage.setItem("t3:mcp-oauth:pending:scope", "project=deleted");
  await render();
  expect(state.completeAuth).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { state: "pending", code: "authorization-code" },
  });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/settings/mcp",
    search: { project: "deleted" },
    replace: true,
  });
  expect(container.textContent).not.toContain("Project access");
  expect(sessionStorage.getItem("t3:mcp-oauth:pending")).toBeNull();
});

it("keeps retry mounted with an unavailable project", async () => {
  state.search = { project: "deleted" };
  window.history.replaceState({}, "", "/settings/mcp?state=pending&code=authorization-code");
  sessionStorage.setItem("t3:mcp-oauth:pending", environmentId);
  state.completeAuth.mockResolvedValueOnce({ _tag: "Failure" });
  await render();
  const retry = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Retry sign-in"),
  );
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(state.completeAuth).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Project access");
});

it("keeps unavailable non-callback MCP access blocked", async () => {
  state.search = { project: "deleted" };
  await render();
  expect(state.completeAuth).not.toHaveBeenCalled();
  expect(container.textContent).toContain("This project is no longer available");
});

it("saves the integrations browser toggle only for the selected project and shows its picker", async () => {
  state.pathname = "/settings/integrations";
  state.search = { project: "selected" };
  state.groups = [project];
  window.history.replaceState({}, "", "/settings/integrations?project=selected");
  await render();
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle?.click());
  expect(state.persist).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      patch: {
        projectSettingsOverrides: {
          [projectId]: {
            enableAgentBrowserAccess: !DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
          },
        },
      },
    },
  });
  expect(container.querySelector('[aria-label="Project: Selected project"]')).not.toBeNull();
  expect(state.toast).not.toHaveBeenCalled();
});

it("finishes an OAuth denial with a legacy pending record and no project", async () => {
  window.history.replaceState({}, "", "/settings/mcp?state=pending&error=access_denied");
  sessionStorage.setItem("t3:mcp-oauth:pending", environmentId);
  await render();
  expect(state.completeAuth).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/mcp", search: {}, replace: true });
  expect(sessionStorage.getItem("t3:mcp-oauth:pending")).toBeNull();
});

it("does not complete an unowned callback or expose project grants", async () => {
  state.groups = [project];
  state.search = { project: "selected" };
  window.history.replaceState({}, "", "/settings/mcp?state=unowned&code=authorization-code");
  await render();
  expect(state.completeAuth).not.toHaveBeenCalled();
  expect(container.textContent).toContain("This sign-in was not started in this tab");
  expect(container.textContent).not.toContain("Project access");
});

it.each([
  "/settings/mcp?state=pending",
  "/settings/mcp?code=authorization-code",
  "/settings/providers?state=pending&code=authorization-code",
])("does not bypass unavailable project protection for %s", async (url) => {
  window.history.replaceState({}, "", url);
  state.pathname = window.location.pathname;
  state.search = { project: "deleted" };
  sessionStorage.setItem("t3:mcp-oauth:pending", environmentId);
  await render();
  expect(state.completeAuth).not.toHaveBeenCalled();
  expect(container.textContent).toContain("This project is no longer available");
});
