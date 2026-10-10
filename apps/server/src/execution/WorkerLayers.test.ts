import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderDriverKind } from "@t3tools/contracts";
import { workerLayers } from "./WorkerLayers.ts";

afterEach(() => vi.unstubAllEnvs());

it.effect(
  "boots the worker host with scoped credentials, settings snapshots and provider services",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("APERTURE_UPSTREAM", "");
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
