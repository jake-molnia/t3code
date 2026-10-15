import { expect, test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ServerSettings,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { migrateGatewayModelSelection, migrateGatewaySettings } from "./GatewayMigration.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

test.each(["opencode", "pi"])("%s resumes saved models through the gateway", (driver) => {
  for (const prefix of ["aperture", "aperture-chat", "aperture-anthropic"]) {
    const saved = {
      instanceId: ProviderInstanceId.make("instance"),
      model: `${prefix}/vendor/model`,
    };
    expect(migrateGatewayModelSelection(driver, saved)).toEqual({
      ...saved,
      model: "gateway/vendor/model",
    });
    expect(saved.model).toBe(`${prefix}/vendor/model`);
  }
});

test("migration preserves native model IDs and unrelated providers", () => {
  const saved = { instanceId: ProviderInstanceId.make("instance"), model: "aperture/model" };
  expect(migrateGatewayModelSelection("codex", saved)).toBe(saved);
  const gateway = { ...saved, model: "gateway/model" };
  expect(migrateGatewayModelSelection("pi", gateway)).toBe(gateway);
  const native = { ...saved, model: "anthropic/claude" };
  expect(migrateGatewayModelSelection("opencode", native)).toBe(native);
});

test("migrates active model preferences and shipped labels without changing instance identities", () => {
  const settings = decodeSettings({
    providerInstances: {
      pi_work: { driver: ProviderDriverKind.make("pi"), displayName: "Pi · Aperture" },
      opencode: { driver: ProviderDriverKind.make("opencode"), displayName: "My custom label" },
    },
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("pi_work"),
      model: "aperture/gpt",
    },
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "aperture-chat/claude",
    },
    sourceControlWriterModelSelection: null,
    favorites: [{ provider: ProviderInstanceId.make("pi_work"), model: "aperture/gpt" }],
    providerModelPreferences: {
      pi_work: {
        hiddenModels: ["aperture-chat/claude"],
        modelOrder: ["aperture/gpt", "gateway/gpt"],
      },
    },
    projectSettingsOverrides: {
      project: {
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "aperture-anthropic/claude",
        },
        defaultAutoPull: true,
      },
      inherited: { defaultModelSelection: null },
    },
  });
  const next = migrateGatewaySettings(settings);
  expect(next.defaultModelSelection?.model).toBe("gateway/gpt");
  expect(next.textGenerationModelSelection.model).toBe("gateway/claude");
  expect(next.sourceControlWriterModelSelection).toBeNull();
  expect(next.favorites?.[0]?.model).toBe("gateway/gpt");
  expect(next.providerModelPreferences?.[ProviderInstanceId.make("pi_work")]).toEqual({
    hiddenModels: ["gateway/claude"],
    modelOrder: ["gateway/gpt"],
  });
  expect(next.projectSettingsOverrides[ProjectId.make("project")]).toMatchObject({
    defaultModelSelection: { model: "gateway/claude" },
    defaultAutoPull: true,
  });
  expect(next.projectSettingsOverrides[ProjectId.make("inherited")]).toEqual({
    defaultModelSelection: null,
  });
  expect(next.providerInstances[ProviderInstanceId.make("pi_work")]?.displayName).toBe("Pi");
  expect(next.providerInstances[ProviderInstanceId.make("opencode")]?.displayName).toBe(
    "My custom label",
  );
  expect(settings.defaultModelSelection?.model).toBe("aperture/gpt");
  expect(migrateGatewaySettings(next)).toBe(next);
});

test("an empty gateway deployment exposes every supported harness without a guessed default model", () => {
  const next = migrateGatewaySettings(decodeSettings({}));
  expect(
    Object.values(next.providerInstances)
      .map((instance) => instance.driver)
      .sort(),
  ).toEqual(["claudeAgent", "codex", "grok", "opencode", "pi"]);
  expect(Object.values(next.providerInstances).every((instance) => instance.enabled)).toBe(true);
  expect(next.defaultModelSelection).toBeNull();
  expect(next.providerInstances[ProviderInstanceId.make("codex")]?.config).toEqual({
    setupMode: "existing",
  });
  expect(migrateGatewaySettings(next)).toBe(next);
});

test("gateway hydration keeps custom identities, disabled harnesses, and unrelated configuration", () => {
  const current = decodeSettings({
    providerInstances: {
      pi_work: { driver: ProviderDriverKind.make("pi"), enabled: false, displayName: "Work Pi" },
      codex_work: {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        config: { setupMode: "managed", launchArgs: "--verbose" },
      },
      cursor: { driver: ProviderDriverKind.make("cursor"), enabled: false },
    },
  });
  const next = migrateGatewaySettings(current);
  expect(next.providerInstances[ProviderInstanceId.make("pi")]).toBeUndefined();
  expect(next.providerInstances[ProviderInstanceId.make("codex")]).toBeUndefined();
  expect(next.providerInstances[ProviderInstanceId.make("pi_work")]).toBe(
    current.providerInstances[ProviderInstanceId.make("pi_work")],
  );
  expect(next.providerInstances[ProviderInstanceId.make("codex_work")]).toMatchObject({
    enabled: false,
    config: { setupMode: "existing", launchArgs: "--verbose" },
  });
  expect(next.providerInstances[ProviderInstanceId.make("cursor")]?.enabled).toBe(false);
  expect(
    Object.values(next.providerInstances).filter((instance) => instance.driver === "pi"),
  ).toHaveLength(1);
  expect(migrateGatewaySettings(next)).toBe(next);
});

test("retained OpenCode instances use the image executable only when no binary was chosen", () => {
  const current = decodeSettings({
    providerInstances: {
      original: { driver: ProviderDriverKind.make("opencode"), config: { serverPassword: "kept" } },
      empty: {
        driver: ProviderDriverKind.make("opencode"),
        enabled: false,
        config: { binaryPath: "" },
      },
      explicit: {
        driver: ProviderDriverKind.make("opencode"),
        config: { binaryPath: "/custom/opencode" },
      },
      explicitName: {
        driver: ProviderDriverKind.make("opencode"),
        config: { binaryPath: "opencode" },
      },
    },
  });
  const next = migrateGatewaySettings(current);
  expect(next.providerInstances[ProviderInstanceId.make("original")]?.config).toEqual({
    serverPassword: "kept",
    binaryPath: "opencode2",
  });
  expect(next.providerInstances[ProviderInstanceId.make("empty")]).toMatchObject({
    enabled: false,
    config: { binaryPath: "opencode2" },
  });
  expect(next.providerInstances[ProviderInstanceId.make("explicit")]?.config).toEqual({
    binaryPath: "/custom/opencode",
  });
  expect(next.providerInstances[ProviderInstanceId.make("explicitName")]?.config).toEqual({
    binaryPath: "opencode",
  });
  expect(migrateGatewaySettings(next)).toBe(next);
});
