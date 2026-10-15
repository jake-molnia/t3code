import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function credentialPolicy(
  driver: C.ProviderDriverKind,
  config: unknown,
): { readonly kind: "controller" } | { readonly kind: "workspace" } {
  if (driver === "cursor" || driver === "antigravity") return { kind: "controller" };
  if (driver === "codex")
    return Schema.is(C.CodexSettings)(config) && config.setupMode === "managed"
      ? { kind: "controller" }
      : { kind: "workspace" };
  return { kind: "workspace" };
}

export function applyCredentialPolicy(
  snapshot: C.ServerProvider,
  policy: ReturnType<typeof credentialPolicy>,
): C.ServerProvider {
  if (policy.kind === "controller") return snapshot;
  return {
    ...snapshot,
    setup: { ...snapshot.setup, canAuthenticate: false },
    auth: {
      ...snapshot.auth,
      canLogout: false,
    },
  };
}
