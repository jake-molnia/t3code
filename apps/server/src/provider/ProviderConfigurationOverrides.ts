import type { ProviderInstanceConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** Execution environments can supply effective config without rewriting saved settings. */
export class ProviderConfigurationOverrides extends Context.Reference<
  (instance: ProviderInstanceConfig) => ProviderInstanceConfig
>("t3/provider/ProviderConfigurationOverrides", { defaultValue: () => (instance) => instance }) {}
