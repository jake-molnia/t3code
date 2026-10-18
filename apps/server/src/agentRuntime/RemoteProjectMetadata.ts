import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Routing from "./WorkspaceRouting.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { redactRepositoryUrl } from "./RepositoryUrl.ts";
import * as P from "./worker/MetadataExecutor.ts";
import * as Assets from "./RemoteAssets.ts";

export const projectFileLayer = Layer.effect(
  T3ProjectFileLoader.T3ProjectFileLoader,
  Effect.gen(function* () {
    const routes = yield* Routing.WorkspaceRouting;
    return T3ProjectFileLoader.T3ProjectFileLoader.of({
      load: (cwd) =>
        routes.call({ cwd, method: "project.file", input: {} }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(P.ProjectFileResult)),
          Effect.map((result) => Option.fromNullishOr(result.file)),
          Effect.orDie,
        ),
    });
  }),
);
const makeRepository = (
  refine: (
    identity: C.RepositoryIdentity,
  ) => Effect.Effect<C.RepositoryIdentity, C.SourceControlProviderError>,
) =>
  Effect.gen(function* () {
    const routes = yield* Routing.WorkspaceRouting;
    const sql = yield* SqlClient.SqlClient;
    const cache = new Map<string, C.RepositoryIdentity | null>();
    return RepositoryIdentityResolver.RepositoryIdentityResolver.of({
      resolve: (cwd, options) =>
        Effect.gen(function* () {
          // Refinement may need native forge configuration. Reuse the observed worker without waking it.
          const observed = yield* routes.observe(
            cwd,
            routes
              .call({
                cwd,
                method: "project.repositoryIdentity",
                input: options?.refresh === undefined ? {} : { refresh: options.refresh },
              })
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(P.RepositoryResult)),
                Effect.flatMap((result) =>
                  Effect.gen(function* () {
                    const identity = result.identity;
                    return {
                      identity:
                        identity === null
                          ? null
                          : yield* refine(identity).pipe(Effect.orElseSucceed(() => identity)),
                    };
                  }),
                ),
              ),
          );
          if (observed !== null) {
            cache.set(cwd, observed.identity);
            return observed.identity;
          }
          if (cache.has(cwd)) return cache.get(cwd) ?? null;
          const route = yield* routes.describeCwd(cwd);
          const rows = yield* sql<{
            sourceUrl: string | null;
          }>`SELECT source_url AS sourceUrl FROM agent_runtime_workspace_paths WHERE virtual_cwd=${route.virtualCwd}`;
          const source = rows[0]?.sourceUrl;
          if (!source) return null;
          return RepositoryIdentityResolver.buildRepositoryIdentity({
            remoteName: "origin",
            remoteUrl: redactRepositoryUrl(source),
            originUrl: undefined,
            rootPath: route.virtualCwd,
          });
        }).pipe(Effect.catchCause(() => Effect.succeed(cache.get(cwd) ?? null))),
    });
  });

export const repositoryLayer = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  makeRepository(Effect.succeed),
);

export const refinedRepositoryLayer = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const refine = Effect.fn("RemoteProjectMetadata.refineRepositoryIdentity")(function* (
      identity: C.RepositoryIdentity,
    ) {
      for (const driver of SourceControlBuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS) {
        const provider = yield* registry.get(driver.kind);
        if (provider.refineRepositoryIdentity === undefined) continue;
        const refined = yield* provider.refineRepositoryIdentity({
          identity,
          resolveContext: (input) =>
            registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
        });
        if (refined !== identity) return refined;
      }
      return identity;
    });
    return yield* makeRepository(refine);
  }),
);

export const faviconLayer = Layer.effect(
  ProjectFaviconResolver.ProjectFaviconResolver,
  Effect.gen(function* () {
    const routes = yield* Routing.WorkspaceRouting;
    const assets = yield* Effect.serviceOption(Assets.RemoteAssets);
    const cache = new Map<string, string | null>();
    return ProjectFaviconResolver.ProjectFaviconResolver.of({
      resolvePath: (cwd, preferred) =>
        Effect.gen(function* () {
          const key = `${cwd}\0${preferred ?? ""}`;
          const raw = yield* routes.observeCall({
            cwd,
            method: "project.favicon",
            input: { ...(preferred ? { preferred } : {}) },
          });
          if (raw === null) return cache.get(key) ?? null;
          const result = yield* Schema.decodeUnknownEffect(P.FaviconResult)(raw);
          if (Option.isSome(assets))
            yield* assets.value
              .rememberFavicon(cwd, preferred, result.path)
              .pipe(Effect.timeoutOption("2 seconds"), Effect.ignoreCause({ log: true }));
          cache.set(key, result.path);
          return result.path;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectFaviconResolver.ProjectFaviconResolutionError({
                operation: "resolve-path",
                workspaceRoot: cwd,
                cause,
              }),
          ),
        ),
    });
  }),
);
