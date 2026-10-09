import * as Schema from "effect/Schema";
import type { ServerProvider } from "@t3tools/contracts";

export const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optionalKey(Schema.String),
      supported_endpoints: Schema.Array(Schema.String),
      metadata: Schema.optionalKey(
        Schema.Struct({
          provider: Schema.optionalKey(
            Schema.Struct({ requires_client_auth: Schema.optionalKey(Schema.Boolean) }),
          ),
        }),
      ),
      context_window_tokens: Schema.optionalKey(Schema.Number),
      max_output_tokens: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type Catalog = typeof Catalog.Type;
let active: Catalog | undefined;
export function setApertureCatalog(catalog: Catalog) {
  active = catalog;
}
export function filterApertureSnapshot(snapshot: ServerProvider): ServerProvider {
  if (!active) return snapshot;
  const endpoint =
    snapshot.driver === "grok"
      ? "/v1/chat/completions"
      : snapshot.driver === "claudeAgent"
        ? "/v1/messages"
        : snapshot.driver === "codex"
          ? "/v1/responses"
          : undefined;
  if (!endpoint) return snapshot;
  const allowed = new Set(
    active.data
      .filter((model) => model.supported_endpoints.includes(endpoint))
      .map((model) => model.id),
  );
  if (allowed.size === 0)
    return {
      ...snapshot,
      models: [],
      installed: false,
      enabled: false,
      availability: "unavailable",
      unavailableReason:
        "Aperture has no endpoint-compatible models with managed authentication for this harness",
    };
  return { ...snapshot, models: snapshot.models.filter((model) => allowed.has(model.slug)) };
}

export function nativeApertureConfigs(catalog: Catalog, upstream: string) {
  const groups = [
    {
      name: "aperture",
      endpoint: "/v1/responses",
      pkg: "@opencode/ai/providers/openai/responses",
      api: "openai-responses",
      url: `${upstream}/v1`,
    },
    {
      name: "aperture-chat",
      endpoint: "/v1/chat/completions",
      pkg: "@opencode/ai/providers/openai-compatible",
      api: "openai-completions",
      url: `${upstream}/v1`,
    },
    {
      name: "aperture-anthropic",
      endpoint: "/v1/messages",
      pkg: "@opencode/ai/providers/anthropic",
      api: "anthropic-messages",
      url: upstream,
    },
  ];
  return {
    opencode: {
      providers: Object.fromEntries(
        groups.map((group) => [
          group.name,
          {
            package: group.pkg,
            env: ["APERTURE_API_KEY"],
            settings: { baseURL: group.url, apiKey: "{env:APERTURE_API_KEY}" },
            models: Object.fromEntries(
              catalog.data
                .filter((model) => model.supported_endpoints.includes(group.endpoint))
                .map((model) => [
                  model.id,
                  {
                    name: model.display_name ?? model.id,
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: {
                      ...(model.context_window_tokens
                        ? { context: model.context_window_tokens }
                        : {}),
                      ...(model.max_output_tokens ? { output: model.max_output_tokens } : {}),
                    },
                  },
                ]),
            ),
          },
        ]),
      ),
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      experimental: { portable_shell_scanner: false, policies: [] },
    },
    pi: {
      providers: Object.fromEntries(
        groups.map((group) => [
          group.name,
          {
            baseUrl: group.url,
            api: group.api,
            apiKey: "${APERTURE_API_KEY}",
            models: catalog.data
              .filter((model) => model.supported_endpoints.includes(group.endpoint))
              .map((model) => ({
                id: model.id,
                name: model.display_name ?? model.id,
                ...(model.context_window_tokens
                  ? { contextWindow: model.context_window_tokens }
                  : {}),
                ...(model.max_output_tokens ? { maxTokens: model.max_output_tokens } : {}),
              })),
          },
        ]),
      ),
    },
  };
}

export function managedApertureCatalog(catalog: Catalog): Catalog {
  return {
    data: catalog.data.filter((model) => model.metadata?.provider?.requires_client_auth !== true),
  };
}
