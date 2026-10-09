import * as Path from "effect/Path";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import { redactRepositoryUrl } from "../RepositoryUrl.ts";
import { WorkspaceExecutionError } from "./Protocol.ts";

export const MetadataRequest = Schema.Struct({
  cwd: Schema.String,
  refresh: Schema.optional(Schema.Boolean),
  preferred: Schema.optional(Schema.String),
});
export const ProjectFileResult = Schema.Struct({ file: Schema.NullOr(C.T3ProjectFile) });
export const RepositoryResult = Schema.Struct({ identity: Schema.NullOr(C.RepositoryIdentity) });
export const FaviconResult = Schema.Struct({ path: Schema.NullOr(Schema.String) });
export const makeMetadataExecutor = <E>(options: {
  resolve: (cwd: string) => Effect.Effect<string, E>;
}) =>
  Effect.gen(function* () {
    const files = yield* T3ProjectFileLoader.T3ProjectFileLoader;
    const path = yield* Path.Path;
    const root = yield* options.resolve(".");
    const virtualPath = (absolute: string) => {
      const relative = path.relative(root, absolute);
      return !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
        ? path.join("/workspace", relative)
        : absolute;
    };
    const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const favicons = yield* ProjectFaviconResolver.ProjectFaviconResolver;
    const execute = (method: string, raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(MetadataRequest)(raw);
        const cwd = yield* options.resolve(input.cwd);
        switch (method) {
          case "project.file":
            return { file: Option.getOrNull(yield* files.load(cwd)) };
          case "project.repositoryIdentity": {
            const identity = yield* repositories.resolve(cwd, {
              ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
            });
            if (identity === null) return { identity: null };
            const safe = RepositoryIdentityResolver.buildRepositoryIdentity({
              remoteName: identity.locator.remoteName,
              remoteUrl: redactRepositoryUrl(identity.locator.remoteUrl),
              originUrl: identity.origin?.canonicalKey,
              rootPath: virtualPath(identity.rootPath ?? cwd),
            });
            return {
              identity: {
                ...safe,
                ...(identity.webUrl ? { webUrl: redactRepositoryUrl(identity.webUrl) } : {}),
              },
            };
          }
          case "project.favicon": {
            const preferred = input.preferred?.startsWith("/workspace/")
              ? yield* options.resolve(input.preferred.slice("/workspace/".length))
              : input.preferred;
            const found = yield* favicons.resolvePath(cwd, preferred);
            return { path: found === null ? null : virtualPath(found) };
          }
          default:
            return yield* new WorkspaceExecutionError({
              code: "unsupported_project_metadata_method",
            });
        }
      });
    return { execute };
  });
