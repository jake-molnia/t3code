// @effect-diagnostics nodeBuiltinImport:off -- Worker deployment configuration boundary.
import * as NodeFS from "node:fs";
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";

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
    const configured =
      override.config === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(override.config)
              .filter(([key]) => !(key in config))
              .map(([key, value]) => [key, expandConfig(value)]),
          );
    return {
      ...instance,
      ...(configured
        ? {
            config: { ...configured, ...config },
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
    ["cursor", "muse"].includes(instance.driver)
  ) {
    throw new Error(
      `${instance.driver} requires native provider authentication and cannot use model gateway credentials`,
    );
  }
}

/** Model access belongs to the gateway; execution fields remain owned by the harness. */
export function gatewayRouting(text: string, environment: NodeJS.ProcessEnv = process.env) {
  const resolve = harnessDefaults(text, environment);
  return (instance: ProviderInstanceConfig): ProviderInstanceConfig => {
    // Antigravity owns its account and model API; it cannot use gateway credentials.
    if (instance.enabled === false || instance.driver === "antigravity") return instance;
    const route = resolve({ driver: instance.driver });
    const execution = decodeConfig(instance.config ?? {});
    const routing = decodeConfig(route.config ?? {});
    const variables = new Map((instance.environment ?? []).map((entry) => [entry.name, entry]));
    const configuredArgs =
      typeof execution.launchArgs === "string" ? execution.launchArgs : undefined;
    const executionArgs =
      instance.driver === "codex"
        ? resolveCodexLaunchArgs(configuredArgs, {
            ...environment,
            ...Object.fromEntries(
              (instance.environment ?? []).map((entry) => [entry.name, entry.value]),
            ),
          })
        : configuredArgs;
    const launchArgs =
      typeof routing.launchArgs === "string"
        ? [executionArgs, routing.launchArgs].filter(Boolean).join(" ")
        : executionArgs;
    if (instance.driver === "codex")
      variables.set("T3CODE_CODEX_LAUNCH_ARGS", {
        name: "T3CODE_CODEX_LAUNCH_ARGS",
        value: "",
        sensitive: false,
      });
    if (instance.driver === "claudeAgent") {
      // Empty credentials override an inherited token in the process environment too.
      for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
        variables.set(name, { name, value: "", sensitive: true });
      for (const name of [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
      ])
        variables.set(name, { name, value: "0", sensitive: false });
    }
    for (const entry of route.environment ?? []) {
      // Native configuration locations belong to the instance. The catalog adds routing in place.
      if (entry.name === "PI_CODING_AGENT_DIR" || entry.name === "OPENCODE_CONFIG") continue;
      variables.set(entry.name, entry);
    }
    return {
      ...instance,
      config: { ...execution, ...routing, ...(launchArgs !== undefined ? { launchArgs } : {}) },
      environment: [...variables.values()],
    };
  };
}

export function deploymentHarnessDefaults() {
  const gatewayPath = process.env.T3_GATEWAY_HARNESS_CONFIG_FILE;
  // The shipped worker always has this manifest. A missing address is a setup error,
  // not an instruction to switch account ownership back to a native provider.
  if (gatewayPath || process.env.T3_GATEWAY_URL) {
    if (!gatewayPath || !process.env.T3_GATEWAY_URL || !process.env.T3_GATEWAY_API_KEY?.trim())
      throw new Error(
        "Model access requires T3_GATEWAY_HARNESS_CONFIG_FILE, T3_GATEWAY_URL, and T3_GATEWAY_API_KEY",
      );
    return gatewayRouting(NodeFS.readFileSync(gatewayPath, "utf8"));
  }
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

/** Native configuration lives in the retained worker home, separate from conversations. */
export function prepareHarnessState(stateDir: string) {
  process.env.T3_HARNESS_STATE_DIR = `${stateDir}/harnesses`;
}
