import {
  ExecutionPoolId,
  ExecutionPoolsSnapshot,
  HostResourcesSnapshot,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const Pool = Schema.Struct({
  id: ExecutionPoolId,
  label: Schema.String,
  url: Schema.String,
  tokenFile: Schema.String,
  profile: Schema.String,
  providerDrivers: Schema.Array(ProviderDriverKind),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const Configuration = Schema.Struct({ defaultPoolId: ExecutionPoolId, pools: Schema.Array(Pool) });
export type PoolConnection = {
  readonly id: ExecutionPoolId;
  readonly label: string;
  readonly url: string;
  readonly token: string;
  readonly profile: string;
  readonly providerDrivers: ReadonlyArray<ProviderDriverKind>;
};
export class PoolError extends Schema.TaggedError<PoolError>()("ExecutionPoolError", {
  detail: Schema.String,
}) {}
export class ExecutionPools extends Context.Service<
  ExecutionPools,
  {
    readonly enabled: boolean;
    readonly defaultPoolId: ExecutionPoolId;
    readonly get: (id?: string | null) => Effect.Effect<PoolConnection, PoolError>;
    readonly snapshot: Effect.Effect<ExecutionPoolsSnapshot>;
  }
>()("t3/agentRuntime/ExecutionPools") {}

export const layer = Layer.effect(
  ExecutionPools,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const file = yield* Config.option(Config.String("T3_EXECUTION_POOLS_FILE"));
    const ideOrigin = yield* Config.option(Config.String("T3CODE_SANDBOX_IDE_ORIGIN"));
    const connections = new Map<string, PoolConnection>();
    let defaultPoolId = ExecutionPoolId.make("local");
    if (Option.isSome(file)) {
      const config = yield* fs
        .readFileString(file.value)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))));
      defaultPoolId = config.defaultPoolId;
      for (const entry of config.pools) {
        if (connections.has(entry.id))
          return yield* new PoolError({ detail: "Duplicate execution pool identifier" });
        const url = yield* Effect.try(() => new URL(entry.url)).pipe(
          Effect.mapError(() => new PoolError({ detail: "Invalid execution pool URL" })),
        );
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          return yield* new PoolError({
            detail: "Execution pools require HTTP(S) URLs without embedded credentials or queries",
          });
        if (entry.enabled === false) continue;
        const token = (yield* fs.readFileString(entry.tokenFile)).trim();
        if (token.length < 32 || !entry.profile.trim())
          return yield* new PoolError({
            detail: "Execution pool credentials and profile are required",
          });
        connections.set(entry.id, { ...entry, token });
      }
      if (!connections.has(defaultPoolId))
        return yield* new PoolError({ detail: "Default execution pool must be enabled" });
    } else {
      const url = yield* Config.option(Config.String("AGENT_RUNTIME_URL"));
      const token = yield* Config.String("AGENT_RUNTIME_TOKEN").pipe(Config.withDefault(""));
      const profile = yield* Config.String("AGENT_RUNTIME_PROFILE").pipe(Config.withDefault("t3"));
      if (Option.isSome(url)) {
        if (!token) return yield* new PoolError({ detail: "AGENT_RUNTIME_TOKEN is required" });
        connections.set(defaultPoolId, {
          id: defaultPoolId,
          label: "Sandbox",
          url: url.value,
          token,
          profile,
          providerDrivers: [],
        });
      }
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
        Effect.gen(function* () {
          const headers = { authorization: `Bearer ${pool.token}` };
          const available = yield* http
            .execute(
              HttpClientRequest.get(
                new URL("healthz", pool.url.replace(/\/?$/, "/")).toString(),
              ).pipe(HttpClientRequest.setHeaders(headers)),
            )
            .pipe(
              Effect.map((response) => response.status === 204 || response.status === 200),
              Effect.timeout("3 seconds"),
              Effect.orElseSucceed(() => false),
            );
          const resources = available
            ? yield* http
                .execute(
                  HttpClientRequest.get(
                    new URL("v1/resources", pool.url.replace(/\/?$/, "/")).toString(),
                  ).pipe(HttpClientRequest.setHeaders(headers)),
                )
                .pipe(
                  Effect.flatMap((response) =>
                    Effect.gen(function* () {
                      if (response.status !== 200)
                        return yield* new PoolError({ detail: "Pool metrics unavailable" });
                      return yield* response.json;
                    }),
                  ),
                  Effect.flatMap(Schema.decodeUnknownEffect(HostResourcesSnapshot)),
                  Effect.timeout("3 seconds"),
                  Effect.orElseSucceed(() => null),
                )
            : null;
          return {
            id: pool.id,
            label: pool.label,
            available,
            resources,
            providerDrivers: pool.providerDrivers,
          };
        }),
      { concurrency: 4 },
    ).pipe(
      Effect.map((pools) => ({
        defaultPoolId,
        pools,
        ...(Option.isSome(ideOrigin) ? { sandboxIdeAvailable: true } : {}),
      })),
    );
    return ExecutionPools.of({ enabled: connections.size > 0, defaultPoolId, get, snapshot });
  }),
);
