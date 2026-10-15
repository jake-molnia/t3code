// @effect-diagnostics nodeBuiltinImport:off -- Pure project-ID hashing for the upstream 63-character slug limit.
import * as NodeCrypto from "node:crypto";
import {
  McpConnectionError,
  McpConnectionsState,
  McpConnectionTool,
  McpConnectResult,
  type McpConnectInput,
  type McpSetAccessInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ExecutorRuntime from "./ExecutorRuntime.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const Connection = Schema.Struct({
  address: Schema.String,
  owner: Schema.String,
  integration: Schema.String,
  name: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
});
const Integration = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  displayUrl: Schema.optionalKey(Schema.String),
});
const RemoteTool = Schema.Struct({
  address: Schema.String,
  owner: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  name: Schema.String,
  description: Schema.String,
  static: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const Toolkit = Schema.Struct({ id: Schema.String, slug: Schema.String, owner: Schema.String });
const AccessRow = Schema.Struct({ id: Schema.String, pattern: Schema.String });
const ToolkitList = Schema.Struct({ toolkits: Schema.Array(Toolkit) });
const PolicyList = Schema.Struct({
  policies: Schema.Array(
    Schema.Struct({ id: Schema.String, pattern: Schema.String, action: Schema.String }),
  ),
});
const AccessList = Schema.Struct({ connections: Schema.Array(AccessRow) });
const PendingOAuth = Schema.fromJsonString(
  Schema.Struct({ sessionId: Schema.String, expiresAt: Schema.Number }),
);
const encodePendingOAuth = Schema.encodeSync(PendingOAuth);
const ServerEndpoint = Schema.Struct({ config: Schema.Struct({ endpoint: Schema.String }) });
const encodeSearch = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String, limit: Schema.Number })),
);
const encodeToolPath = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ path: Schema.String })),
);
const Probe = Schema.Struct({
  versionNegotiation: Schema.optionalKey(Schema.Literals(["auto", "legacy"])),
});
const OAuthProbe = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  registrationEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  issuer: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resource: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scopesSupported: Schema.optionalKey(Schema.Array(Schema.String)),
  tokenEndpointAuthMethodsSupported: Schema.optionalKey(Schema.Array(Schema.String)),
});
const OAuthStart = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: Schema.String,
  }),
]);
const PendingExecution = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("waiting_for_interaction"),
    executionId: Schema.String,
  }),
});
const decodePendingExecution = Schema.decodeUnknownOption(PendingExecution);

/** Project identity, never a checkout path, selects the upstream policy. */
export const projectToolkitSlug = (id: ProjectId) =>
  `t3-${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 56)}`;
const connectionPrefix = (connection: typeof Connection.Type) =>
  `${connection.integration}.org.${connection.name}.`;
const connectionPath = (connection: typeof Connection.Type) =>
  `/api/connections/org/${encodeURIComponent(connection.integration)}/${encodeURIComponent(connection.name)}`;
const failure = (reason: McpConnectionError["reason"] = "upstream") =>
  new McpConnectionError({ reason });

export class McpConnections extends Context.Service<
  McpConnections,
  {
    readonly list: Effect.Effect<typeof McpConnectionsState.Type, McpConnectionError>;
    readonly connect: (
      input: McpConnectInput,
      sessionId: string,
    ) => Effect.Effect<typeof McpConnectResult.Type, McpConnectionError>;
    readonly completeAuth: (
      input: { readonly state: string; readonly code: string },
      sessionId: string,
    ) => Effect.Effect<void, McpConnectionError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, McpConnectionError>;
    readonly refresh: (connectionId: string) => Effect.Effect<void, McpConnectionError>;
    readonly tools: (
      connectionId: string,
    ) => Effect.Effect<ReadonlyArray<typeof McpConnectionTool.Type>, McpConnectionError>;
    readonly setAccess: (input: McpSetAccessInput) => Effect.Effect<void, McpConnectionError>;
    readonly call: (input: {
      readonly threadId: ThreadId;
      readonly sessionId: string;
      readonly operation: "search" | "schema" | "execute";
      readonly value: string;
    }) => Effect.Effect<unknown, McpConnectionError>;
    readonly resume: (input: {
      readonly threadId: ThreadId;
      readonly sessionId: string;
      readonly executionId: string;
      readonly action: "accept" | "decline" | "cancel";
      readonly content: string;
    }) => Effect.Effect<unknown, McpConnectionError>;
  }
