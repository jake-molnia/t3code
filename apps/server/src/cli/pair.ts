/**
 * `t3 pair` - mint a pairing token for an already-running server and print it
 * as a QR code, without restarting anything.
 *
 * Discovery reads the `server-runtime.json` a live server persists next to its
 * database, then confirms the process is actually answering by fetching its
 * public environment descriptor. Inside a linked git worktree the worktree's
 * own `.t3` is checked first (matching dev-runner precedence); otherwise the
 * shared T3 home.
 */
import {
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  isProcessAlive,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  buildPairingUrl,
  isLoopbackHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { authScopesFlag } from "./authScopes.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PAIR_PROBE_TIMEOUT = Duration.millis(2_500);
export type PairStateVariant = "userdata" | "dev";

// deriveServerPaths only checks devUrl for undefined-ness when picking the
// dev-vs-userdata state directory; the value itself is not used.
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

export class NoRunningServerError extends Schema.TaggedError<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "No running T3 Code server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      "Start one with `npx t3 serve`, or connect this machine with T3 Connect: `npx t3 connect`.",
    ].join("\n");
  }
}

/** The web origin a browser should pair through. */
export const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ?? resolveHeadlessConnectionString(state.host, state.port);

const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");

type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PAIR_PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

interface DiscoveredPairTarget {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

const discoverPairTarget = Effect.fn("pair.discoverPairTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const bases: Array<string> = [];
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    bases.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    // Same precedence as dev-runner: inside a linked worktree its own `.t3`
    // outranks the shared home, so `t3 pair` in a worktree pairs with the dev
    // server under test rather than the daily-driver install.
    const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
    if (worktreeHome !== undefined) {
      bases.push(worktreeHome);
    }
    const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
    bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)));
  }

  const checkedStatePaths: Array<string> = [];
  for (const baseDir of new Set(bases)) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const statePath = derivedPaths.serverRuntimeStatePath;
      checkedStatePaths.push(statePath);
      const state = yield* readPersistedServerRuntimeState(statePath);
      if (Option.isNone(state)) {
        continue;
      }
      // The pid check guards against a dead server's state file whose port
      // was since reused by a different server: pairing would then mint a
      // token in the old database while the QR code points at the new server.
      if (!isProcessAlive(state.value.pid)) {
        continue;
      }
      const probed = yield* probeEnvironmentDescriptor(state.value.origin);
      if (probed._tag !== "descriptor") {
        continue;
      }
      return {
        baseDir,
        variant,
        state: state.value,
        descriptor: probed.descriptor,
      } satisfies DiscoveredPairTarget;
    }
  }
  return yield* new NoRunningServerError({ checkedStatePaths });
});

/**
 * Server config pointed at the discovered server's state directory, so the
 * minted token lands in the database the running server reads from. Built by
 * hand rather than through `resolveServerConfig` to keep the dev-vs-userdata
 * choice pinned to where the runtime state was actually found, independent of
 * ambient environment variables.
 */
const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
}) {
  const { baseDir, variant, state } = input.target;
  // The state-dir variant does not imply dev-ness: a worktree dev server uses
  // an explicit home and therefore lands in `userdata`. The recorded devUrl is
  // what actually marks a dev server.
  const devUrl = state.devUrl !== undefined ? new URL(state.devUrl) : undefined;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    {},
  );
  return ServerConfig.make({
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: state.port,
    host: state.host,
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    resourceMonitorPath: undefined,
    logWebSocketEvents: false,
  });
});

const mintPairingLink = Effect.fn("pair.mintPairingLink")(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
}) {
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* environmentAuth.createPairingLink({
      scopes: input.scopes,
      subject: "one-time-token",
      label: Option.getOrElse(input.label, () => "t3 pair"),
      ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(input.config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, input.config.logLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Token TTL, for example `5m`, `1h`, or `15 minutes`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional label shown in the server's connections list."),
  Flag.optional,
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
}).pipe(
  Command.withDescription(
    "Mint a pairing token for a running T3 Code server and print it as a QR code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      // Default to Warn so storage/migration chatter cannot bury the QR code;
      // an explicit --log-level still wins.
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);

      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));

      const notes: Array<string> = [];
      const pairingBaseUrl = resolveDirectPairingBaseUrl(target.state);
      if (isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
        notes.push(
          "This URL is only reachable from this machine. Restart the server with a reachable --host, or use your configured public ingress URL with this token.",
        );
      }
      if (target.variant === "dev" && target.state.devUrl === undefined) {
        notes.push(
          "This dev server did not record its web URL; restart it so pairing can go through the web origin.",
        );
      }

      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* mintPairingLink({
        config,
        scopes: flags.scopes,
        ttl: flags.ttl,
        label: flags.label,
      });
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);

      yield* Console.log(
        formatPairOutput({
          serverLabel: target.descriptor.label,
          origin: target.state.origin,
          pairingUrl,
          token: issued.credential,
          expiresAt: issued.expiresAt,
          notes,
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
