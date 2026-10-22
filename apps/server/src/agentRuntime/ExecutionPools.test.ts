import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Pools from "./ExecutionPools.ts";
import { placement } from "./testkit/Sandbox.ts";

it.effect("unconfigured native execution has no implicit local or legacy runtime fallback", () =>
  Effect.gen(function* () {
    const pools = yield* Pools.ExecutionPools;
    expect(pools.enabled).toBe(false);
    expect((yield* pools.snapshot).pools).toEqual([]);
    expect(yield* pools.get().pipe(Effect.flip)).toMatchObject({ _tag: "ExecutionPoolError" });
  }).pipe(
    Effect.provide(
      Pools.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              AGENT_RUNTIME_URL: "http://legacy.invalid",
              AGENT_RUNTIME_TOKEN: "ignored",
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("loads native placements and reports unavailable capacity without starting compute", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const file = `${directory}/pools.json`;
    const pool = placement();
    yield* fs.writeFileString(file, JSON.stringify({ defaultPoolId: pool.id, pools: [pool] }));
    const pools = yield* Pools.ExecutionPools.pipe(
      Effect.provide(
        Pools.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3_EXECUTION_POOLS_FILE: file,
                T3_KUBERNETES_TOKEN_FILE: `${directory}/missing-token`,
              }),
            ),
          ),
        ),
      ),
    );
    expect(yield* pools.get()).toEqual(pool);
    expect(yield* pools.snapshot).toEqual({
      defaultPoolId: pool.id,
      sandboxIdeAvailable: true,
      pools: [
        {
          id: pool.id,
          label: pool.label,
          available: false,
          resources: null,
          requestCapacity: null,
          providerDrivers: pool.providerDrivers,
        },
      ],
    });
    yield* fs.writeFileString(
      file,
      JSON.stringify({ defaultPoolId: pool.id, pools: [pool, pool] }),
    );
    const result = yield* Pools.ExecutionPools.pipe(
      Effect.provide(
        Pools.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ T3_EXECUTION_POOLS_FILE: file })),
          ),
        ),
      ),
      Effect.flip,
    );
    expect(result).toMatchObject({
      _tag: "ExecutionPoolError",
      detail: "Duplicate execution pool identifier",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
