import {
  AuthProvidersManageScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  resolveProjectProviderInstanceEnabled,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceOverridePatch,
  resolveProjectProviderEnablement,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("provider environment selection", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: true,
      }),
    ).toBe(true);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "reconnecting",
        hasServerConfig: true,
      }),
    ).toBe(false);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: false,
      }),
    ).toBe(false);
  });

  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildProviderEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildProviderEnvironmentOptions(environments, primaryId);

    expect(resolveSelectedProviderEnvironmentId(options, sshId, primaryId)).toBe(sshId);
    expect(
      resolveSelectedProviderEnvironmentId(
        options.filter((environment) => environment.environmentId !== sshId),
        sshId,
        primaryId,
      ),
    ).toBe(primaryId);
    expect(resolveSelectedProviderEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(
      relayId,
    );
    expect(resolveSelectedProviderEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("provider environment access", () => {
  it("allows connected environments with config and operate access", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "editable" });
  });

  it("waits for config before exposing controls", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "loading", reason: "config" });
  });

  it("waits for unresolved operate access instead of assuming it is editable", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "pending",
      }),
    ).toEqual({ kind: "loading", reason: "permissions" });
  });

  it("represents known missing operate access as read only", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "denied",
      }),
    ).toEqual({ kind: "read-only" });
  });

  it.each(["available", "offline", "connecting", "reconnecting"] as const)(
    "keeps %s environments unavailable",
    (connectionPhase) => {
      expect(
        classifyProviderEnvironmentAccess({
          connectionPhase,
          hasServerConfig: true,
          operateAccess: "granted",
        }),
      ).toEqual({ kind: "unavailable" });
    },
  );

  it("separates connection errors from other unavailable states", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "error",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("primary operate access", () => {
  const authenticated = {
    authenticated: true as const,
    scopes: [AuthProvidersManageScope],
  };

  it("keeps cached session data authoritative while SWR revalidates", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: authenticated,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("reports pending only before any session has resolved", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });

  it("denies writes when the session fetch fails", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("denied");
  });

  it("denies unauthenticated sessions and sessions without the operate scope", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("waits for explicit grants on desktop and remote environments", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });
});

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");
  const otherInstanceId = ProviderInstanceId.make("claudeAgent_personal");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId, siblingId], instanceId, false),
    ).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      [siblingId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [instanceId]: { enabled: false } },
      },
    });
  });

  it("sets an override when the project has none yet", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {},
    };

    expect(buildProviderInstanceOverridePatch(settings, [projectId], instanceId, true)).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
    });
  });

  it("adds an instance override alongside the project's other overrides", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [otherInstanceId]: { enabled: false } },
        },
      },
    };

    expect(buildProviderInstanceOverridePatch(settings, [projectId], instanceId, true)).toEqual({
      [projectId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: {
          [otherInstanceId]: { enabled: false },
          [instanceId]: { enabled: true },
        },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("resets one instance while another instance's override and other keys survive", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: {
            [instanceId]: { enabled: true },
            [otherInstanceId]: { enabled: false },
          },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [otherInstanceId]: { enabled: false } },
      },
    });
  });

  it("sends providerInstances: {} explicitly when clearing the last instance override leaves other keys", () => {
    // The server keeps a stored providerInstances map when an incoming entry
    // omits the key (so older clients cannot wipe it by editing another
    // setting). This clear must say so explicitly, or the server would put
    // the just-cleared override right back.
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: true } },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
    });
  });
});

describe("remote operate access", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveRemoteOperateAccess({
        session: {
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("reports pending before the first session resolve, then keeps cached data", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("denies writes when the session fetch fails or scopes are missing", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "denied",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});

describe("saved project harness policy", () => {
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "enables, disables and re-enables %s without changing accounts or another project",
    (kind) => {
      const projectId = ProjectId.make("chosen");
      const otherProjectId = ProjectId.make("other");
      const instanceId = ProviderInstanceId.make(kind);
      const instance = {
        driver: ProviderDriverKind.make(kind),
        enabled: false,
        config: { enabled: false, customModels: ["saved-model"] },
        environment: [{ name: "API_KEY", value: "saved-secret", sensitive: true }],
      };
      const before: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: instance },
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true },
          [otherProjectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      let saved = before;
      for (const enabled of [true, false, true]) {
        saved = applyServerSettingsPatch(saved, {
          projectSettingsOverrides: buildProviderInstanceOverridePatch(
            saved,
            [projectId],
            instanceId,
            enabled,
          ),
        });
        expect(resolveProjectProviderInstanceEnabled(saved, projectId, instanceId)).toBe(enabled);
        expect(resolveProjectProviderInstanceEnabled(saved, otherProjectId, instanceId)).toBe(
          false,
        );
        expect(saved.providerInstances).toEqual(before.providerInstances);
        expect(saved.textGenerationModelSelection).toEqual(before.textGenerationModelSelection);
        expect(saved.projectSettingsOverrides[projectId]?.defaultAutoPull).toBe(true);
      }
    },
  );
});

it("bulk toggles native Antigravity with mixed projects without a global enable gate", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const first = ProjectId.make("first");
  const second = ProjectId.make("second");
  const future = ProjectId.make("future");
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: false,
        config: { enabled: false, customModels: ["saved-model"] },
        environment: [{ name: "NATIVE_ACCOUNT", value: "saved-account", sensitive: true }],
      },
    },
    projectSettingsOverrides: {
      [first]: { providerInstances: { [instanceId]: { enabled: true } } },
      [second]: { defaultAutoPull: true, providerInstances: { [instanceId]: { enabled: false } } },
    },
  };
  const ids = [first, second];
  expect(resolveProjectProviderEnablement(settings, ids, instanceId)).toEqual({
    effectiveEnabled: false,
    mixed: true,
  });
  expect(resolveProjectProviderEnablement(settings, [], instanceId)).toBeUndefined();
  let saved = settings;
  for (const enabled of [true, false, true]) {
    saved = applyServerSettingsPatch(saved, {
      projectSettingsOverrides: buildProviderInstanceOverridePatch(saved, ids, instanceId, enabled),
    });
    expect(resolveProjectProviderEnablement(saved, ids, instanceId)).toEqual({
      effectiveEnabled: enabled,
      mixed: false,
    });
    expect(ids.map((id) => resolveProjectProviderInstanceEnabled(saved, id, instanceId))).toEqual([
      enabled,
      enabled,
    ]);
    expect(resolveProjectProviderInstanceEnabled(saved, future, instanceId)).toBe(false);
    expect(saved.providerInstances).toEqual(settings.providerInstances);
    expect(saved.textGenerationModelSelection).toEqual(settings.textGenerationModelSelection);
    expect(saved.projectSettingsOverrides[second]?.defaultAutoPull).toBe(true);
  }
});
