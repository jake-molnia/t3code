// @effect-diagnostics globalFetch:off -- Bounded bootstrap HTTP before provider service startup.
import {
  Catalog,
  managedApertureCatalog,
  nativeApertureConfigs,
  setApertureCatalog,
} from "./ApertureCatalog.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Worker deployment configuration boundary.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
    if (
      instance.enabled !== false &&
      environment.APERTURE_UPSTREAM &&
      ["cursor", "muse"].includes(instance.driver)
    ) {
      throw new Error(
        `${instance.driver} requires native provider authentication and cannot use Aperture model credentials`,
      );
    }
    const override = defaults[instance.driver];
    if (!override) return instance;
    const variables = new Map((instance.environment ?? []).map((entry) => [entry.name, entry]));
    for (const entry of override.environment ?? [])
      variables.set(entry.name, { ...entry, value: expand(entry.value) });
    return {
      ...instance,
      ...(override.config
        ? {
            config: {
              ...decodeConfig(instance.config ?? {}),
              ...decodeConfig(expandConfig(override.config)),
            },
          }
        : {}),
      environment: [...variables.values()],
    };
  };
}

export function deploymentHarnessDefaults() {
  const path = process.env.T3_HARNESS_DEFAULTS_FILE;
  return harnessDefaults(path ? readFileSync(path, "utf8") : undefined);
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

/** Pi resolves model keys from its environment; the published file contains no credential. */
export async function prepareHarnessState(stateDir: string) {
  process.env.T3_HARNESS_STATE_DIR = `${stateDir}/harnesses`;
  const aperture = process.env.APERTURE_UPSTREAM;
  if (!aperture) return;
  const url = new URL(aperture);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Aperture upstream");
  const base = aperture.replace(/\/$/, "");
  const directory = `${stateDir}/harnesses/pi`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const response = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${process.env.APERTURE_API_KEY ?? "-"}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Aperture catalog unavailable (HTTP ${response.status})`);
  const catalog = managedApertureCatalog(Schema.decodeUnknownSync(Catalog)(await response.json()));
  setApertureCatalog(catalog);
  const configs = nativeApertureConfigs(catalog, base);
  writeFileSync(`${directory}/models.json`, JSON.stringify(configs.pi, null, 2), { mode: 0o600 });
  writeFileSync(`${stateDir}/harnesses/opencode2.json`, JSON.stringify(configs.opencode, null, 2), {
    mode: 0o600,
  });
}
