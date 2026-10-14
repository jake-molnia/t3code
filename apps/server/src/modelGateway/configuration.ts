import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class ModelGatewayConfigurationError extends Schema.TaggedError<ModelGatewayConfigurationError>()(
  "ModelGatewayConfigurationError",
  {},
) {
  override get message() {
    return "Configure T3_GATEWAY_MANAGEMENT_URL, T3_GATEWAY_MANAGEMENT_KEY, and T3_GATEWAY_API_KEY together, using an HTTP or HTTPS base URL without credentials, query, or fragment.";
  }
}

export const readConfiguration = (environment: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const url = environment.T3_GATEWAY_MANAGEMENT_URL;
    const managementKey = environment.T3_GATEWAY_MANAGEMENT_KEY;
    const apiKey = environment.T3_GATEWAY_API_KEY;
    if (url === undefined && managementKey === undefined && apiKey === undefined) return undefined;
    if (!url || !managementKey?.trim() || !apiKey?.trim())
      return yield* new ModelGatewayConfigurationError();
    const parsed = yield* Effect.try({
      try: () => new URL(url),
      catch: () => new ModelGatewayConfigurationError(),
    });
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return yield* new ModelGatewayConfigurationError();
    return { url, managementKey, apiKey };
  });
