import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it, afterEach, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderConfigurationOverrides } from "../provider/ProviderConfigurationOverrides.ts";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { workerLayers } from "./WorkerLayers.ts";

const decodeSavedSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(ServerSettings)),
);

afterEach(() => vi.unstubAllEnvs());

it.effect(
  "boots the worker host with scoped credentials, settings snapshots and provider services",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("T3_GATEWAY_URL", "");
      vi.stubEnv("T3_HARNESS_STATE_DIR", "");
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worker-layers-" });
      const services = yield* Layer.build(workerLayers({ cwd: stateDir, stateDir, port: 3774 }));
      const host = Context.get(services, ProviderHost.ProviderHost);
      assert.isTrue(yield* fs.exists(host.paths.attachmentsDir));
      assert.isTrue(yield* host.shouldRunBackgroundWork({ type: "server-config" }));
      const snapshot = yield* host.settings.withSnapshot(Effect.succeed);
      assert.deepEqual(snapshot, yield* host.settings.get);
      const credentials = yield* host.credentials("worker-test", "instance");
      const bytes = new TextEncoder().encode("test credential");
      yield* credentials.set(bytes);
      const reopened = yield* host.credentials("worker-test", "instance");
      assert.deepEqual(yield* reopened.get, Option.some(bytes));
      yield* reopened.remove;
      assert.isTrue(Option.isNone(yield* credentials.get));
      const catalog = Context.get(services, ModelCatalog.ModelCatalog);
      assert.isDefined(catalog.bundled(ProviderDriverKind.make("codex")));
      assert.isDefined(Context.get(services, McpProviderSessions.McpProviderSessions));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "exports one effective configuration after harness bootstrap and persists only raw settings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worker-harness-path-" });
      const defaults = `${root}/defaults.json`;
      yield* fs.writeFileString(
        defaults,
        JSON.stringify({
          pi: {
            environment: [
              {
                name: "PI_CODING_AGENT_DIR",
                value: "${T3_HARNESS_STATE_DIR}/pi",
                sensitive: false,
              },
            ],
          },
          codex: {
            environment: [
              { name: "OPENAI_API_KEY", value: "${T3_TEST_OPERATOR_SECRET}", sensitive: true },
            ],
          },
        }),
      );
      const keys = [
        "T3_HARNESS_DEFAULTS_FILE",
        "T3_HARNESS_STATE_DIR",
        "T3_TEST_OPERATOR_SECRET",
        "T3_GATEWAY_URL",
      ] as const;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = new Map(keys.map((key) => [key, process.env[key]]));
          process.env.T3_HARNESS_DEFAULTS_FILE = defaults;
          process.env.T3_HARNESS_STATE_DIR = "/wrong-bootstrap-home";
          process.env.T3_TEST_OPERATOR_SECRET = "expanded-operator-secret";
          delete process.env.T3_GATEWAY_URL;
          return saved;
        }),
        (saved) =>
          Effect.sync(() => {
            for (const [key, value] of saved) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }),
      );
      const piEnvironment = process.env.PI_CODING_AGENT_DIR;
      yield* Effect.gen(function* () {
        const normalize = yield* ProviderConfigurationOverrides;
        expect(normalize({ driver: ProviderDriverKind.make("pi") }).environment).toEqual([
          { name: "PI_CODING_AGENT_DIR", value: `${root}/state/harnesses/pi`, sensitive: false },
        ]);
        expect(
          normalize({ driver: ProviderDriverKind.make("codex") }).environment?.[0]?.value,
        ).toBe("expanded-operator-secret");
        const settings = yield* ServerSettingsService;
        const rawInstances = {
          [ProviderInstanceId.make("pi")]: { driver: ProviderDriverKind.make("pi") },
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "OPENAI_API_KEY", value: "saved-user-value", sensitive: true }],
          },
        } satisfies ServerSettings["providerInstances"];
        yield* settings.updateSettings({ providerInstances: rawInstances });
        const config = yield* ServerConfig.ServerConfig;
        const persisted = yield* fs.readFileString(config.settingsPath);
        const saved = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.toCodecJson(ServerSettings)),
        )(persisted);
        expect(saved.providerInstances).toEqual(rawInstances);
        expect(persisted).not.toContain("expanded-operator-secret");
        expect(persisted).not.toContain("PI_CODING_AGENT_DIR");
        expect(process.env.PI_CODING_AGENT_DIR).toBe(piEnvironment);
      }).pipe(Effect.provide(workerLayers({ cwd: root, stateDir: `${root}/state`, port: 0 })));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
