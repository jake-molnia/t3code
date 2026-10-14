import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type McpConnection,
  type McpConnectInput,
  type McpConnectionsState,
  type McpToolSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useProjects } from "../../state/entities";
import { mcpConnections } from "../../state/mcpConnections";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { commonMcpSelection } from "./McpSettings.logic";

const pendingAuthKey = (state: string) => `t3:mcp-oauth:${state}`;

export function McpSettings() {
  const { environment } = useSettingsScope();
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  const pendingEnvironment = state ? sessionStorage.getItem(pendingAuthKey(state)) : null;
  const environmentId = pendingEnvironment
    ? EnvironmentId.make(pendingEnvironment)
    : environment?.environmentId;
  return environmentId ? (
    <McpEnvironmentSettings key={environmentId} environmentId={environmentId} />
  ) : (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">
        Connect an environment to manage MCP connections.
      </p>
    </SettingsPageContainer>
  );
}

function McpEnvironmentSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const query = mcpConnections.state({ environmentId, input: {} });
  const result = useAtomValue(query);
  const reload = useAtomRefresh(query);
  const data = Option.getOrNull(AsyncResult.value(result));
  const canConnect = useAtomValue(mcpConnections.connect.permissionAtom(environmentId));
  const canCompleteAuth = useAtomValue(mcpConnections.completeAuth.permissionAtom(environmentId));
  const completeAuth = useAtomCommand(mcpConnections.completeAuth);
  const navigate = useNavigate();
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [selectedProjects, setSelectedProjects] = useState<readonly ProjectId[]>([]);
  const [adding, setAdding] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state");
    if (!state || (!params.has("code") && !params.has("error"))) return null;
    return sessionStorage.getItem(pendingAuthKey(state)) === environmentId
      ? "Completing sign-in…"
      : "This sign-in was not started in this tab. Add the connection again.";
  });
  const authStarted = useRef<number | null>(null);
  const [authRetry, setAuthRetry] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const selected = selectedProjects.filter((id) => projects.some((project) => project.id === id));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state");
    const code = params.get("code");
    const error = params.get("error");
    if ((!code && !error) || !state || authStarted.current === authAttempt || !canCompleteAuth)
      return;
    authStarted.current = authAttempt;
    if (sessionStorage.getItem(pendingAuthKey(state)) !== environmentId) return;
    const finish = async () => {
      const outcome =
        code && !error ? await completeAuth({ environmentId, input: { state, code } }) : null;
      if (code && !error && outcome?._tag !== "Success") {
        setAuthMessage("Sign-in could not be completed. Retry, or add the connection again.");
        setAuthRetry(true);
        return;
      }
      setAuthMessage(
        outcome?._tag === "Success"
          ? "Connection added."
          : "Sign-in could not be completed. Add the connection again.",
      );
      sessionStorage.removeItem(pendingAuthKey(state));
      await navigate({ to: "/settings/mcp", search: { machine: environmentId }, replace: true });
      reload();
    };
    void finish();
  }, [authAttempt, canCompleteAuth, completeAuth, environmentId, navigate, reload]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        variant="plain"
        id="mcp-connections"
        title="MCP"
        headerAction={
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.available || !canConnect}
            onClick={() => setAdding(!adding)}
          >
            <PlusIcon className="size-4" />
            Add connection
          </Button>
        }
      >
        <div className="grid gap-4">
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            Connect once, then choose which projects and tools have access.
          </p>
          {authMessage ? (
            <p role="status" className="text-sm text-muted-foreground">
              {authMessage}
            </p>
          ) : null}
          {authRetry ? (
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={!canCompleteAuth}
                onClick={() => {
                  setAuthRetry(false);
                  setAuthMessage("Completing sign-in…");
                  setAuthAttempt((attempt) => attempt + 1);
                }}
              >
                Retry sign-in
              </Button>
            </div>
          ) : null}
          {AsyncResult.isFailure(result) ? (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-sm text-destructive">
                Could not load MCP connections.
              </p>
              <Button size="sm" variant="outline" onClick={reload}>
                Retry
              </Button>
            </div>
          ) : null}
          {!data && !AsyncResult.isFailure(result) ? (
            <p className="text-sm text-muted-foreground">Loading connections…</p>
          ) : null}
          {data && !data.available ? (
            <p className="text-sm text-muted-foreground">
              MCP connections are unavailable on this environment.
            </p>
          ) : null}
          {adding ? (
            <AddMcpConnection
              environmentId={environmentId}
              onDone={() => {
                setAdding(false);
                reload();
              }}
              onCancel={() => setAdding(false)}
            />
          ) : null}
          {data?.available ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Menu>
                  <MenuTrigger render={<Button variant="outline" size="sm" />}>
                    {selected.length === 0
                      ? "Choose projects"
                      : selected.length === 1
                        ? projects.find((project) => project.id === selected[0])?.title
                        : `${selected.length} projects`}
                    <ChevronDownIcon className="size-4" />
                  </MenuTrigger>
                  <MenuPopup>
                    {projects.map((project) => (
                      <MenuCheckboxItem
                        key={project.id}
                        checked={selected.includes(project.id)}
                        closeOnClick={false}
                        onCheckedChange={(checked) =>
                          setSelectedProjects(
                            checked
                              ? [...selected, project.id]
                              : selected.filter((id) => id !== project.id),
                          )
                        }
                      >
                        {project.title}
                      </MenuCheckboxItem>
                    ))}
                  </MenuPopup>
                </Menu>
                <p className="text-xs text-muted-foreground">
                  {projects.length === 0
                    ? "Create a project to assign connections."
                    : "Select one or more projects to edit access together."}
                </p>
              </div>
              {data.connections.length === 0 ? (
                <p className="text-sm text-muted-foreground">No connections yet.</p>
              ) : (
                data.connections.map((connection) => (
                  <McpConnectionCard
                    key={`${connection.id}:${selected.join(",")}`}
                    environmentId={environmentId}
                    connection={connection}
                    projectIds={selected}
                    access={data.access}
                    onChanged={reload}
                    refreshing={result.waiting}
                  />
                ))
              )}
            </>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function AddMcpConnection({
  environmentId,
  onDone,
  onCancel,
  connection,
}: {
  environmentId: EnvironmentId;
  onDone: () => void;
  onCancel: () => void;
  connection?: McpConnection;
}) {
  const connect = useAtomCommand(mcpConnections.connect);
  const canConnect = useAtomValue(mcpConnections.connect.permissionAtom(environmentId));
  const [name, setName] = useState(connection?.name ?? "");
  const [url, setUrl] = useState(connection?.url ?? "");
  const [auth, setAuth] = useState<"none" | "token" | "oauth">("oauth");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    const input: McpConnectInput = {
      ...(connection ? { connectionId: connection.id } : {}),
      name: name.trim(),
      url: url.trim(),
      auth:
        auth === "none"
          ? { type: "none" }
          : auth === "token"
            ? { type: "token", token }
            : {
                type: "oauth",
                redirectUri: `${window.location.origin}/settings/mcp`,
                ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
                ...(clientSecret ? { clientSecret } : {}),
              },
    };
    try {
      const result = await connect({ environmentId, input });
      if (result._tag !== "Success") return;
      setToken("");
      setClientSecret("");
      if (result.value.status === "connected") onDone();
      else {
        sessionStorage.setItem(pendingAuthKey(result.value.state), environmentId);
        setAuthorizationUrl(result.value.authorizationUrl);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup>
      <form
        className="grid gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset
          disabled={busy || !canConnect || authorizationUrl !== null}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                maxLength={120}
                required
                placeholder="My integration"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                value={url}
                required
                placeholder="https://example.com/mcp"
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-auth">Authentication</Label>
            <Select
              value={auth}
              onValueChange={(value) => {
                if (value === "none" || value === "token" || value === "oauth") setAuth(value);
              }}
            >
              <SelectTrigger id="mcp-auth">
                <SelectValue>
                  {auth === "oauth"
                    ? "Sign in"
                    : auth === "token"
                      ? "Access token"
                      : "No authentication"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="oauth">Sign in</SelectItem>
                <SelectItem value="token">Access token</SelectItem>
                <SelectItem value="none">No authentication</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {auth === "token" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-token">Access token</Label>
              <Input
                id="mcp-token"
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
          ) : null}
          {auth === "oauth" ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Custom OAuth client (optional)
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-client-id">Client ID</Label>
                  <Input
                    id="mcp-client-id"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-client-secret">Client secret</Label>
                  <Input
                    id="mcp-client-secret"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </div>
              </div>
            </details>
          ) : null}
        </fieldset>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {authorizationUrl ? (
            <Button render={<a href={authorizationUrl} />}>Continue sign-in</Button>
          ) : (
            <Button type="submit" disabled={busy || !canConnect || !name.trim() || !url.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </form>
    </SettingsGroup>
  );
}

function McpConnectionCard({
  environmentId,
  connection,
  projectIds,
  access,
  onChanged,
  refreshing,
}: {
  environmentId: EnvironmentId;
  connection: McpConnection;
  projectIds: readonly ProjectId[];
  access: typeof McpConnectionsState.Type.access;
  onChanged: () => void;
  refreshing: boolean;
}) {
  const savedSelection = commonMcpSelection(projectIds, access, connection.id);
  const [choosingTools, setChoosingTools] = useState(false);
  const selection: McpToolSelection | null | "mixed" =
    choosingTools && savedSelection === null ? { mode: "selected", toolIds: [] } : savedSelection;
  const setAccess = useAtomCommand(mcpConnections.setAccess);
  const remove = useAtomCommand(mcpConnections.remove);
  const refresh = useAtomCommand(mcpConnections.refresh);
  const reloadTools = useAtomRefresh(
    mcpConnections.tools({ environmentId, input: { connectionId: connection.id } }),
  );
  const canSetAccess = useAtomValue(mcpConnections.setAccess.permissionAtom(environmentId));
  const canConnect = useAtomValue(mcpConnections.connect.permissionAtom(environmentId));
  const canRemove = useAtomValue(mcpConnections.remove.permissionAtom(environmentId));
  const canRefresh = useAtomValue(mcpConnections.refresh.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const save = async (tools: McpToolSelection | null) => {
    setBusy(true);
    try {
      const result = await setAccess({
        environmentId,
        input: { projectIds, connectionId: connection.id, tools },
      });
      if (result._tag === "Success") onChanged();
    } finally {
      setBusy(false);
    }
  };
  const assignedProjects = new Set(
    access
      .filter(
        (entry) =>
          entry.connectionId === connection.id &&
          (entry.tools.mode === "all" || entry.tools.toolIds.length > 0),
      )
      .map((entry) => entry.projectId),
  ).size;
  const mode = selection === "mixed" ? "mixed" : (selection?.mode ?? "off");
  return (
    <SettingsGroup>
      <div className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{connection.name}</h3>
            <p className="break-all text-xs text-muted-foreground">{connection.url}</p>
            <p className="text-xs text-muted-foreground">
              Available to {assignedProjects} {assignedProjects === 1 ? "project" : "projects"}.
            </p>
            {connection.account ? (
              <p className="text-xs text-muted-foreground">{connection.account}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !canConnect}
              onClick={() => setReconnecting(!reconnecting)}
            >
              Reconnect
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !canRefresh}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await refresh({
                    environmentId,
                    input: { connectionId: connection.id },
                  });
                  if (result._tag === "Success") {
                    reloadTools();
                    onChanged();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              Refresh tools
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !canRemove}
              onClick={() => setConfirmRemove(!confirmRemove)}
            >
              Disconnect
            </Button>
          </div>
        </div>
        {reconnecting ? (
          <AddMcpConnection
            environmentId={environmentId}
            connection={connection}
            onCancel={() => setReconnecting(false)}
            onDone={() => {
              setReconnecting(false);
              reloadTools();
              onChanged();
            }}
          />
        ) : null}
        {confirmRemove ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">Disconnect from every project?</p>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !canRemove}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await remove({
                    environmentId,
                    input: { connectionId: connection.id },
                  });
                  if (result._tag === "Success") onChanged();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {projectIds.length > 0 ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`mcp-access-${connection.id}`}>Project access</Label>
              <Select
                value={mode}
                disabled={busy || refreshing || !canSetAccess}
                onValueChange={(value) => {
                  setChoosingTools(value === "selected");
                  if (value === "off") void save(null);
                  if (value === "all") void save({ mode: "all" });
                  if (value === "selected") void save({ mode: "selected", toolIds: [] });
                }}
              >
                <SelectTrigger id={`mcp-access-${connection.id}`}>
                  <SelectValue>
                    {mode === "mixed"
                      ? "Different across projects"
                      : mode === "off"
                        ? "Disabled"
                        : mode === "all"
                          ? "All tools, including new tools"
                          : "Selected tools only"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {mode === "mixed" ? (
                    <SelectItem value="mixed" disabled>
                      Different across projects
                    </SelectItem>
                  ) : null}
                  <SelectItem value="off">Disabled</SelectItem>
                  <SelectItem value="all">All tools, including new tools</SelectItem>
                  <SelectItem value="selected">Selected tools only</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {selection !== null && selection !== "mixed" && selection.mode === "selected" ? (
              <McpTools
                environmentId={environmentId}
                connectionId={connection.id}
                selection={selection}
                disabled={busy || refreshing || !canSetAccess}
                onSave={(toolIds) => void save({ mode: "selected", toolIds })}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function McpTools({
  environmentId,
  connectionId,
  selection,
  disabled,
  onSave,
}: {
  environmentId: EnvironmentId;
  connectionId: string;
  selection: Extract<McpToolSelection, { mode: "selected" }>;
  disabled: boolean;
  onSave: (toolIds: readonly string[]) => void;
}) {
  const query = mcpConnections.tools({ environmentId, input: { connectionId } });
  const result = useAtomValue(query);
  const reload = useAtomRefresh(query);
  const tools = Option.getOrNull(AsyncResult.value(result));
  const [search, setSearch] = useState("");
  return (
    <div className="grid gap-2">
      {selection.toolIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tools are enabled. Select tools to give these projects access.
        </p>
      ) : null}
      <Input
        aria-label="Filter tools"
        placeholder="Filter tools…"
        size="sm"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {AsyncResult.isFailure(result) ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            Could not load tools.
          </p>
          <Button size="xs" variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : !tools ? (
        <p className="text-xs text-muted-foreground">Loading tools…</p>
      ) : (
        <div className="grid max-h-72 gap-3 overflow-y-auto py-1">
          {tools
            .filter((tool) =>
              `${tool.name} ${tool.description}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((tool) => (
              <label key={tool.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  disabled={disabled}
                  checked={selection.toolIds.includes(tool.id)}
                  onCheckedChange={(checked) =>
                    onSave(
                      checked
                        ? [...selection.toolIds, tool.id]
                        : selection.toolIds.filter((id) => id !== tool.id),
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="break-words">{tool.name}</span>
                  {tool.description ? (
                    <span className="block text-xs text-muted-foreground">{tool.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          {tools.length === 0 ? (
            <p className="text-xs text-muted-foreground">This connection has no tools.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
