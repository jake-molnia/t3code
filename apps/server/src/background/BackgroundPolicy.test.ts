import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  AuthSessionId,
  RpcClientId,
  type ClientActivityReportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "client-1",
    clientKind: "web",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "vcs-status", cwd: "/repo" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function layerFor(settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) {
  return BackgroundPolicy.layer.pipe(Layer.provide(ServerSettings.layerTest(settingsOverrides)));
}

describe("BackgroundPolicy", () => {
  it.effect("records foreground scoped client demand", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/other" }), false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/other" }), false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("removes all leases for a disconnected websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );
      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1));

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, []);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("keeps leases from another session when rpc client ids are reused", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientId = RpcClientId.make(1);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        rpcClientId,
        makeReport({ clientId: "client-1" }),
      );
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        rpcClientId,
        makeReport({ clientId: "client-2" }),
      );

      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), rpcClientId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.leases[0]?.sessionId, AuthSessionId.make("session-2"));
      assert.equal(snapshot.leases[0]?.clientId, "client-2");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("serializes lease mutation publications", () =>
    Effect.gen(function* () {
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const releaseFirstSnapshot = yield* Deferred.make<void>();
      const snapshotReads = yield* Ref.make(0);
      const layer = BackgroundPolicy.layer.pipe(
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.updateAndGet(snapshotReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(firstSnapshotStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirstSnapshot)),
                      Effect.as(DEFAULT_SERVER_SETTINGS),
                    )
                  : Effect.succeed(DEFAULT_SERVER_SETTINGS),
              ),
            ),
            streamChanges: Stream.empty,
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const updatesFiber = yield* policy.streamChanges.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const reportFiber = yield* policy
          .reportClientActivity(AuthSessionId.make("session-1"), RpcClientId.make(1), makeReport())
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const removeFiber = yield* policy
          .removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirstSnapshot, undefined);
        yield* Fiber.join(reportFiber);
        yield* Fiber.join(removeFiber);
        const updates = Array.from(yield* Fiber.join(updatesFiber));

        assert.equal(updates.at(-1)?.activeForegroundLeaseCount, 0);
        assert.deepStrictEqual(updates.at(-1)?.activeScopeKeys, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("bounds client-id churn for one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("session-1");
      const rpcClientId = RpcClientId.make(1);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `client-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `client-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("keeps background demand visible while preventing scoped work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, visible: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("keeps scoped work active after a recently used visible window loses focus", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: true }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("pauses scoped work for a visible unfocused client without recent interaction", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect(
    "performance profile allows background scoped work while a scoped lease is active",
    () =>
      Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        yield* policy.reportClientActivity(
          AuthSessionId.make("session-1"),
          RpcClientId.make(1),
          makeReport({ focused: false, visible: false }),
        );

        assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      }).pipe(Effect.provide(layerFor({ backgroundActivityProfile: "performance" }))),
  );
  it.effect("expires scoped demand without needing host telemetry", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ ttlMs: 1_000 }),
      );
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
      assert.equal(yield* policy.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("one constrained client does not block another client's foreground demand", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ lowPowerMode: "true" }),
      );
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        RpcClientId.make(2),
        makeReport(),
      );
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunOpportunisticWork, true);
    }).pipe(Effect.provide(layerFor())),
  );
});
