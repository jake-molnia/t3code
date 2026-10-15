import type {
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryProcessIdentity,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  emptyTelemetryCounters,
  mergeProcesses,
  type ProcessState,
  type TelemetryCounters,
} from "./Model.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";
import {
  buildResourceTelemetryHistory,
  normalizeResourceTelemetryHistoryInput,
  type ResourceTelemetryHistoryWithLegacyBuckets,
} from "./ResourceTelemetryHistory.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

export class ResourceTelemetryRefreshFailed extends Schema.TaggedError<ResourceTelemetryRefreshFailed>()(
  "ResourceTelemetryRefreshFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Resource telemetry operation '${this.operation}' failed.`;
  }
}

export class ResourceTelemetry extends Context.Service<
  ResourceTelemetry,
  {
    readonly latest: Effect.Effect<ResourceTelemetrySnapshot>;
    readonly changes: Stream.Stream<ResourceTelemetrySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: ResourceTelemetrySnapshot;
        readonly changes: Stream.Stream<ResourceTelemetrySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly readHistory: (
      input: ResourceTelemetryHistoryInput,
    ) => Effect.Effect<ResourceTelemetryHistoryWithLegacyBuckets>;
    readonly refresh: Effect.Effect<ResourceTelemetrySnapshot, ResourceTelemetryRefreshFailed>;
    readonly validateProcessIdentity: (
      identity: ResourceTelemetryProcessIdentity,
    ) => Effect.Effect<boolean, ResourceTelemetryRefreshFailed>;
    readonly retry: Effect.Effect<ResourceTelemetryRetryResult>;
  }
>()("t3/resourceTelemetry/ResourceTelemetry") {}

interface TelemetryState {
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly latest: ResourceTelemetrySnapshot;
  readonly lastNativeSequence: number;
  readonly lastNativeGeneration: number;
}

interface LiveTelemetryState {
  readonly retainCount: number;
  readonly scope: Option.Option<Scope.Closeable>;
}

