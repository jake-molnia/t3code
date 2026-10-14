import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type ModelSelection,
} from "@t3tools/contracts";

/** Translate saved selections at execution time; historical events retain their original IDs. */
export function migrateGatewayModelSelection(
  driver: string,
  selection: ModelSelection,
): ModelSelection {
  if (driver !== "opencode" && driver !== "pi") return selection;
  const model = selection.model.replace(/^aperture(?:-chat|-anthropic)?\//, "gateway/");
  return model === selection.model ? selection : { ...selection, model };
}

const selectionKeys = [
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
] as const;

const retiredDisplayNames = new Map([
  ["Codex · Aperture", "Codex"],
  ["Claude (requires managed Aperture Messages route)", "Claude"],
  ["Grok · Aperture", "Grok"],
  ["OpenCode · Aperture", "OpenCode"],
  ["Pi · Aperture", "Pi"],
]);

const gatewayHarnesses = [
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
  ["grok", "Grok"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
] as const;

/** Runs only for managed gateway deployments and rewrites active preferences, never history. */
export function migrateGatewaySettings(settings: ServerSettings): ServerSettings {
  let changed = false;
  const selection = (value: ModelSelection) => {
    const driver = settings.providerInstances[value.instanceId]?.driver ?? value.instanceId;
    const next = migrateGatewayModelSelection(driver, value);
    changed ||= next !== value;
    return next;
  };
  const selections = <T extends Partial<Pick<ServerSettings, (typeof selectionKeys)[number]>>>(
    value: T,
  ): T => {
    let next = value;
    for (const key of selectionKeys) {
      const current = value[key];
      if (current) next = { ...next, [key]: selection(current) };
    }
    return next;
  };
  const model = (instanceId: ProviderInstanceId, value: string) =>
    selection({ instanceId, model: value }).model;
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([id, instance]) => {
      const name = instance.displayName && retiredDisplayNames.get(instance.displayName);
      const config =
        instance.config !== null &&
        typeof instance.config === "object" &&
        !Array.isArray(instance.config)
          ? instance.config
          : {};
      const useGateway =
        instance.driver === "codex" && !("setupMode" in config && config.setupMode === "existing");
      if (!name && !useGateway) return [id, instance] as const;
      changed = true;
      return [
        id,
        {
          ...instance,
          ...(name ? { displayName: name } : {}),
          ...(useGateway ? { config: { ...config, setupMode: "existing" } } : {}),
        },
      ] as const;
    }),
  );
  for (const [driver, displayName] of gatewayHarnesses) {
    if (Object.values(providerInstances).some((instance) => instance.driver === driver)) continue;
    let id: string = driver;
    while (providerInstances[id]) id += "_gateway";
    providerInstances[id] = {
      driver: ProviderDriverKind.make(driver),
      displayName,
      enabled: true,
      ...(driver === "codex" ? { config: { setupMode: "existing" } } : {}),
      ...(driver === "opencode" ? { config: { binaryPath: "opencode2" } } : {}),
    };
    changed = true;
  }
  const next = {
    ...selections(settings),
    providerInstances,
    favorites:
      settings.favorites === null
        ? null
        : [
            ...new Map(
              settings.favorites.map((favorite) => {
                const migrated = { ...favorite, model: model(favorite.provider, favorite.model) };
                return [JSON.stringify([migrated.provider, migrated.model]), migrated];
              }),
            ).values(),
          ],
    providerModelPreferences:
      settings.providerModelPreferences === null
        ? null
        : Object.fromEntries(
            Object.entries(settings.providerModelPreferences).map(([id, value]) => {
              const instanceId = ProviderInstanceId.make(id);
              return [
                id,
                {
                  hiddenModels: [
                    ...new Set(value.hiddenModels.map((value) => model(instanceId, value))),
                  ],
                  modelOrder: [
                    ...new Set(value.modelOrder.map((value) => model(instanceId, value))),
                  ],
                },
              ];
            }),
          ),
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => [
        id,
        selections(overrides),
      ]),
    ),
  };
  return changed ? next : settings;
}
