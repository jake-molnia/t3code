// @effect-diagnostics nodeBuiltinImport:off -- Worker deployment configuration boundary.
import * as NodeFS from "node:fs";
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

const Defaults = Schema.Record(
  Schema.String,
  Schema.Struct({
    config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    environment: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
          value: Schema.String,
          sensitive: Schema.Boolean,
        }),
      ),
    ),
  }),
);
const decodeDefaults = Schema.decodeUnknownSync(Schema.fromJsonString(Defaults));
const decodeConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** Operator defaults are applied only in the worker, never written into central settings. */
export function harnessDefaults(
  text: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  mode: "defaults" | "gateway" = "defaults",
): (instance: ProviderInstanceConfig) => ProviderInstanceConfig {
  const defaults = text === undefined ? {} : decodeDefaults(text);
  const expand = (value: string): string =>
    value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined) throw new Error(`Harness configuration requires ${name}`);
      return resolved;
    });
  const expandConfig = (value: unknown): unknown => {
    if (typeof value === "string") return expand(value);
    if (Array.isArray(value)) return value.map(expandConfig);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, expandConfig(child)]),
      );
    return value;
  };
  return (instance) => {
    const override = defaults[instance.driver];
    if (!override || instance.enabled === false) return instance;
    const variables = new Map((instance.environment ?? []).map((entry) => [entry.name, entry]));
    for (const entry of override.environment ?? [])
      if (mode === "gateway" || !variables.has(entry.name))
        variables.set(entry.name, { ...entry, value: expand(entry.value) });
    const config = decodeConfig(instance.config ?? {});
    const configured =
      override.config === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(override.config)
              .filter(([key]) => mode === "gateway" || !(key in config))
              .map(([key, value]) => [key, expandConfig(value)]),
          );
    return {
      ...instance,
      ...(configured
        ? {
            config:
              mode === "gateway" ? { ...config, ...configured } : { ...configured, ...config },
          }
        : {}),
      environment: [...variables.values()],
    };
  };
}

/** Launch eligibility is separate from configuration: disabled providers can retain history. */
export function validateHarnessLaunch(
  instance: ProviderInstanceConfig,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    instance.enabled !== false &&
    environment.T3_GATEWAY_URL &&
    ["cursor", "muse", "antigravity"].includes(instance.driver)
  ) {
    throw new Error(
      `${instance.driver} requires native provider authentication and cannot use model gateway credentials`,
    );
  }
}

export function deploymentHarnessDefaults() {
  const path = process.env.T3_HARNESS_DEFAULTS_FILE;
  const defaults = harnessDefaults(path ? NodeFS.readFileSync(path, "utf8") : undefined);
  if (!process.env.T3_GATEWAY_URL) return defaults;
  const gatewayPath = process.env.T3_GATEWAY_HARNESS_CONFIG_FILE;
  if (!gatewayPath) throw new Error("Gateway execution requires T3_GATEWAY_HARNESS_CONFIG_FILE");
  const gateway = harnessDefaults(NodeFS.readFileSync(gatewayPath, "utf8"), process.env, "gateway");
  return (instance: ProviderInstanceConfig) => gateway(defaults(instance));
}

export function sandboxPolicy(
  policy: ProviderAdapterV2RuntimePolicy,
): ProviderAdapterV2RuntimePolicy {
  const { approvalPolicy: _approval, sandboxPolicy: _sandbox, ...rest } = policy;
  return { ...rest, runtimeMode: "full-access" };
}
export function sandboxInput<T extends { readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy }>(
  input: T,
): T {
  return input.runtimePolicy
    ? { ...input, runtimePolicy: sandboxPolicy(input.runtimePolicy) }
    : input;
}

/** Native configuration lives in the retained worker home, separate from conversations. */
export function prepareHarnessState(stateDir: string) {
  process.env.T3_HARNESS_STATE_DIR = `${stateDir}/harnesses`;
}
