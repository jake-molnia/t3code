import { describe, it, expect } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { harnessDefaults, sandboxPolicy } from "./HarnessDefaults.ts";

describe("sandbox harness defaults", () => {
  it("resolves operator credentials privately and preserves native instance settings", () => {
    const apply = harnessDefaults(
      JSON.stringify({
        codex: {
          config: { setupMode: "existing", launchArgs: "${APERTURE_UPSTREAM}/v1" },
          environment: [{ name: "OPENAI_API_KEY", value: "${APERTURE_API_KEY}", sensitive: true }],
        },
      }),
      { APERTURE_UPSTREAM: "http://aperture", APERTURE_API_KEY: "private" },
    );
    const input = {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "/opt/codex", setupMode: "existing" },
    };
    const result = apply(input);
    expect(result.config).toEqual({
      binaryPath: "/opt/codex",
      setupMode: "existing",
      launchArgs: "http://aperture/v1",
    });
    expect(result.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "private", sensitive: true },
    ]);
    expect(input.config.setupMode).toBe("existing");
  });
  it("rejects missing operator variables without blocking native account providers", () => {
    const apply = harnessDefaults(
      JSON.stringify({
        codex: { environment: [{ name: "OPENAI_API_KEY", value: "${MISSING}", sensitive: true }] },
      }),
      { APERTURE_UPSTREAM: "http://aperture" },
    );
    expect(() => apply({ driver: ProviderDriverKind.make("codex") })).toThrow("requires MISSING");
    expect(apply({ driver: ProviderDriverKind.make("cursor") }).driver).toBe("cursor");
    expect(apply({ driver: ProviderDriverKind.make("cursor"), enabled: false }).enabled).toBe(
      false,
    );
  });
  it("keeps native account configuration ahead of optional operator defaults", () => {
    const apply = harnessDefaults(
      JSON.stringify({
        codex: {
          config: { setupMode: "${UNUSED_MODE}", binaryPath: "codex" },
          environment: [{ name: "OPENAI_API_KEY", value: "${UNUSED_SECRET}", sensitive: true }],
        },
      }),
      {},
    );
    const native = {
      driver: ProviderDriverKind.make("codex"),
      config: { setupMode: "managed" },
      environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true }],
    };
    expect(apply(native)).toEqual({
      ...native,
      config: { setupMode: "managed", binaryPath: "codex" },
    });
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "pi", "muse"])(
    "preserves %s native settings with Aperture present but no operator manifest",
    (driver) => {
      const instance = {
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        config: { customModels: [{ id: "account-model" }] },
        environment: [{ name: "ACCOUNT_CREDENTIAL", value: "private", sensitive: true }],
      };
      expect(
        harnessDefaults(undefined, { APERTURE_UPSTREAM: "http://unreachable.invalid" })(instance),
      ).toBe(instance);
    },
  );
  it("enforces full access without changing plan mode or cwd", () => {
    expect(
      sandboxPolicy({
        runtimeMode: "approval-required",
        interactionMode: "plan",
        cwd: "/workspace",
        approvalPolicy: "always",
        sandboxPolicy: { readOnly: true },
      }),
    ).toEqual({ runtimeMode: "full-access", interactionMode: "plan", cwd: "/workspace" });
  });
});
