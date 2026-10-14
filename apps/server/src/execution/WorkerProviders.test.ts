import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { createProviderVersionAdvisory } from "@t3tools/provider-core/server/versionAdvisory";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ProviderConfigurationOverrides } from "../provider/ProviderConfigurationOverrides.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Settings from "../serverSettings.ts";
import * as CredentialSources from "./credentialSources.ts";
import * as WorkerProviders from "./WorkerProviders.ts";

it.effect(
  "worker refresh invalidates discovery and release caches before publishing its snapshot",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const instanceId = ProviderInstanceId.make("fixture");
      const driver = ProviderDriverKind.make("fixture");
      const latestVersions = yield* ProviderLatestVersions.make([["fixture", "1.0.0"]]);
      const snapshot: ServerProvider = {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: "2026-10-14T00:00:00.000Z",
        models: [],
        skills: [],
        slashCommands: [],
      };
      const instance = {
        instanceId,
        driverKind: driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: driver, continuationKey: "fixture" },
        invalidateCaches: Effect.sync(() => {
          calls.push("discovery");
        }),
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          getVersionSource: (options?: { readonly fresh?: boolean }) =>
            Effect.sync(() => {
              expect(options?.fresh).toBe(true);
              calls.push("release");
              return { packageName: "fixture" };
            }),
          refresh: Effect.gen(function* () {
            calls.push("snapshot");
            const latestVersion = yield* latestVersions.cached("fixture", Effect.succeed("2.0.0"));
            return {
              ...snapshot,
              versionAdvisory: createProviderVersionAdvisory({
                driver,
                currentVersion: snapshot.version,
                latestVersion,
              }),
            };
          }),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
        get orchestrationAdapter(): never {
          throw new Error("Refresh must not start an adapter");
        },
        get textGeneration(): never {
          throw new Error("Refresh must not run text generation");
        },
      } satisfies ProviderInstance;
      const worker = yield* WorkerProviders.make.pipe(
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        Effect.provide(
          Layer.mergeAll(
            TestProviderHost.layer(),
            CredentialSources.layer,
            Layer.mock(ServerSecretStore.ServerSecretStore)({}),
            Layer.mock(Registry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance),
            }),
            Layer.mock(Mutator.ProviderInstanceRegistryMutator)({}),
            Layer.mock(Settings.ServerSettingsService)({}),
            Layer.succeed(ProviderConfigurationOverrides, (config) => config),
          ),
        ),
      );
      yield* worker.execute("provider.snapshot", { instanceId, input: null });
      expect(calls).toEqual([]);
      const refreshed = yield* worker.execute("provider.refresh", { instanceId, input: null });
      expect(calls).toEqual(["discovery", "release", "snapshot"]);
      expect(refreshed).toMatchObject({ versionAdvisory: { latestVersion: "2.0.0" } });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
