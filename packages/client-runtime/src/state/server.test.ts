import {
  EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerWelcomeEvent,
  makeEnvironmentServerWelcomeState,
  makeEnvironmentServerConfigState,
  resolveServerConfigValue,
  resolveServerWelcomeState,
} from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  // Capabilities drive version-skew behaviour in the projection, so the
  // fixture carries them rather than leaving the field absent.
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("server state projection", () => {
  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = { ...CONFIG.settings };
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("carries published environment themes in and out of the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const themes = [
      {
        id: "nightfall",
        name: "Nightfall",
        appearance: "dark",
        canvas: "#1a1b26",
        accent: "#7aa2f7",
      },
    ] as const;

    const published = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "environmentThemesUpdated",
      payload: { themes },
    });
    expect(Option.getOrThrow(published).config.environmentThemes).toEqual(themes);

    // A machine that stops publishing has to clear the palettes, not freeze
    // clients on the last set it sent.
    const unpublished = applyServerConfigProjection(published, {
      version: 1,
      type: "environmentThemesUpdated",
      payload: { themes: [] },
    });
    expect(Option.getOrThrow(unpublished).config.environmentThemes).toBeUndefined();
  });

  // A snapshot never carries published themes, so taking it wholesale would
  // clear them on every reconnect and repaint anyone wearing one.
  it("keeps published themes across a reconnect snapshot", () => {
    const themes = [
      {
        id: "nightfall",
        name: "Nightfall",
        appearance: "dark",
        canvas: "#1a1b26",
        accent: "#7aa2f7",
      },
    ] as const;

    const withThemes = applyServerConfigProjection(
      applyServerConfigProjection(Option.none(), { version: 1, type: "snapshot", config: CONFIG }),
      { version: 1, type: "environmentThemesUpdated", payload: { themes } },
    );
    expect(Option.getOrThrow(withThemes).config.environmentThemes).toEqual(themes);

    const afterReconnect = applyServerConfigProjection(withThemes, {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    expect(Option.getOrThrow(afterReconnect).config.environmentThemes).toEqual(themes);

    // A server that predates the feature never sends another theme event, so
    // carrying the set forward would leave a palette nothing can update.
    const downgraded = applyServerConfigProjection(withThemes, {
      version: 1,
      type: "snapshot",
      config: {
        ...CONFIG,
        environment: { capabilities: {} },
      } as unknown as ServerConfig,
    });
    expect(Option.getOrThrow(downgraded).config.environmentThemes).toBeUndefined();
  });

  it("keeps a current welcome on ready and rejects a buffered welcome from the old session", () => {
    const firstSession = session({} as WsRpcProtocolClient);
    const secondSession = session({} as WsRpcProtocolClient);
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const initial = {
      currentSession: firstSession,
      welcomeSession: firstSession,
      welcome: null,
    };
    const afterWelcome = applyServerWelcomeEvent(initial, firstSession, {
      type: "welcome",
      payload: welcome,
    });
    const afterReady = applyServerWelcomeEvent(afterWelcome, firstSession, {
      type: "ready",
      payload: {},
    });
    const afterSwitch = { ...afterReady, currentSession: secondSession };
    const afterBufferedOldWelcome = applyServerWelcomeEvent(afterSwitch, firstSession, {
      type: "welcome",
      payload: { ...welcome, cwd: "/stale" },
    });

    expect(afterReady).toBe(afterWelcome);
    expect(resolveServerWelcomeState(afterReady)).toBe(welcome);
    expect(afterBufferedOldWelcome).toBe(afterSwitch);
    expect(resolveServerWelcomeState(afterBufferedOldWelcome)).toBeNull();
  });

  it.effect("checks the authoritative session before accepting a buffered welcome", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(firstEvents)),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const staleWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/stale",
        projectName: "stale",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);

          // Model the point after the ref changed but before either subscriber
          // processed its publication.
          supervisorSession.value = Option.some(secondSession);
          const handled = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter(
              (value) => value.currentSession === secondSession || value.welcome === staleWelcome,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: staleWelcome });

          const next = yield* Fiber.join(handled);
          expect(next.currentSession).toBe(secondSession);
          expect(resolveServerWelcomeState(next)).toBeNull();
        }),
      );
    }),
  );

  it.effect("reads the authoritative session after waiting for the welcome state lock", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(Stream.drain),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const thirdSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);
          const changed = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) => value.currentSession !== firstSession),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );

          yield* state.semaphore.withPermit(
            Effect.gen(function* () {
              yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              supervisorSession.value = Option.some(thirdSession);
            }),
          );

          expect((yield* Fiber.join(changed)).currentSession).toBe(thirdSession);
        }),
      );
    }),
  );

  it.effect("clears a welcome until the reconnected session sends its own", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const secondEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const firstWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/first",
        projectName: "first",
      } as ServerLifecycleWelcomePayload;
      const secondWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/second",
        projectName: "second",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          const nextResolved = (
            predicate: (value: ServerLifecycleWelcomePayload | null) => boolean,
          ) =>
            SubscriptionRef.changes(state).pipe(
              Stream.map(resolveServerWelcomeState),
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );

          const first = yield* nextResolved((value) => value === firstWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: firstWelcome });
          expect(yield* Fiber.join(first)).toBe(firstWelcome);

          const cleared = yield* nextResolved((value) => value === null).pipe(Effect.forkChild);
          yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
          expect(yield* Fiber.join(cleared)).toBeNull();
          expect(resolveServerWelcomeState(yield* SubscriptionRef.get(state))).toBeNull();

          const second = yield* nextResolved((value) => value === secondWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(secondEvents, { type: "welcome", payload: secondWelcome });
          expect(yield* Fiber.join(second)).toBe(secondWelcome);
        }),
      );
    }),
  );

  it("prefers an active session config over cache until a live event arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.0.29");
    const staleLive = config("stale-live", "0.0.29");
    const initial = config("session", "0.0.30");
    const live = config("live", "0.0.30");

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: staleLive,
          latestEvent: snapshotEvent(staleLive),
          source: "live",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it.effect("throttles server configuration writes and flushes the latest on teardown", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      const scope = yield* Scope.make();
      const state = yield* makeEnvironmentServerConfigState({}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(Scope.Scope, scope),
      );
      const sendConfig = Effect.fn(function* (cwd: string) {
        yield* Queue.offer(events, { version: 1, type: "snapshot", config: { ...CONFIG, cwd } });
        yield* SubscriptionRef.changes(state).pipe(
          Stream.filter((value) => Option.isSome(value) && value.value.config.cwd === cwd),
          Stream.runHead,
        );
      });
      yield* sendConfig("/first");
      yield* TestClock.adjust("500 millis");
      expect((yield* Queue.take(savedConfigs)).cwd).toBe("/first");
      for (let index = 1; index <= 9; index++) {
        yield* sendConfig(`/repo-${index}`);
        yield* TestClock.adjust("1 second");
      }
      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
      yield* TestClock.adjust("1 second");
      expect((yield* Queue.take(savedConfigs)).cwd).toBe("/repo-9");
      yield* sendConfig("/final");
      yield* Scope.close(scope, Exit.void);
      expect((yield* Queue.take(savedConfigs)).cwd).toBe("/final");
      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
    }),
  );

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toBe(providers);
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("does not rewrite cached configuration when no live update arrives", () =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.empty,
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        makeEnvironmentServerConfigState({}).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      );

      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
    }),
  );
});