function buildHealth(input: {
  readonly native: NativeTelemetryClient.NativeTelemetryClientHealth;
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
}): ResourceTelemetryHealth {
  return {
    native: {
      status: input.native.status,
      lastSampleAt: input.native.lastSampleAt,
      lastError: input.native.lastError,
    },
    sidecarVersion: Option.map(input.native.hello, (hello) => hello.sidecarVersion),
    sidecarPid: Option.map(input.native.hello, (hello) => hello.sidecarPid),
    restartCount: input.native.restartCount,
    collectionDurationMicros: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.collectionDurationMicros,
    }),
    scannedProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.scannedProcessCount,
    }),
    retainedProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.retainedProcessCount,
    }),
    inaccessibleProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.inaccessibleProcessCount,
    }),
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("resourceTelemetry.resourceTelemetry.make")(function* () {
  const nativeClient = yield* NativeTelemetryClient.NativeTelemetryClient;
  const attribution = yield* ResourceAttribution.ResourceAttribution;
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<ResourceTelemetrySnapshot>(8);
  const initialReadAt = yield* DateTime.now;
  const nativeHealthSubscription = yield* nativeClient.subscribeHealth;
  const initialNativeHealth = nativeHealthSubscription.latest;
  const initialAttribution = yield* attribution.snapshot;
  const initialMerge = mergeProcesses({
    serverPid: process.pid,
    sidecarPid: Option.map(initialNativeHealth.hello, (hello) => hello.sidecarPid),
    fallbackSampledAtMs: DateTime.toEpochMillis(initialReadAt),
    nativeSnapshot: Option.none(),
    previous: new Map(),
    counters: emptyTelemetryCounters(),
    updatePrevious: false,
  });
  const initialSnapshot: ResourceTelemetrySnapshot = {
    readAt: initialReadAt,
    sampleIntervalMs: initialNativeHealth.sampleIntervalMs,
    processes: initialMerge.processes,
    groups: initialMerge.groups,
    attribution: initialAttribution,
    health: buildHealth({
      native: initialNativeHealth,
      nativeSnapshot: Option.none(),
    }),
  };
  const state = yield* Ref.make<TelemetryState>({
    nativeSnapshot: Option.none(),
    previous: new Map(),
    counters: emptyTelemetryCounters(),
    latest: initialSnapshot,
    lastNativeSequence: 0,
    lastNativeGeneration: initialNativeHealth.restartCount,
  });
  const liveState = yield* Ref.make<LiveTelemetryState>({
    retainCount: 0,
    scope: Option.none(),
  });
  const liveMutex = yield* Semaphore.make(1);
  const refreshHealth = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const nativeHealth = yield* nativeClient.health;
      const snapshot: ResourceTelemetrySnapshot = {
        ...current.latest,
        health: buildHealth({
          native: nativeHealth,
          nativeSnapshot: current.nativeSnapshot,
        }),
      };
      yield* Ref.set(state, {
        ...current,
        latest: snapshot,
      });
      if ((yield* Ref.get(liveState)).retainCount > 0) {
        yield* PubSub.publish(changes, snapshot);
      }
    }),
  );

  const ingestNative = (
    incomingNativeSnapshot: NativeTelemetryClient.NativeTelemetrySnapshot,
  ): Effect.Effect<ResourceTelemetrySnapshot> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const nativeHealth = yield* nativeClient.health;
        if (
          incomingNativeSnapshot.generation < nativeHealth.restartCount ||
          incomingNativeSnapshot.generation < current.lastNativeGeneration ||
          (incomingNativeSnapshot.generation === current.lastNativeGeneration &&
            incomingNativeSnapshot.snapshot.sequence <= current.lastNativeSequence)
        ) {
          return current.latest;
        }
        const nativeSnapshot = Option.some(incomingNativeSnapshot.snapshot);
        const attributionSnapshot = yield* attribution.snapshot;
        const merged = mergeProcesses({
          serverPid: process.pid,
          sidecarPid: Option.map(nativeHealth.hello, (hello) => hello.sidecarPid),
          fallbackSampledAtMs: DateTime.toEpochMillis(current.latest.readAt),
          nativeSnapshot,
          previous: current.previous,
          counters: current.counters,
          updatePrevious: true,
        });
        const readAt = DateTime.makeUnsafe(merged.sampledAtMs);
        const snapshot: ResourceTelemetrySnapshot = {
          readAt,
          sampleIntervalMs: nativeHealth.sampleIntervalMs,
          processes: merged.processes,
          groups: merged.groups,
          attribution: attributionSnapshot,
          health: buildHealth({
            native: nativeHealth,
            nativeSnapshot,
          }),
        };
        yield* Ref.set(state, {
          nativeSnapshot,
          previous: merged.previous,
          counters: merged.counters,
          latest: snapshot,
          lastNativeSequence: incomingNativeSnapshot.snapshot.sequence,
          lastNativeGeneration: incomingNativeSnapshot.generation,
        });
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      }),
    );

  const acquireLive = liveMutex.withPermits(1)(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = yield* Ref.get(liveState);
        if (current.retainCount > 0) {
          yield* Ref.set(liveState, { ...current, retainCount: current.retainCount + 1 });
          return;
        }

        const scope = yield* Scope.make();
        yield* nativeClient.snapshots.pipe(
          Stream.runForEach(ingestNative),
          Effect.catch((error) =>
            Effect.logWarning("Native resource telemetry stream stopped", {
              cause: error.message,
            }),
          ),
          Effect.forkIn(scope),
        );
        yield* nativeClient.sampleNow.pipe(
          Effect.flatMap(ingestNative),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        yield* Ref.set(liveState, { retainCount: 1, scope: Option.some(scope) });
      }),
    ),
  );

  const releaseLive = liveMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(liveState);
      if (current.retainCount <= 1) {
        yield* Ref.set(liveState, { retainCount: 0, scope: Option.none() });
        if (Option.isSome(current.scope)) {
          yield* Scope.close(current.scope.value, Exit.void).pipe(Effect.ignore);
        }
        return;
      }
      yield* Ref.set(liveState, { ...current, retainCount: current.retainCount - 1 });
    }),
  );

  const latest = Ref.get(state).pipe(Effect.map((current) => current.latest));
  const subscribe = subscribeBeforeSnapshot(
    changes,
    Effect.acquireRelease(acquireLive, () => releaseLive).pipe(Effect.andThen(latest)),
    mutex,
  );
  const liveChanges = Stream.unwrap(Effect.map(subscribe, ({ changes }) => changes));

  const readHistory: ResourceTelemetry["Service"]["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const normalizedInput = normalizeResourceTelemetryHistoryInput(input);
      const historyResult = yield* Effect.result(
        nativeClient.readHistory(normalizedInput.windowMs),
      );
      if (Result.isFailure(historyResult)) {
        yield* Effect.logWarning("Failed to read native resource telemetry history", {
          cause: historyResult.failure.message,
        });
      }
      const nativeHealth = yield* nativeClient.health;
      const current = yield* Ref.get(state);
      return buildResourceTelemetryHistory({
        readAt,
        windowMs: normalizedInput.windowMs,
        bucketMs: normalizedInput.bucketMs,
        sampleIntervalMs: nativeHealth.sampleIntervalMs,
        serverPid: process.pid,
        sidecarPid: Option.map(nativeHealth.hello, (hello) => hello.sidecarPid),
        snapshots: Result.isSuccess(historyResult) ? historyResult.success : [],
        health: buildHealth({
          native: nativeHealth,
          nativeSnapshot: current.nativeSnapshot,
        }),
      });
    });
  yield* nativeHealthSubscription.changes.pipe(
    Stream.runForEach(() => refreshHealth),
    Effect.forkScoped,
  );
  const refresh: ResourceTelemetry["Service"]["refresh"] = nativeClient.sampleNow.pipe(
    Effect.flatMap(ingestNative),
    Effect.mapError(
      (cause) =>
        new ResourceTelemetryRefreshFailed({
          operation: "refresh",
          cause,
        }),
    ),
  );

  const validateProcessIdentity: ResourceTelemetry["Service"]["validateProcessIdentity"] = (
    identity,
  ) =>
    nativeClient.sampleNow.pipe(
      Effect.map(({ snapshot }) =>
        snapshot.processes.some(
          (process) => process.pid === identity.pid && process.startTimeMs === identity.startTimeMs,
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ResourceTelemetryRefreshFailed({
            operation: "validateProcessIdentity",
            cause,
          }),
      ),
    );

  return ResourceTelemetry.of({
    latest,
    changes: liveChanges,
    subscribe,
    readHistory,
    refresh,
    validateProcessIdentity,
    retry: nativeClient.retry.pipe(
      Effect.zip(Ref.get(state)),
      Effect.map(([accepted, current]): ResourceTelemetryRetryResult => ({
        accepted,
        snapshot: current.latest,
      })),
    ),
  });
});

export const layer = Layer.effect(ResourceTelemetry, make());
