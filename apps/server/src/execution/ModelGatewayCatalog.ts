// @effect-diagnostics nodeBuiltinImport:off -- Worker-owned native harness configuration boundary.
// @effect-diagnostics globalFetch:off -- Worker inference catalog transport, bounded and scoped per worker.
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import { lock } from "proper-lockfile";
import type { ModelSelection, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { migrateGatewayModelId, migrateGatewayModelSelection } from "./GatewayMigration.ts";

// The pinned proxy patch preserves known input modalities alongside model identities.
export const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      owned_by: Schema.optionalKey(Schema.String),
      supported_input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type Catalog = typeof Catalog.Type;
const decodeCatalog = Schema.decodeUnknownSync(Catalog);
export type GatewayCatalogState =
  | { readonly kind: "disabled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly catalog: Catalog };

const supported = new Set(["codex", "claudeAgent", "grok", "opencode", "pi"]);
function gatewayModelSlug(driver: string, id: string) {
  return driver === "opencode" || driver === "pi" ? `gateway/${id}` : id;
}

function gatewayUnavailableReason(state: GatewayCatalogState, driver: string) {
  if (state.kind === "disabled") return undefined;
  if (!supported.has(driver)) return `${driver} does not support model gateway credentials.`;
  if (state.kind === "unavailable")
    return "The model gateway is unavailable. Reconnect before starting a turn.";
  if (state.catalog.data.length === 0)
    return "Connect an account in Settings to make models available.";
  return undefined;
}

export function projectGatewaySnapshot(
  snapshot: ServerProvider,
  state: GatewayCatalogState,
): ServerProvider {
  if (state.kind === "disabled") return snapshot;
  const reason = gatewayUnavailableReason(state, snapshot.driver);
  const setup = { ...snapshot.setup, canAuthenticate: false };
  if (reason || state.kind !== "ready")
    return {
      ...snapshot,
      setup,
      models: [],
      modelsComplete: true,
      updateRequiredModels: [],
      availability: "unavailable",
      unavailableReason: reason ?? "The model gateway is unavailable.",
    };
  const native = new Map(snapshot.models.map((model) => [model.slug, model]));
  const models = state.catalog.data.map((model): ServerProviderModel => {
    const slug = gatewayModelSlug(snapshot.driver, model.id);
    const existing = native.get(slug);
    return existing
      ? { ...existing, isCustom: false }
      : {
          slug,
          name: model.id,
          isCustom: false,
          capabilities: null,
          ...(snapshot.driver === "pi" || snapshot.driver === "opencode"
            ? { subProvider: "gateway" }
            : {}),
        };
  });
  const nativeAuthWarning =
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.status === "warning" &&
    snapshot.auth.status === "unauthenticated" &&
    snapshot.compatibilityAdvisory?.status !== "unsupported" &&
    snapshot.compatibilityAdvisory?.status !== "broken";
  return {
    ...snapshot,
    ...(nativeAuthWarning ? { status: "ready", message: undefined } : {}),
    auth: { status: "authenticated", type: "apiKey", label: "Model gateway", canLogout: false },
    setup,
    models,
    modelsComplete: true,
    updateRequiredModels: [],
  };
}

/** One protocol group keeps every model selectable without duplicate protocol variants. */
const openCodeInputModalities = (model: Catalog["data"][number]) => {
  const supported = new Set(["text", "image", "audio", "video", "pdf"]);
  const known = [
    ...new Set(
      model.supported_input_modalities
        ?.map((value) => value.toLowerCase())
        .filter((value) => supported.has(value)),
    ),
  ];
  return known.length > 0 ? known : ["text"];
};

export function nativeGatewayConfigs(catalog: Catalog, upstream: string) {
  return {
    opencode: {
      providers: {
        gateway: {
          package: "@opencode/ai/providers/openai/responses",
          env: ["T3_GATEWAY_API_KEY"],
          settings: { baseURL: `${upstream}/v1`, apiKey: "{env:T3_GATEWAY_API_KEY}" },
          models: Object.fromEntries(
            catalog.data.map((model) => [
              model.id,
              {
                name: model.id,
                capabilities: {
                  tools: true,
                  input: openCodeInputModalities(model),
                  output: ["text"],
                },
              },
            ]),
          ),
        },
      },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      experimental: { portable_shell_scanner: false, policies: [] },
    },
    pi: {
      providers: {
        gateway: {
          baseUrl: `${upstream}/v1`,
          api: "openai-responses",
          apiKey: "${T3_GATEWAY_API_KEY}",
          models: catalog.data.map((model) => ({
            id: model.id,
            name: model.id,
            input: openCodeInputModalities(model).filter(
              (modality) => modality === "text" || modality === "image",
            ),
          })),
        },
      },
    },
  };
}

const decodePiRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

async function readPiRecord(path: string) {
  let text: string;
  try {
    text = await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error(
      "Pi state could not be read. Repair the retained Pi configuration before retrying.",
      { cause: error },
    );
  }
  const decoded = decodePiRecord(text);
  if (decoded._tag === "None")
    throw new Error("Pi state is invalid. Repair the retained Pi configuration before retrying.");
  return decoded.value;
}

/** Share Pi's own file lock so gateway credential repair cannot overwrite another account's login. */
async function reconcilePiAccess(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/auth.json`;
  const release = await lock(path, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
  });
  try {
    const saved = await readPiRecord(path);
    const gateway = { type: "api_key", key: "${T3_GATEWAY_API_KEY}" };
    if (JSON.stringify(saved.gateway) !== JSON.stringify(gateway)) {
      await NodeFSP.writeFile(`${path}.tmp`, JSON.stringify({ ...saved, gateway }, null, 2), {
        mode: 0o600,
      });
      await NodeFSP.rename(`${path}.tmp`, path);
    }
  } finally {
    await release();
  }
  const settings = await readPiRecord(`${directory}/settings.json`);
  return typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
}

/** Each worker owns its catalog and files; no catalog is shared between workspaces. */
export function createModelGatewayCatalog(options: {
  directory: string;
  environment?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}) {
  const environment = options.environment ?? process.env;
  const base = environment.T3_GATEWAY_URL?.replace(/\/$/, "");
  const request = options.request ?? fetch;
  if (base) {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid model gateway URL");
    if (!environment.T3_GATEWAY_API_KEY)
      throw new Error("Model gateway requires T3_GATEWAY_API_KEY");
  }
  let state: GatewayCatalogState = base ? { kind: "unavailable" } : { kind: "disabled" };
  let pending: Promise<GatewayCatalogState> | undefined;
  let written: string | undefined;
  let piDefaultModel: string | undefined;
  const normalizeSelection = (driver: string, selection: ModelSelection) => {
    if (!base) return selection;
    if (driver === "pi" && selection.model === "default" && piDefaultModel)
      return { ...selection, model: gatewayModelSlug(driver, piDefaultModel) };
    return migrateGatewayModelSelection(driver, selection);
  };
  const refresh = async (): Promise<GatewayCatalogState> => {
    if (!base) return state;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await request(`${base}/v1/models`, {
          headers: { Authorization: `Bearer ${environment.T3_GATEWAY_API_KEY}` },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Model gateway catalog unavailable");
        const decoded = decodeCatalog(await response.json());
        const catalog = {
          data: [...new Map(decoded.data.map((model) => [model.id, model])).values()],
        };
        const serialized = JSON.stringify(catalog);
        if (serialized !== written) {
          const configs = nativeGatewayConfigs(catalog, base);
          await NodeFSP.mkdir(`${options.directory}/pi`, { recursive: true, mode: 0o700 });
          for (const [path, value] of [
            [`${options.directory}/pi/models.json`, configs.pi],
            [`${options.directory}/opencode2.json`, configs.opencode],
          ] as const) {
            await NodeFSP.writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
            await NodeFSP.rename(`${path}.tmp`, path);
          }
          written = serialized;
        }
        state = { kind: "ready", catalog };
      } catch {
        // Do not retain a ready catalog after an outage or malformed response.
        state = { kind: "unavailable" };
      }
      return state;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
  return {
    refresh,
    requiresSessionRestart: (driver: string) => Boolean(base) && driver === "pi",
    normalizeSelection,
    snapshot: (snapshot: ServerProvider) => projectGatewaySnapshot(snapshot, state),
    async prepareInference(driver: string, model?: string) {
      const next = await refresh();
      const reason = gatewayUnavailableReason(next, driver);
      if (reason) throw new Error(reason);
      if (next.kind === "ready" && driver === "pi") {
        const preferred = await reconcilePiAccess(`${options.directory}/pi`);
        piDefaultModel =
          next.catalog.data.find((entry) => entry.id === preferred)?.id ??
          next.catalog.data.find((entry) => entry.id === piDefaultModel)?.id ??
          next.catalog.data[0]?.id;
      }
      const requested =
        model === undefined
          ? undefined
          : driver === "pi" && model === "default"
            ? piDefaultModel && gatewayModelSlug(driver, piDefaultModel)
            : migrateGatewayModelId(driver, model);
      if (
        next.kind === "ready" &&
        requested &&
        !next.catalog.data.some((entry) => gatewayModelSlug(driver, entry.id) === requested)
      )
        throw new Error(
          "The selected model is no longer available. Select a model from a connected account.",
        );
    },
  };
}
