// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type IdeSetupState,
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
  persistClient: vi.fn(),
  cleanup: vi.fn(),
  canWrite: true,
  canCleanup: true,
  mixedPatch: false,
  inspectTargets: false,
  inspectIde: false,
  remoteConnected: true,
  ideSetup: vi.fn(),
  ideManage: vi.fn(),
  ideManageCommand: { permissionAtom: () => state.permission },
  fileUnavailable: false,
  fileContents: "{}",
  readFile: vi.fn(),
  toast: vi.fn(),
  query: Symbol("mcp-state"),
  permission: Symbol("mcp-permission"),
  update: Symbol("update-settings"),
  runCleanup: { permissionAtom: () => cleanupPermission() },
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
    environment: {
      platform: { machine: "linux" },
      capabilities: {
        projectSettingsOverrides: true,
        projectWorktreeCleanup: true,
        storageCleanup: true,
        storageCleanupRun: true,
      },
    },
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
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () =>
    state.inspectIde ? (
      <IdeSetupSettingsPanel
        target={{ threadId: ThreadId.make("remote-thread") }}
        targetEnvironmentId={EnvironmentId.make("remote")}
      />
    ) : state.inspectTargets ? (
      <EffectiveSettingsProbe />
    ) : state.mixedPatch ? (
      <MixedPatchProbe />
    ) : state.pathname === "/settings/general" ? (
      <GeneralSettingsPanel />
    ) : state.pathname === "/settings/storage" ? (
      <StorageSettingsPanel />
    ) : state.pathname === "/settings/mcp" ? (
      <McpSettings />
    ) : (
      <SettingsPageContainer>
        <ProjectDefaultsSettings category="integrations" />
      </SettingsPageContainer>
    ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments:
      state.inspectIde && state.remoteConnected
        ? [
            environment,
            { ...environment, environmentId: EnvironmentId.make("remote"), label: "Remote" },
          ]
        : [environment],
  }),
  usePrimaryEnvironmentId: () => environmentId,
  usePrimaryEnvironment: () => environment,
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult, Atom, AtomRegistry } = await import("effect/reactivity");
  const data = AsyncResult.success({ available: true, connections: [], access: [] });
  const registry = AtomRegistry.make();
  return {
    useAtomValue: (atom: unknown) =>
      atom === state.permission
        ? true
        : atom === state.query
          ? data
          : Atom.isAtom(atom)
            ? registry.get(atom)
            : null,
    useAtomRefresh: () => vi.fn(),
  };
});
vi.mock("../files/projectFilesQueryState", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../files/projectFilesQueryState")>()),
    optimisticFileAtom: () => Atom.make(null),
  };
});
vi.mock("../../state/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/projects")>()),
  projectEnvironment: { readFile: (...args: unknown[]) => state.readFile(...args) },
}));
vi.mock("../../state/shell", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/shell")>();
  return {
    ...original,
    shellEnvironment: {
      ...original.shellEnvironment,
      ideSetup: (...args: unknown[]) => state.ideSetup(...args),
      manageIdeSetup: state.ideManageCommand,
    },
  };
});
vi.mock("../../assets/assetUrls", () => ({ useAssetUrlState: () => ({ url: null }) }));
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
  serverEnvironment: {
    updateSettings: state.update,
    runStorageCleanup: state.runCleanup,
    storageCleanupReport: () => cleanupReport,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.ideManageCommand
      ? state.ideManage
      : command === state.update
        ? state.persist
        : command === state.runCleanup
          ? state.cleanup
          : state.completeAuth,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => state.canWrite,
  useEnvironmentScope: () => state.canWrite,
  useEnvironmentsWithScope: () => new Set(state.canWrite ? [environmentId] : []),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useMigrateModelPreferences: () => undefined,
  persistClientSettingsPatch: (patch: unknown) => state.persistClient(patch),
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: (value: unknown) => state.toast(value) } }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  useRelativeTimeTick: () => undefined,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => (
    <div>
      <SettingsScopeSentence />
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingResetButton: () => null,
}));
vi.mock("./SettingsBreadcrumb", () => ({ SettingsBreadcrumb: () => null }));
vi.mock("../sidebar/mainAppLocation", () => ({ useNavigateToMainApp: () => vi.fn() }));
vi.mock("../../hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => undefined }));
vi.mock("./SettingsPanels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsPanels")>()),
  useSettingsRestore: () => ({ changedSettingLabels: [] }),
}));
vi.mock("./NotificationSettings", () => ({ NotificationSettings: () => null }));
vi.mock("./ServerVersionSection", () => ({ ServerVersionSection: () => null }));
vi.mock("./HostedAppChannelSection", () => ({ HostedAppChannelSection: () => null }));

