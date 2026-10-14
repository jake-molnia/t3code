import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SERVER_SOURCE_REPOSITORY = "jake-molnia/t3code";
export const SERVER_IMAGE_WORKFLOW = "sandbox-images.yml";
export const SERVER_IMAGE_BUILDS_URL = `https://github.com/${SERVER_SOURCE_REPOSITORY}/actions/workflows/${SERVER_IMAGE_WORKFLOW}`;

export const ServerBuild = Schema.Struct({
  sourceRepository: Schema.Literal(SERVER_SOURCE_REPOSITORY),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  packageVersion: TrimmedNonEmptyString,
  upstreamVersion: TrimmedNonEmptyString,
});
export type ServerBuild = typeof ServerBuild.Type;

export const ServerReleaseNotice = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["unconfigured", "unavailable", "current"]) }),
  Schema.Struct({
    status: Schema.Literal("available"),
    revision: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
  }),
]);
export type ServerReleaseNotice = typeof ServerReleaseNotice.Type;
