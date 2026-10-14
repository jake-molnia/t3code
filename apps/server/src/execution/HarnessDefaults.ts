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
      if (!variables.has(entry.name))
        variables.set(entry.name, { ...entry, value: expand(entry.value) });
    const config = decodeConfig(instance.config ?? {});
    return {
      ...instance,
      ...(override.config
        ? {
            config: {
              ...Object.fromEntries(
                Object.entries(override.config)
                  .filter(([key]) => !(key in config))
                  .map(([key, value]) => [key, expandConfig(value)]),
              ),
              ...config,
            },
          }
        : {}),
      environment: [...variables.values()],
    };
  };
}

export function deploymentHarnessDefaults() {
  const path = process.env.T3_HARNESS_DEFAULTS_FILE;
  return harnessDefaults(path ? NodeFS.readFileSync(path, "utf8") : undefined);
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
