import { ExecutionPoolId, type ExecutionPoolsSnapshot } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Configuration, type Placement } from "../sandbox/Configuration.ts";
import * as Kubernetes from "../sandbox/Kubernetes.ts";

export class PoolError extends Schema.TaggedError<PoolError>()("ExecutionPoolError", {
  detail: Schema.String,
}) {}
export class ExecutionPools extends Context.Service<
  ExecutionPools,
  {
    readonly enabled: boolean;
    readonly defaultPoolId: ExecutionPoolId;
    readonly get: (id?: string | null) => Effect.Effect<Placement, PoolError>;
    readonly snapshot: Effect.Effect<ExecutionPoolsSnapshot>;
  }
>()("t3/agentRuntime/ExecutionPools") {}

export const layer = Layer.effect(
  ExecutionPools,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const kubernetes = yield* Kubernetes.Kubernetes;
    const file = yield* Config.option(Config.String("T3_EXECUTION_POOLS_FILE"));
    const connections = new Map<string, Placement>();
    let defaultPoolId = ExecutionPoolId.make("local");
    if (Option.isSome(file)) {
      const config = yield* fs
        .readFileString(file.value)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))));
      defaultPoolId = config.defaultPoolId;
      for (const entry of config.pools) {
        if (connections.has(entry.id))
          return yield* new PoolError({ detail: "Duplicate execution pool identifier" });
        connections.set(entry.id, entry);
      }
      if (!connections.has(defaultPoolId))
        return yield* new PoolError({ detail: "Default execution pool must be configured" });
    }
    const get = (id?: string | null) =>
      Effect.suspend(() => {
        const pool = connections.get(id ?? defaultPoolId);
        return pool
          ? Effect.succeed(pool)
          : Effect.fail(
              new PoolError({ detail: "Execution pool is unavailable or not configured" }),
            );
      });
    const snapshot = Effect.forEach(
      [...connections.values()],
      (pool) =>
        kubernetes.available(pool).pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => false),
          Effect.map((available) => ({
            id: pool.id,
            label: pool.label,
            available,
            resources: null,
            requestCapacity: null,
            providerDrivers: pool.providerDrivers,
          })),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((pools) => ({ defaultPoolId, pools, sandboxIdeAvailable: connections.size > 0 })),
    );
    return ExecutionPools.of({ enabled: connections.size > 0, defaultPoolId, get, snapshot });
  }),
).pipe(Layer.provide(Kubernetes.layer));