import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useSettingsScope } from "./SettingsScopeContext";
import { useUpdateScopedSettings } from "./useScopedSettings";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { StorageSettingsPanel } from "./StorageSettings";
const cleanupPermission = () => Atom.make(state.canCleanup);
const cleanupReport = Atom.make(AsyncResult.success(null));
import { IdeSetupSettingsPanel } from "./IdeSetupSettings";
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
  state.persistClient.mockReset();
  state.cleanup.mockReset().mockResolvedValue({ _tag: "Success", value: { entries: [] } });
  state.canWrite = true;
  state.mixedPatch = false;
  state.inspectTargets = false;
  state.inspectIde = false;
  state.remoteConnected = true;
  state.ideManage.mockReset().mockResolvedValue({ _tag: "Success" });
  const ideState: IdeSetupState = {
    stage: "ready",
    remembering: true,
    settingsRevision: "saved",
    settingsMatch: true,
    previousSettingsRevision: null,
    extensions: [],
    build: { state: "idle" },
    publishedRevision: null,
    previousPublishedRevision: null,
    appliedRevision: null,
    preferences: { state: "saved", issues: [] },
  };
  state.ideSetup.mockReset().mockReturnValue(Atom.make(AsyncResult.success(ideState)));
  state.fileUnavailable = false;
  state.fileContents = "{}";
  state.readFile
    .mockReset()
    .mockImplementation(() =>
      Atom.make(
        state.fileUnavailable
          ? AsyncResult.failure(Cause.fail(new Error("Workspace is stopped")))
          : AsyncResult.success({ contents: state.fileContents, truncated: false }),
      ),
    );
  state.canCleanup = true;
  environment.serverConfig.settings = DEFAULT_SERVER_SETTINGS;
  environment.serverConfig.environment.capabilities.projectSettingsOverrides = true;
  environment.serverConfig.environment.capabilities.projectWorktreeCleanup = true;
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

it.each([{}, { project: "deleted" }])(
  "keeps General client preferences editable without a project (%j)",
  async (search) => {
    state.pathname = "/settings/general";
    state.search = search;
    await render();
    const notifications = container.querySelector<HTMLButtonElement>(
      '[aria-label="In-app notifications"]',
    );
    expect(notifications).not.toBeNull();
    await act(async () => notifications?.click());
    expect(state.persistClient).toHaveBeenCalledWith({
      inAppNotificationsEnabled: !DEFAULT_CLIENT_SETTINGS.inAppNotificationsEnabled,
    });
    const projectSetting = container.querySelector(
      '[aria-label="Start new worktrees from origin by default"]',
    );
    expect(projectSetting).not.toBeNull();
    expect(projectSetting?.closest("[inert]")).not.toBeNull();
    expect(state.persist).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "saves shared retention and runs authorized cleanup with project overrides supported=%s",
  async (projectOverrides) => {
    state.pathname = "/settings/storage";
    state.search = { project: "selected" };
    state.groups = [project];
    environment.serverConfig.environment.capabilities.projectSettingsOverrides = projectOverrides;
    environment.serverConfig.environment.capabilities.projectWorktreeCleanup = projectOverrides;
    environment.serverConfig.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup: {
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        logsAfterDays: 8,
      },
    };
    await render();
    const retention = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete old browser artifacts"]',
    );
    expect(retention).not.toBeNull();
    await act(async () => retention?.click());
    expect(state.persist).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { storageCleanup: { browserArtifactsAfterDays: 8 } } },
    });
    const cleanup = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete now",
    );
    expect(cleanup).toBeDefined();
    await act(async () => cleanup?.click());
    expect(state.cleanup).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    expect(container.textContent).toContain("all projects");
  },
);

