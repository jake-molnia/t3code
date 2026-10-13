import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService, applyProviderInstanceMutation } from "../serverSettings.ts";

/** Provider configuration on retained storage; no conversation or orchestration database. */
export const layer = Layer.effect(
  ServerSettingsService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const schema = Schema.fromJsonString(Schema.toCodecJson(ServerSettings));
    const wrap = (cause: unknown) =>
      new ServerSettingsError({
        settingsPath: config.settingsPath,
        operation: "write-file",
        cause,
      });
    const initial = (yield* fs.exists(config.settingsPath))
      ? yield* fs
          .readFileString(config.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
      : DEFAULT_SERVER_SETTINGS;
    const state = yield* SubscriptionRef.make(initial);
    const lock = yield* Semaphore.make(1);
    const update = (change: (current: ServerSettings) => ServerSettings) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = change(yield* SubscriptionRef.get(state));
          const encoded = yield* Schema.encodeEffect(schema)(next);
          yield* fs.writeFileString(`${config.settingsPath}.tmp`, encoded, { mode: 0o600 });
          yield* fs.rename(`${config.settingsPath}.tmp`, config.settingsPath);
          yield* SubscriptionRef.set(state, next);
          return next;
        }).pipe(Effect.mapError(wrap)),
      );
    return ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: SubscriptionRef.get(state),
      updateSettings: (patch) => update((current) => applyServerSettingsPatch(current, patch)),
      updateProviderInstance: (mutation, patch = {}) =>
        update((current) =>
          applyProviderInstanceMutation(applyServerSettingsPatch(current, patch), mutation),
        ),
      withSettingsSnapshot: (use) =>
        lock.withPermits(1)(SubscriptionRef.get(state).pipe(Effect.flatMap(use))),
      streamChanges: SubscriptionRef.changes(state).pipe(Stream.drop(1)),
      subscribeChanges: Effect.succeed(SubscriptionRef.changes(state).pipe(Stream.drop(1))),
    });
  }),
);