>()("t3/mcp/McpConnections") {}

const make = Effect.gen(function* () {
  const runtime = yield* ExecutorRuntime.ExecutorRuntime;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const pendingExecutions = new Map<
    string,
    { readonly owner: string; readonly expiresAt: number; inFlight: boolean }
  >();
  const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    runtime.request(method, path, body).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => failure()),
    );
  const mutate = (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    runtime.request(method, path, body).pipe(
      Effect.asVoid,
      Effect.mapError(() => failure()),
    );
  const catalog = Effect.gen(function* () {
    const saved = yield* request(Schema.Array(Connection), "GET", "/api/connections?owner=org");
    const integrations = (yield* request(
      Schema.Array(Integration),
      "GET",
      "/api/integrations",
    )).filter((row) => row.kind === "mcp" && row.slug.startsWith("t3_"));
    const rows = saved
      .filter(
        (row) =>
          row.owner === "org" &&
          integrations.some((integration) => integration.slug === row.integration),
      )
      .map((row) => ({ ...row, connected: true }));
    // Integrations survive credential replacement. Keep their address and grants reachable
    // if creating the replacement failed, including across a central restart.
    for (const integration of integrations)
      if (!rows.some((row) => row.integration === integration.slug)) {
        rows.push({
          address: `tools.${integration.slug}.org.main`,
          owner: "org",
          integration: integration.slug,
          name: "main",
          identityLabel: null,
          connected: false,
        });
      }
    return { rows, integrations };
  });
  const connections = catalog.pipe(Effect.map(({ rows }) => rows));
  const getConnection = Effect.fn("McpConnections.getConnection")(function* (id: string) {
    const found = (yield* connections).find((row) => row.address === id);
    if (!found) return yield* failure("not_found");
    return found;
  });
  const remoteTools = (connection: typeof Connection.Type) =>
    request(
      Schema.Array(RemoteTool),
      "GET",
      `/api/tools?owner=org&integration=${encodeURIComponent(connection.integration)}&connection=${encodeURIComponent(connection.name)}&includeBlocked=true`,
    ).pipe(
      Effect.map((rows) =>
        rows.filter(
          (row) =>
            !row.static &&
            row.owner === "org" &&
            row.integration === connection.integration &&
            row.connection === connection.name,
        ),
      ),
    );
  const toolkitList = request(ToolkitList, "GET", "/api/toolkits");
  const accessRows = (id: string) =>
    request(AccessList, "GET", `/api/toolkits/${encodeURIComponent(id)}/connections`);
  const policyRows = (id: string) =>
    request(PolicyList, "GET", `/api/toolkits/${encodeURIComponent(id)}/policies`);
  const list = Effect.gen(function* () {
    const status = yield* runtime.status;
    if (!status.available) return { available: false, connections: [], access: [] };
    const { rows, integrations } = yield* catalog;
    const { toolkits } = yield* toolkitList;
    const projectRows = yield* projects.list().pipe(Effect.mapError(() => failure()));
    const access: Array<(typeof McpConnectionsState.Type.access)[number]> = [];
    for (const project of projectRows) {
      const toolkit = toolkits.find(
        (row) => row.owner === "org" && row.slug === projectToolkitSlug(project.projectId),
      );
      if (!toolkit) continue;
      const patterns = (yield* accessRows(toolkit.id)).connections.map((row) => row.pattern);
      const policies = (yield* policyRows(toolkit.id)).policies;
      for (const connection of rows) {
        const prefix = connectionPrefix(connection);
        if (policies.some((row) => row.pattern === `${prefix}*` && row.action === "block")) {
          access.push({
            projectId: project.projectId,
            connectionId: connection.address,
            tools: { mode: "selected", toolIds: [] },
          });
        } else if (patterns.includes(`${prefix}*`))
          access.push({
            projectId: project.projectId,
            connectionId: connection.address,
            tools: { mode: "all" },
          });
        else {
          const selected = patterns.filter((pattern) => pattern.startsWith(prefix));
          if (selected.length)
            access.push({
              projectId: project.projectId,
              connectionId: connection.address,
              tools: { mode: "selected", toolIds: selected.map((pattern) => `tools.${pattern}`) },
            });
        }
      }
    }
    return {
      available: true,
      connections: rows.map((row) => {
        const integration = integrations.find((item) => item.slug === row.integration);
        return {
          id: row.address,
          name: integration?.name ?? row.integration,
          url: integration?.displayUrl ?? "",
          account: row.identityLabel,
          needsReconnect: !row.connected,
        };
      }),
      access,
    };
  });
  const tools = Effect.fn("McpConnections.tools")(function* (id: string) {
    const connection = yield* getConnection(id);
    return (yield* remoteTools(connection)).map((tool) => ({
      id: tool.address,
      name: tool.name,
      description: tool.description,
    }));
  });
  const setAccess = Effect.fn("McpConnections.setAccess")(function* (input: McpSetAccessInput) {
    const connection = yield* getConnection(input.connectionId);
    const prefix = connectionPrefix(connection);
    const selectedProjects = yield* projects
      .list({ projectIds: input.projectIds })
      .pipe(Effect.mapError(() => failure()));
    if (
      new Set(selectedProjects.map((project) => project.projectId)).size !==
      new Set(input.projectIds).size
    )
      return yield* failure("not_found");
    const wanted: string[] = [];
    if (input.tools?.mode === "all") wanted.push(`${prefix}*`);
    if (input.tools?.mode === "selected") {
      const catalog = yield* remoteTools(connection);
      for (const id of new Set(input.tools.toolIds)) {
        const tool = catalog.find((row) => row.address === id);
        if (!tool || /[?*[\]{}]/.test(tool.name)) return yield* failure("invalid_input");
        wanted.push(`${prefix}${tool.name}`);
      }
    }
    const { toolkits } = yield* toolkitList;
    for (const project of selectedProjects) {
      const slug = projectToolkitSlug(project.projectId);
      let toolkit = toolkits.find((row) => row.slug === slug && row.owner === "org");
      if (!toolkit && input.tools === null) continue;
      toolkit ??= yield* request(Toolkit, "POST", "/api/toolkits", {
        owner: "org",
        name: project.title,
        slug,
      });
      const path = `/api/toolkits/${encodeURIComponent(toolkit.id)}/connections`;
      const existing = (yield* accessRows(toolkit.id)).connections;
      const policyPath = `/api/toolkits/${encodeURIComponent(toolkit.id)}/policies`;
      const blocks = (yield* policyRows(toolkit.id)).policies.filter(
        (row) => row.pattern === `${prefix}*` && row.action === "block",
      );
      const emptySelection = input.tools?.mode === "selected" && wanted.length === 0;
      // An explicit block preserves selected-but-empty mode without granting any tools.
      if (emptySelection && blocks.length === 0)
        yield* mutate("POST", policyPath, { pattern: `${prefix}*`, action: "block" });
      // Revoke first. A failed update can undergrant, but cannot retain removed access.
      for (const row of existing)
        if (row.pattern.startsWith(prefix) && !wanted.includes(row.pattern))
          yield* mutate("DELETE", `${path}/${encodeURIComponent(row.id)}`);
      for (const pattern of wanted)
        if (!existing.some((row) => row.pattern === pattern))
          yield* mutate("POST", path, { pattern });
      if (!emptySelection)
        for (const row of blocks)
          yield* mutate("DELETE", `${policyPath}/${encodeURIComponent(row.id)}`);
    }
  }, lock.withPermits(1));
  const oauthKey = (state: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(state)).pipe(
      Effect.map((digest) => `mcp-oauth-${Buffer.from(digest).toString("hex")}`),
      Effect.mapError(() => failure()),
    );
  const decodePending = Schema.decodeUnknownEffect(PendingOAuth);
  const completeAuth = Effect.fn("McpConnections.completeAuth")(function* (
    input: { readonly state: string; readonly code: string },
    sessionId: string,
  ) {
    const key = yield* oauthKey(input.state);
    const bytes = yield* secrets.get(key).pipe(Effect.mapError(() => failure("oauth")));
    if (Option.isNone(bytes)) return yield* failure("oauth");
    const pending = yield* decodePending(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => failure("oauth")),
    );
    if (pending.sessionId !== sessionId || pending.expiresAt < (yield* Clock.currentTimeMillis))
      return yield* failure("oauth");
    yield* mutate("POST", "/api/oauth/complete", input);
    yield* secrets.remove(key).pipe(Effect.mapError(() => failure("oauth")));
  }, lock.withPermits(1));
  const connect = Effect.fn("McpConnections.connect")(function* (
    input: McpConnectInput,
    sessionId: string,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(input.url),
      catch: () => failure("invalid_input"),
    });
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return yield* failure("invalid_input");
    const redirect =
      input.auth.type === "oauth"
        ? yield* Effect.try({
            try: () => new URL(input.auth.type === "oauth" ? input.auth.redirectUri : ""),
            catch: () => failure("invalid_input"),
          })
        : undefined;
    if (
      redirect &&
      (!["https:", "http:"].includes(redirect.protocol) ||
        redirect.pathname !== "/settings/mcp" ||
        redirect.search ||
        redirect.hash ||
        redirect.username ||
        redirect.password)
    )
      return yield* failure("invalid_input");
    const existing = input.connectionId ? yield* getConnection(input.connectionId) : undefined;
    const slug =
      existing?.integration ??
      `t3_${(yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => failure()))).replaceAll("-", "")}`;
    const connectionName = existing?.name ?? "main";
    const auth =
      input.auth.type === "token"
        ? { kind: "header", headerName: "Authorization", prefix: "Bearer " }
        : { kind: input.auth.type === "oauth" ? "oauth2" : "none" };
    const probe = yield* request(Probe, "POST", "/api/mcp/probe", {
      endpoint: url.href,
      ...(input.auth.type === "token"
        ? { headers: { Authorization: `Bearer ${input.auth.token}` } }
        : {}),
    });
    if (existing) {
      const server = yield* request(
        ServerEndpoint,
        "GET",
        `/api/mcp/servers/${encodeURIComponent(slug)}`,
      );
      if (new URL(server.config.endpoint).href !== url.href) return yield* failure("invalid_input");
      const authenticationTemplate =
        input.auth.type === "token"
          ? [
              {
                slug: "header",
                type: "apiKey",
                headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
              },
            ]
          : [
              {
                slug: input.auth.type === "oauth" ? "oauth2" : "none",
                kind: input.auth.type === "oauth" ? "oauth2" : "none",
              },
            ];
      yield* mutate("POST", `/api/mcp/servers/${encodeURIComponent(slug)}/auth`, {
        authenticationTemplate,
      });
    } else {
      yield* mutate("POST", "/api/mcp/servers", {
        name: input.name,
        slug,
        endpoint: url.href,
        auth,
        ...probe,
      });
    }
    if (input.auth.type !== "oauth") {
      if (existing?.connected) yield* mutate("DELETE", connectionPath(existing));
      yield* mutate("POST", "/api/connections", {
        owner: "org",
        name: connectionName,
        integration: slug,
        template: input.auth.type === "token" ? "header" : "none",
        ...(input.auth.type === "token" ? { value: input.auth.token } : { values: {} }),
      });
      return { status: "connected" as const };
    }
    if (!redirect) return yield* failure("invalid_input");
    const oauthClient = `${slug}_${(yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => failure()))).replaceAll("-", "")}`;
    const metadata = yield* request(OAuthProbe, "POST", "/api/oauth/probe", { url: url.href });
    if (input.auth.clientId) {
      yield* mutate("POST", "/api/oauth/clients", {
        owner: "org",
        slug: oauthClient,
        grant: "authorization_code",
        clientId: input.auth.clientId,
        clientSecret: input.auth.clientSecret ?? "",
        authorizationUrl: metadata.authorizationUrl,
        tokenUrl: metadata.tokenUrl,
        resource: metadata.resource,
        originIntegration: slug,
      });
    } else {
      if (!metadata.registrationEndpoint) return yield* failure("oauth");
      yield* mutate("POST", "/api/oauth/clients/register-dynamic", {
        owner: "org",
        slug: oauthClient,
        ...metadata,
        scopes: metadata.scopesSupported ?? [],
        redirectUri: redirect.href,
        clientName: "T3 Code",
      });
    }
    const result = yield* request(OAuthStart, "POST", "/api/oauth/start", {
      client: oauthClient,
      clientOwner: "org",
      owner: "org",
      name: connectionName,
      integration: slug,
      template: "oauth2",
      redirectUri: redirect.href,
    });
    if (result.status === "redirect") {
      const key = yield* oauthKey(result.state);
      yield* secrets
        .set(
          key,
          new TextEncoder().encode(
            encodePendingOAuth({
              sessionId,
              expiresAt: (yield* Clock.currentTimeMillis) + 15 * 60_000,
            }),
          ),
        )
        .pipe(Effect.mapError(() => failure()));
    }
    return result.status === "connected"
      ? { status: "connected" as const }
      : { ...result, status: "authorize" as const };
  }, lock.withPermits(1));
  const remove = Effect.fn("McpConnections.remove")(function* (id: string) {
    const connection = yield* getConnection(id);
    // Revoke all project grants before deleting a reusable credential address.
    for (const toolkit of (yield* toolkitList).toolkits.filter(
      (row) => row.owner === "org" && row.slug.startsWith("t3-"),
    )) {
      for (const row of (yield* accessRows(toolkit.id)).connections)
        if (row.pattern.startsWith(connectionPrefix(connection)))
          yield* mutate(
            "DELETE",
            `/api/toolkits/${encodeURIComponent(toolkit.id)}/connections/${encodeURIComponent(row.id)}`,
          );
      for (const row of (yield* policyRows(toolkit.id)).policies)
        if (row.pattern === `${connectionPrefix(connection)}*` && row.action === "block")
          yield* mutate(
            "DELETE",
            `/api/toolkits/${encodeURIComponent(toolkit.id)}/policies/${encodeURIComponent(row.id)}`,
          );
    }
    if (connection.connected) yield* mutate("DELETE", connectionPath(connection));
    yield* mutate("DELETE", `/api/mcp/servers/${encodeURIComponent(connection.integration)}`);
  }, lock.withPermits(1));
  const refresh = Effect.fn("McpConnections.refresh")(function* (id: string) {
    yield* mutate("POST", `${connectionPath(yield* getConnection(id))}/refresh`);
  });
  const scopedToolkit = Effect.fn("McpConnections.scopedToolkit")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(() => failure()));
    if (!thread || thread.deletedAt !== null) return yield* failure("not_found");
    const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(() => failure()));
    if (Option.isNone(project)) return yield* failure("not_found");
    const slug = projectToolkitSlug(thread.projectId);
    const exists = (yield* toolkitList).toolkits.some(
      (row) => row.owner === "org" && row.slug === slug,
    );
    if (!exists) return yield* failure("not_found");
    return slug;
  });
  const rememberPause = Effect.fn("McpConnections.rememberPause")(function* (
    result: unknown,
    owner: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, value] of pendingExecutions)
      if (value.expiresAt < now) pendingExecutions.delete(id);
    const paused = decodePendingExecution(result);
    if (Option.isSome(paused))
      pendingExecutions.set(paused.value.structuredContent.executionId, {
        owner,
        expiresAt: now + 30 * 60_000,
        inFlight: false,
      });
    return result;
  });
  const call: McpConnections["Service"]["call"] = Effect.fn("McpConnections.call")(
    function* (input) {
      const slug = yield* scopedToolkit(input.threadId);
      const owner = `${input.threadId}:${input.sessionId}`;
      const code =
        input.operation === "search"
          ? `return tools.search(${encodeSearch({ query: input.value, limit: 20 })});`
          : input.operation === "schema"
            ? `return tools.describe.tool(${encodeToolPath({ path: input.value })});`
            : input.value;
      const result = yield* runtime
        .callTool(slug, owner, "execute", { code })
        .pipe(Effect.mapError(() => failure()));
      return yield* rememberPause(result, owner);
    },
  );
  const resume: McpConnections["Service"]["resume"] = Effect.fn("McpConnections.resume")(
    function* (input) {
      const owner = `${input.threadId}:${input.sessionId}`;
      const now = yield* Clock.currentTimeMillis;
      const pending = pendingExecutions.get(input.executionId);
      if (!pending || pending.owner !== owner || pending.expiresAt < now || pending.inFlight)
        return yield* failure("not_found");
      pending.inFlight = true;
      return yield* Effect.gen(function* () {
        const slug = yield* scopedToolkit(input.threadId);
        // Consume only when dispatching: a preflight failure is retryable; an ambiguous
        // upstream failure must not replay an approval or external side effect.
        pendingExecutions.delete(input.executionId);
        const result = yield* runtime
          .callTool(slug, owner, "resume", {
            executionId: input.executionId,
            action: input.action,
            content: input.content,
          })
          .pipe(Effect.mapError(() => failure()));
        return yield* rememberPause(result, owner);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.inFlight = false;
          }),
        ),
      );
    },
  );
  return McpConnections.of({
    list,
    connect,
    remove,
    refresh,
    tools,
    setAccess,
    call,
    resume,
    completeAuth,
  });
});

export const layer = Layer.effect(McpConnections, make);