function MixedPatchProbe() {
  const update = useUpdateScopedSettings();
  return (
    <button
      onClick={() =>
        update({
          diffIgnoreWhitespace: false,
          enableProviderUpdateChecks: false,
          defaultAutoPull: true,
        })
      }
    >
      Save mixed settings
    </button>
  );
}

it.each([{}, { project: "deleted" }])(
  "saves central General settings without a valid project (%j)",
  async (search) => {
    state.pathname = "/settings/general";
    state.search = search;
    // A stale explicit selection must not borrow this other project's policy.
    if (search.project) state.groups = [project];
    await render();
    const shared = container.querySelector<HTMLButtonElement>(
      '[aria-label="Auto-resume limited threads"]',
    );
    expect(shared).not.toBeNull();
    expect(shared?.closest("[inert]")).toBeNull();
    await act(async () => shared?.click());
    expect(state.persist).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        patch: {
          autoResumeLimitedThreads: !DEFAULT_SERVER_SETTINGS.autoResumeLimitedThreads,
        },
      },
    });
    expect(
      container
        .querySelector('[aria-label="Start new worktrees from origin by default"]')
        ?.closest("[inert]"),
    ).not.toBeNull();
  },
);

it.each([true, false])(
  "saves only authorized parts of a mixed patch with unsupported project overrides (write=%s)",
  async (allowed) => {
    state.pathname = "/settings/general";
    state.search = { project: "selected" };
    state.groups = [project];
    state.mixedPatch = true;
    state.canWrite = allowed;
    environment.serverConfig.environment.capabilities.projectSettingsOverrides = false;
    await render();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save mixed settings",
    );
    expect(save).toBeDefined();
    await act(async () => save?.click());
    expect(state.persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    if (allowed)
      expect(state.persist).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { patch: { enableProviderUpdateChecks: false } },
      });
    else expect(state.persist).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Some settings not saved",
        description: expect.stringContaining("update"),
      }),
    );
    if (!allowed)
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Setting not saved" }),
      );
  },
);

it("keeps central retention reachable with no projects and enforces separate cleanup permission", async () => {
  state.pathname = "/settings/storage";
  state.canCleanup = false;
  environment.serverConfig.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, logsAfterDays: 8 },
  };
  await render();
  const retention = container.querySelector<HTMLButtonElement>(
    '[aria-label="Delete old rotated logs"]',
  );
  expect(retention).not.toBeNull();
  await act(async () => retention?.click());
  expect(state.persist).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { patch: { storageCleanup: { logsAfterDays: null } } },
  });
  const cleanup = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete now",
  );
  expect(cleanup?.disabled).toBe(true);
  await act(async () => cleanup?.click());
  expect(state.cleanup).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Automatic worktree cleanup"]')).toBeNull();
});

it("keeps client preferences usable when shared settings writes are denied", async () => {
  state.pathname = "/settings/general";
  state.canWrite = false;
  await render();
  const client = container.querySelector<HTMLButtonElement>('[aria-label="In-app notifications"]');
  await act(async () => client?.click());
  expect(state.persistClient).toHaveBeenCalledOnce();
  const shared = container.querySelector<HTMLButtonElement>(
    '[aria-label="Auto-resume limited threads"]',
  );
  expect(shared?.closest("[inert]")).not.toBeNull();
  // Even a programmatic click that bypasses DOM inertness must not issue an RPC.
  await act(async () => shared?.click());
  expect(state.persist).not.toHaveBeenCalled();
});

