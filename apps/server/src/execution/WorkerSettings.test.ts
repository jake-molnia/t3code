import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkerSettings from "./WorkerSettings.ts";

it.effect(
  "removes retained source-control credentials and rejects copies from older centrals",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "worker-settings-credentials-" });
      const config = Context.get(
        yield* Layer.build(ServerConfig.layerTest(root, root)),
        ServerConfig.ServerConfig,
      );
      const settingsPath = config.settingsPath;
      const codec = Schema.fromJsonString(Schema.toCodecJson(ServerSettings));
      const centralSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        sourceControlHosts: { github: { tokens: { "github.com": "fixture-github-token" } } },
        providerInstances: {
          ...DEFAULT_SERVER_SETTINGS.providerInstances,
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { setupMode: "managed" },
            environment: [{ name: "GH_TOKEN", value: "fixture-worker-profile", sensitive: true }],
          },
        },
      } satisfies ServerSettings;
      yield* fs.writeFileString(settingsPath, yield* Schema.encodeEffect(codec)(centralSettings));
      const boot = Layer.build(
        WorkerSettings.layer.pipe(Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config))),
      ).pipe(Effect.map((services) => Context.get(services, ServerSettingsService)));
      const readSaved = fs
        .readFileString(settingsPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(codec)));
      const expected = { ...centralSettings, sourceControlHosts: {} };
      const first = yield* boot;
      expect(yield* first.getSettings).toEqual(expected);
      expect(yield* readSaved).toEqual(expected);
      yield* first.updateSettings({ sourceControlHosts: centralSettings.sourceControlHosts });
      expect(yield* readSaved).toEqual(expected);
      const restarted = yield* boot;
      expect(yield* restarted.getSettings).toEqual(expected);
      expect(centralSettings.sourceControlHosts.github.tokens["github.com"]).toBe(
        "fixture-github-token",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
