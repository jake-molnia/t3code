import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Settings from "../../serverSettings.ts";
import * as Registry from "../ProviderInstanceRegistry.ts";
import * as Mutator from "../ProviderInstanceRegistryMutator.ts";
import { deriveProviderInstanceConfigMap } from "../ProviderInstanceRegistryHydration.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import * as Infrastructure from "../ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistryCatalog from "../AcpRegistryCatalog.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";

/** Native adapter integration tests exercise upstream drivers without the cloud control plane. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const initial = yield* settings.getSettings.pipe(Effect.orDie);
    const registry = Registry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: deriveProviderInstanceConfigMap(initial),
    }).pipe(
      Layer.provide(Infrastructure.layer),
      Layer.provide(AcpRegistryCatalog.layer),
      Layer.provide(ProviderHostLive.layer),
    );
    const watcher = Layer.effectDiscard(
      Effect.gen(function* () {
        const mutator = yield* Mutator.ProviderInstanceRegistryMutator;
        const changes = yield* settings.subscribeChanges;
        yield* changes.pipe(
          Stream.runForEach((next) => mutator.reconcile(deriveProviderInstanceConfigMap(next))),
          Effect.forkScoped,
        );
      }),
    );
    return watcher.pipe(Layer.provideMerge(registry));
  }),
);