it("All projects shows mixed browser policy and writes explicit existing-project overrides", async () => {
  const otherId = ProjectId.make("other-project");
  const otherMember = { ...member, id: otherId, physicalProjectKey: "central:/other" };
  state.pathname = "/settings/integrations";
  state.groups = [project, { ...project, projectKey: "other", memberProjects: [otherMember] }];
  environment.serverConfig.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: { enableAgentBrowserAccess: true },
      [otherId]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
    },
  };
  await render();
  const picker = container.querySelector<HTMLButtonElement>('[aria-label="Project: All projects"]');
  expect(picker).not.toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Agent browser access"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("mixed");
  await act(async () => toggle?.click());
  expect(state.persist).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      patch: {
        projectSettingsOverrides: {
          [projectId]: { enableAgentBrowserAccess: true },
          [otherId]: { enableAgentBrowserAccess: true, defaultAutoPull: true },
        },
      },
    },
  });
  await act(async () => picker?.click());
  expect(document.body.textContent).toContain("All projects");
  expect(document.querySelector('[aria-label^="Environment scope"]')).toBeNull();
});

function EffectiveSettingsProbe() {
  const { targets } = useSettingsScope();
  return (
    <output>
      {JSON.stringify(
        targets.map((target) => ({
          projectId: target.projectId,
          submodules: target.settings.worktreeSubmodules,
          source: target.sources.worktreeSubmodules,
        })),
      )}
    </output>
  );
}

it.each([
  [true, null, "recursive", "environment"],
  [true, "top-level", "top-level", "environment"],
  [false, null, "top-level", "t3.json"],
] as const)(
  "All-project reads stay passive (unavailable=%s, stored=%s) and respect project overrides",
  async (unavailable, stored, expected, source) => {
    const otherId = ProjectId.make("passive-other");
    const otherMember = {
      ...member,
      id: otherId,
      workspaceRoot: "/other",
      physicalProjectKey: "central:/other",
    };
    state.pathname = "/settings/general";
    state.groups = [project, { ...project, projectKey: "other", memberProjects: [otherMember] }];
    state.inspectTargets = true;
    state.fileUnavailable = unavailable;
    state.fileContents = '{"worktreeSubmodules":"top-level"}';
    environment.serverConfig.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreeSubmodules: stored,
      projectSettingsOverrides: { [projectId]: { worktreeSubmodules: "none" } },
    };
    await render();
    expect(container.querySelector("output")?.textContent).toBe(
      JSON.stringify([
        { projectId, submodules: "none", source: "project" },
        { projectId: otherId, submodules: expected, source },
      ]),
    );
    expect(state.readFile).toHaveBeenCalled();
    for (const [request] of state.readFile.mock.calls) {
      expect(request).toMatchObject({
        environmentId,
        input: { relativePath: "t3.json", passive: true },
      });
    }
    expect(new Set(state.readFile.mock.calls.map(([request]) => request.input.cwd))).toEqual(
      new Set(["/repo", "/other"]),
    );
  },
);

it("keeps selected-project file reads unchanged", async () => {
  state.pathname = "/settings/general";
  state.search = { project: "selected" };
  state.groups = [project];
  state.inspectTargets = true;
  await render();
  expect(state.readFile).toHaveBeenCalled();
  for (const [request] of state.readFile.mock.calls) {
    expect(request.input).toEqual({ cwd: "/repo", relativePath: "t3.json" });
  }
});

it("manages the linked remote IDE setup rather than the primary environment", async () => {
  state.pathname = "/settings/ide";
  state.search = { machine: "remote" };
  state.inspectIde = true;
  await render();
  expect(state.ideSetup).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { target: { threadId: "remote-thread" } },
  });
  const pause = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Pause remembering"),
  );
  expect(pause).toBeDefined();
  await act(async () => pause?.click());
  expect(state.ideManage).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { target: { threadId: "remote-thread" }, command: { kind: "remember", enabled: false } },
  });
});

it("does not fall back to primary settings when the linked IDE environment is unavailable", async () => {
  state.pathname = "/settings/ide";
  state.search = { machine: "remote" };
  state.inspectIde = true;
  state.remoteConnected = false;
  await render();
  expect(state.ideSetup).not.toHaveBeenCalled();
  expect(state.ideManage).not.toHaveBeenCalled();
});
