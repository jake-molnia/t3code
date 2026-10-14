import type { ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderVersionSource,
} from "@t3tools/provider-core/server/versionAdvisory";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

/** Mirrors the official launcher, which reads MUSE_CHANNEL and accepts only these two. */
const MUSE_CHANNELS = new Set(["muse-stable", "muse-canary"]);
const ChannelManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/)),
});

/** Muse prints both a display version and a release revision; prefer the latter. */
export function parseMuseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? parseGenericCliVersion(output);
}

function comparableMuseVersion(version: string): string {
  // Make the release sequence numeric for semver comparison (R9 precedes R10).
  return version.replace(/-R(\d+)(?:\.(\d+))?$/, "-release.$1.$2").replace(/\.$/, ".0");
}

const MUSE_REVISION = /-R\d+(?:\.\d+)?$/;

/** A version printed without a revision is compared by its release alone. */
export const compareMuseVersions = (current: string, latest: string) =>
  MUSE_REVISION.test(current) === MUSE_REVISION.test(latest)
    ? compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest))
    : compareSemverVersions(current.replace(MUSE_REVISION, ""), latest.replace(MUSE_REVISION, ""));

export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  const channel = environment.MUSE_CHANNEL || "muse-stable";
  if (!MUSE_CHANNELS.has(channel)) return null;
  const channelUrl = `https://api.meta.ai/muse-code/channels/${channel}`;
  const client = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  return yield* latestVersions.cached(
    `muse:${channelUrl}`,
    client.execute(HttpClientRequest.get(channelUrl)).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ChannelManifest)),
              Effect.map((manifest) => parseMuseVersion(manifest.version)),
            )
          : Effect.succeed(null),
      ),
      Effect.timeout(4_000),
      Effect.orElseSucceed(() => null),
    ),
    options,
  );
});

/** Explicit refreshes bypass the channel cache before snapshot enrichment reads it. */
export const getMuseVersionSource = Effect.fn("getMuseVersionSource")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  if (options?.fresh) yield* latestMuseVersion(environment, { fresh: true });
  return { packageName: null, compareVersions: compareMuseVersions };
});

/** Feed Muse's release channel into the same advisory and notification flow as other drivers. */
export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly versionSource: ProviderVersionSource;
  readonly enableProviderUpdateChecks: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { snapshot } = input;
  const latestVersion =
    input.enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && snapshot.version
      ? yield* latestMuseVersion(input.environment)
      : null;
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    { ...input.versionSource, latestVersion },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
});
