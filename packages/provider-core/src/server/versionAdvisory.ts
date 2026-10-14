import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

/** Read-only release metadata. Executables are supplied by the sandbox image. */
export interface ProviderVersionSource {
  readonly packageName: string | null;
  readonly latestVersion?: string | null;
  readonly compareVersions?: (current: string, latest: string) => number;
}

const LATEST_VERSION_TIMEOUT_MS = 4_000;
const IMAGE_UPGRADE_NOTICE =
  "A newer provider release is available. Upgrade the sandbox image to change the installed version.";
const NpmLatestVersionResponse = Schema.Struct({ version: Schema.optional(Schema.String) });
const nonEmptyString = (value: string | undefined) => value?.trim() || null;

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly compareVersions?: (current: string, latest: string) => number;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (
    (input.compareVersions ?? compareSemverVersions)(input.currentVersion, input.latestVersion) < 0
  ) {
    return {
      status: "behind_latest",
      message: IMAGE_UPGRADE_NOTICE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly versionSource?: ProviderVersionSource;
}): ServerProviderVersionAdvisory {
  const capabilities = input.versionSource ?? { packageName: null };
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
    ...(capabilities.compareVersions ? { compareVersions: capabilities.compareVersions } : {}),
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  versionSource: ProviderVersionSource,
) {
  if (versionSource.latestVersion !== undefined) {
    return versionSource.latestVersion;
  }
  const packageName = versionSource.packageName;
  if (!packageName) {
    return null;
  }

  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  return yield* latestVersions.cached(packageName, fetchNpmLatestVersion(packageName));
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  versionSource?: ProviderVersionSource,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
  },
) {
  const capabilities = versionSource ?? { packageName: null };
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        versionSource: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      versionSource: capabilities,
    }),
  };
});
