import {
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 20;
const REGISTRY_REQUEST_TIMEOUT = "30 seconds";

const BoundedAgentId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);
const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
// Registry versions are bounded identifiers.
const BoundedVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
);
const BoundedDescription = Schema.String.check(Schema.isMaxLength(1_024));
const BoundedMetadata = Schema.String.check(Schema.isMaxLength(256));
const BoundedArgument = Schema.String.check(Schema.isMaxLength(1_024));
const EXACT_RUNNER_VERSION = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  "iu",
);
const EXACT_UVX_PACKAGE = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`, "iu");
const NpxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_NPX_PACKAGE.test(value) || "ACP Registry npx packages must include an exact version.",
  ),
);
const UvxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_UVX_PACKAGE.test(value) || "ACP Registry uvx packages must include an exact version.",
  ),
);
const HttpsUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" && url.username.length === 0 && url.password.length === 0) ||
        "ACP Registry URLs must use HTTPS without embedded credentials."
      );
    } catch {
      return "ACP Registry URLs must be valid absolute URLs.";
    }
  }),
);

const AcpRegistryPackageDistributionFields = {
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
} as const;
const AcpRegistryNpxDistribution = Schema.Struct({
  package: NpxPackage,
  ...AcpRegistryPackageDistributionFields,
});
const AcpRegistryUvxDistribution = Schema.Struct({
  package: UvxPackage,
  ...AcpRegistryPackageDistributionFields,
});

const AcpRegistryBinaryTarget = Schema.Struct({
  archive: HttpsUrl,
  cmd: BoundedArgument,
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/iu))),
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
});

const AcpRegistryAgent = Schema.Struct({
  id: BoundedAgentId,
  name: BoundedName,
  version: BoundedVersion,
  description: BoundedDescription,
  authors: Schema.optionalKey(Schema.Array(BoundedMetadata).check(Schema.isMaxLength(16))),
  license: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.optionalKey(HttpsUrl),
  repository: Schema.optionalKey(HttpsUrl),
  icon: Schema.optionalKey(HttpsUrl),
  distribution: Schema.Struct({
    binary: Schema.optionalKey(Schema.Record(Schema.String, AcpRegistryBinaryTarget)),
    npx: Schema.optionalKey(AcpRegistryNpxDistribution),
    uvx: Schema.optionalKey(AcpRegistryUvxDistribution),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

const AcpRegistryIndexEnvelope = Schema.Struct({
  version: BoundedVersion,
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(512)),
});
export interface AcpRegistryIndex {
  readonly version: string;
  readonly agents: ReadonlyArray<AcpRegistryAgent>;
}

const decodeRegistryIndexEnvelope = Schema.decodeUnknownEffect(AcpRegistryIndexEnvelope);
const decodeRegistryAgent = Schema.decodeUnknownOption(AcpRegistryAgent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHttpsUrl = Schema.decodeUnknownEffect(HttpsUrl);

export const AcpRegistryErrorReason = AcpRegistryOperationErrorReason;
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: AcpRegistryErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export function toAcpRegistryOperationError(error: AcpRegistryError): AcpRegistryOperationError {
  return new AcpRegistryOperationError({
    reason: error.reason,
    message: error.detail,
    cause: error,
  });
}

export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

export interface ResolvedAcpRegistryDistribution {
  readonly kind: AcpRegistryDistributionKind;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binaryTarget?: typeof AcpRegistryBinaryTarget.Type;
  readonly packageName?: string;
}

export function resolveAcpRegistryDistribution(input: {
  readonly agent: AcpRegistryAgent;
  readonly preference: AcpRegistryDistributionPreference;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const binary = platformTarget ? agent.distribution.binary?.[platformTarget] : undefined;
  const candidates: ReadonlyArray<AcpRegistryDistributionKind> =
    input.preference === "auto" ? ["binary", "npx", "uvx"] : [input.preference];

  for (const kind of candidates) {
    if (kind === "binary" && binary) {
      return {
        kind,
        args: binary.args ?? [],
        env: binary.env ?? {},
        binaryTarget: binary,
      };
    }
    if (kind === "npx" && agent.distribution.npx) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageName: agent.distribution.npx.package,
      };
    }
    if (kind === "uvx" && agent.distribution.uvx) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageName: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

export interface ResolvedAcpRegistryAgent {
  readonly agent?: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind | "local";
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

export type AcpRegistryInspection =
  | { readonly status: "unconfigured" }
  | { readonly status: "not_found"; readonly agentId: string }
  | {
      readonly status: "unsupported";
      readonly agentId: string;
      readonly version: string;
    }
  | {
      readonly status: "missing_runner";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
      readonly runner: string;
    }
  | {
      readonly status: "missing_runner";
      readonly version: null;
      readonly distribution: "local";
    }
  | {
      readonly status: "unprepared";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string | null;
      readonly distribution: AcpRegistryDistributionKind | "local";
      readonly documentationUrl?: string;
    };

export class AcpRegistryCatalog extends Context.Service<
  AcpRegistryCatalog,
  {
    readonly search: (
      input: AcpRegistrySearchInput,
    ) => Effect.Effect<AcpRegistrySearchResult, AcpRegistryError>;
    readonly inspect: (
      settings: AcpRegistrySettings,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AcpRegistryInspection, AcpRegistryError>;
    readonly resolve: (
      settings: AcpRegistrySettings,
      cwd: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistrySupport/AcpRegistryCatalog") {}

const layer = (options: AcpRegistryCatalogOptions) =>
  Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog(options));

/**
 * The server-lifetime catalog, with the runtime coordinator built alongside
 * it so setup, snapshots, and turn launch share one of each. Its cache lives
 * in the host's provider status cache. Executables come from the sandbox image.
 */
export const layerFromHost = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const { paths } = yield* ProviderHost.ProviderHost;
      return layer({
        cacheDir: paths.providerStatusCacheDir,
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);

export interface AcpRegistryCatalogOptions {
  readonly cacheDir: string;
  readonly registryUrl?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;

  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(" ").toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;

  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

export const makeAcpRegistryCatalog = Effect.fn("AcpRegistryCatalog.make")(function* (
  input: AcpRegistryCatalogOptions,
): Effect.fn.Return<
  AcpRegistryCatalog["Service"],
  never,
  Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
  const registryRef = yield* Ref.make<AcpRegistryIndex | undefined>(undefined);
  const registryRevision = yield* Ref.make(0);
  const registrySemaphore = yield* Semaphore.make(1);
  const assertHttpsUrl = Effect.fn("AcpRegistryCatalog.assertHttpsUrl")(function* (
    value: string,
    detail: string,
  ) {
    const valid = yield* decodeHttpsUrl(value).pipe(Effect.option);
    if (Option.isNone(valid)) {
      return yield* new AcpRegistryError({ reason: "registry_unavailable", detail });
    }
    return value;
  });

  const decodeRegistryText = Effect.fn("AcpRegistryCatalog.decodeRegistryText")(function* (
    text: string,
  ) {
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned invalid JSON.",
            cause,
          }),
      ),
    );
    const envelope = yield* decodeRegistryIndexEnvelope(decoded).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned an invalid index.",
            cause,
          }),
      ),
    );
    const agents = envelope.agents.flatMap((candidate) => {
      const decodedAgent = decodeRegistryAgent(candidate);
      return Option.isSome(decodedAgent) ? [decodedAgent.value] : [];
    });
    const discarded = envelope.agents.length - agents.length;
    if (discarded > 0) {
      yield* Effect.logWarning("ignored invalid ACP Registry entries", { discarded });
    }
    return { version: envelope.version, agents } satisfies AcpRegistryIndex;
  });

  const readCachedRegistry = fileSystem
    .readFileString(registryCachePath)
    .pipe(Effect.flatMap(decodeRegistryText), Effect.option);

  const writeRegistryCache = (text: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.flatMap((id) => {
        const temporaryPath = `${registryCachePath}.${process.pid}-${id}.tmp`;
        return fileSystem
          .makeDirectory(registryDirectory, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(temporaryPath, text)),
            Effect.andThen(fileSystem.rename(temporaryPath, registryCachePath)),
            Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          );
      }),
      Effect.ignore,
    );

  const fetchRegistry = Effect.fn("AcpRegistryCatalog.fetchRegistry")(function* () {
    yield* assertHttpsUrl(registryUrl, "ACP Registry index URL must use HTTPS.");
    const response = yield* httpClient.execute(HttpClientRequest.get(registryUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: `Could not fetch ACP Registry index from ${registryUrl}.`,
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out fetching ACP Registry index.",
            }),
          ),
      }),
    );
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_REGISTRY_BYTES + 1,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "Could not read ACP Registry response body.",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out reading ACP Registry response body.",
            }),
          ),
      }),
    );
    if (collected.truncated || collected.bytes > MAX_REGISTRY_BYTES) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: `ACP Registry index exceeds ${MAX_REGISTRY_BYTES} bytes.`,
      });
    }
    if (collected.invalidUtf8) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "ACP Registry index is not valid UTF-8.",
      });
    }
    const registry = yield* decodeRegistryText(collected.text);
    yield* writeRegistryCache(collected.text);
    return registry;
  });

  const refreshRegistry = Effect.fn("AcpRegistryCatalog.refreshRegistry")(function* () {
    const observedRevision = yield* Ref.get(registryRevision);
    return yield* registrySemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentRevision = yield* Ref.get(registryRevision);
        const current = yield* Ref.get(registryRef);
        if (current !== undefined && currentRevision !== observedRevision) return current;

        const registry = yield* fetchRegistry().pipe(
          Effect.catch((networkError) =>
            readCachedRegistry.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(networkError),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        );
        yield* Ref.set(registryRef, registry);
        yield* Ref.update(registryRevision, (revision) => revision + 1);
        return registry;
      }),
    );
  });

  const loadCachedRegistry = Effect.fn("AcpRegistryCatalog.loadCachedRegistry")(function* () {
    const current = yield* Ref.get(registryRef);
    if (current !== undefined) return current;

    const cached = yield* readCachedRegistry;
    if (Option.isNone(cached)) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "No valid cached ACP Registry index is available.",
      });
    }
    yield* Ref.set(registryRef, cached.value);
    return cached.value;
  });

  const loadRegistry = Effect.fn("AcpRegistryCatalog.loadRegistry")(function* () {
    return yield* loadCachedRegistry().pipe(Effect.catch(() => refreshRegistry()));
  });

  const findAgent = Effect.fn("AcpRegistryCatalog.findAgent")(function* (
    registry: AcpRegistryIndex,
    agentId: string,
  ) {
    const agent = registry.agents.find((candidate) => candidate.id === agentId.trim());
    if (agent === undefined) {
      return yield* new AcpRegistryError({
        reason: "agent_not_found",
        detail: `ACP Registry does not contain agent '${agentId.trim()}'.`,
      });
    }
    return agent;
  });

  const compatibleDistribution = Effect.fn("AcpRegistryCatalog.compatibleDistribution")(function* (
    agent: AcpRegistryAgent,
    preference: AcpRegistryDistributionPreference,
  ) {
    const distribution = resolveAcpRegistryDistribution({
      agent,
      preference,
      platformTarget,
    });
    if (distribution === undefined) {
      return yield* new AcpRegistryError({
        reason: platformTarget === undefined ? "unsupported_platform" : "unsupported_distribution",
        detail: `ACP Registry agent ${agent.id} has no ${preference === "auto" ? "compatible" : preference} distribution for ${platform}-${architecture}.`,
      });
    }
    return distribution;
  });

  const search: AcpRegistryCatalog["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const registry = yield* refreshRegistry();
      const ranked = registry.agents.flatMap((agent) => {
        const distribution = resolveAcpRegistryDistribution({
          agent,
          preference: "auto",
          platformTarget,
        });
        const rank = searchRank(agent, input.query);
        return distribution === undefined || rank === undefined
          ? []
          : [{ agent, distribution, rank }];
      });
      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
          compareText(left.agent.id, right.agent.id),
      );
      return {
        agents: ranked.slice(0, MAX_SEARCH_RESULTS).map(({ agent, distribution }) => ({
          id: agent.id,
          name: agent.name,
          version: agent.version,
          description: agent.description,
          authors: agent.authors ?? [],
          license: agent.license ?? null,
          website: agent.website ?? null,
          repository: agent.repository ?? null,
          icon: agent.icon ?? null,
          distribution: distribution.kind,
          integrity:
            distribution.kind === "binary" && distribution.binaryTarget?.sha256 !== undefined
              ? "sha256"
              : "registry",
        })),
      } satisfies AcpRegistrySearchResult;
    });

  const validateLocalExecutable = (command: string) =>
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
      ? Effect.fail(
          new AcpRegistryError({
            reason: "runner_unavailable",
            detail:
              "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
          }),
        )
      : Effect.void;

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = (settings, environment) =>
    Effect.gen(function* () {
      if (settings.source === "local") {
        const command = settings.commandPath.trim();
        if (!command) return { status: "unconfigured" } as const;
        const executable = resolveExecutable(command, platform, environment ?? hostEnvironment);
        if (executable !== undefined) yield* validateLocalExecutable(executable);
        return executable === undefined
          ? ({
              status: "missing_runner",
              version: null,
              distribution: "local",
            } as const)
          : ({ status: "ready", agentId: command, version: null, distribution: "local" } as const);
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) return { status: "unconfigured" } as const;
      const registry = yield* loadCachedRegistry();
      const agent = registry.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return { status: "not_found", agentId } as const;
      const documentationUrl = agent.website ?? agent.repository;
      const distribution = resolveAcpRegistryDistribution({
        agent,
        preference: settings.distribution,
        platformTarget,
      });
      if (distribution === undefined) {
        return { status: "unsupported", agentId, version: agent.version } as const;
      }

      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const available =
          resolveExecutable(commandOverride, platform, environment ?? hostEnvironment) !==
          undefined;
        return available
          ? ({
              status: "ready",
              agentId,
              // The catalog version does not describe an overridden executable.
              version: null,
              distribution: distribution.kind,
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const)
          : ({
              status: "missing_runner",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
              runner: commandOverride,
            } as const);
      }

      return {
        status: "unprepared",
        agentId,
        version: agent.version,
        distribution: distribution.kind,
      } as const;
    });

  const resolve: AcpRegistryCatalog["Service"]["resolve"] = (settings, cwd, environment) =>
    Effect.gen(function* () {
      if (settings.source === "local") {
        const executable = settings.commandPath.trim();
        if (!executable) {
          return yield* new AcpRegistryError({
            reason: "agent_not_configured",
            detail: "Local ACP provider requires an executable.",
          });
        }
        const env = environment ?? hostEnvironment;
        const command = resolveExecutable(executable, platform, env);
        if (command === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: "Local ACP executable is not available on this environment's PATH.",
          });
        }
        yield* validateLocalExecutable(command);
        return {
          distribution: "local",
          spawn: { command, args: settings.commandArgs, cwd, env, shell: false },
        } satisfies ResolvedAcpRegistryAgent;
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "ACP Registry provider requires a registry agent ID.",
        });
      }
      const registry = yield* loadRegistry();
      const agent = yield* findAgent(registry, agentId);
      const distribution = yield* compatibleDistribution(agent, settings.distribution);

      let command: string;
      let args: ReadonlyArray<string>;
      const effectiveEnvironment = environment ?? hostEnvironment;
      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const resolvedOverride = resolveExecutable(commandOverride, platform, effectiveEnvironment);
        if (resolvedOverride === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: `ACP Registry agent ${agent.id} requires '${commandOverride}', but it is not available on this provider instance's PATH.`,
          });
        }
        command = resolvedOverride;
        yield* validateLocalExecutable(command);
        args = distribution.args;
      } else {
        return yield* new AcpRegistryError({
          reason: "runner_unavailable",
          detail: `ACP agent ${agent.id} requires an executable supplied by the execution image. Configure its image executable path.`,
        });
      }

      return {
        agent,
        distribution: distribution.kind,
        spawn: {
          command,
          args,
          cwd,
          env: { ...effectiveEnvironment, ...distribution.env },
          shell: false,
        },
      } satisfies ResolvedAcpRegistryAgent;
    });

  return AcpRegistryCatalog.of({
    search,
    inspect,
    resolve,
  });
});
