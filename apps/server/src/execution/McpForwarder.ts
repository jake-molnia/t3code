// @effect-diagnostics nodeBuiltinImport:off -- Node transport and durable journal boundary, also consumed outside Effect.
import * as NodeCrypto from "node:crypto";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { authorized } from "./ExecutionWorker.ts";

/** Session endpoints remain stable while central authorization is replaced after reconnect. */
export function createMcpForwarder(
  localOrigin: string,
  request: typeof fetch = fetch,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const sessions = new Map<string, { token: string; config: McpProviderSessionConfig }>();
  return {
    configure(config: McpProviderSessionConfig) {
      const endpoint = new URL(config.endpoint);
      if (!["http:", "https:"].includes(endpoint.protocol))
        throw new Error("Invalid MCP upstream protocol");
      const key = `${config.threadId}:${config.providerSessionId}`;
      const previous = sessions.get(key);
      if (
        previous &&
        (previous.config.threadId !== config.threadId ||
          previous.config.providerInstanceId !== config.providerInstanceId)
      )
        throw new Error("MCP session identity cannot be rebound");
      const token = previous?.token ?? NodeCrypto.randomBytes(32).toString("hex");
      sessions.delete(key);
      sessions.set(key, { token, config });
      const aperture = environment.APERTURE_UPSTREAM;
      const additionalHttpServers = aperture
        ? {
            aperture: {
              url: new URL("v1/mcp", `${aperture.replace(/\/$/, "")}/`).href,
              headers: { Authorization: `Bearer ${environment.APERTURE_API_KEY ?? "-"}` },
            },
          }
        : undefined;
      const local = {
        ...(additionalHttpServers ? { additionalHttpServers } : {}),
        ...config,
        endpoint: new URL(`/mcp/${encodeURIComponent(key)}`, localOrigin).href,
        authorizationHeader: `Bearer ${token}`,
      };
      return local;
    },
    upstreamForProvider(instanceId: McpProviderSessionConfig["providerInstanceId"]) {
      return Array.from(sessions.values())
        .reverse()
        .find((session) => session.config.providerInstanceId === instanceId)?.config;
    },
    removeThread(
      threadId: McpProviderSessionConfig["threadId"],
      instanceId?: McpProviderSessionConfig["providerInstanceId"],
    ) {
      for (const [key, session] of sessions)
        if (
          session.config.threadId === threadId &&
          (instanceId === undefined || session.config.providerInstanceId === instanceId)
        )
          sessions.delete(key);
    },
    remove(sessionId: string) {
      for (const [key, session] of sessions) {
        if (session.config.providerSessionId !== sessionId) continue;
        sessions.delete(key);
      }
    },
    async handle(incoming: Request): Promise<Response> {
      const key = decodeURIComponent(new URL(incoming.url).pathname.slice("/mcp/".length));
      const session = sessions.get(key);
      if (!session || !authorized(incoming.headers.get("authorization"), session.token))
        return new Response(null, { status: 401 });
      if (!["GET", "POST", "DELETE"].includes(incoming.method))
        return new Response(null, { status: 405 });
      const headers = new Headers();
      for (const name of [
        "accept",
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ]) {
        const value = incoming.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set("authorization", session.config.authorizationHeader);
      // Never retry an MCP request: an interrupted response may follow a committed mutation.
      const upstream = await request(session.config.endpoint, {
        method: incoming.method,
        headers,
        signal: incoming.signal,
        ...(incoming.method === "POST" ? { body: await incoming.arrayBuffer() } : {}),
        redirect: "error",
      });
      const responseHeaders = new Headers();
      for (const name of ["content-type", "mcp-session-id", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
  };
}
