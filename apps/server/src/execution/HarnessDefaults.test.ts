import { describe, it, expect } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { harnessDefaults, sandboxPolicy, validateHarnessLaunch } from "./HarnessDefaults.ts";

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
      config: { binaryPath: "/opt/codex", setupMode: "managed" },
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
    expect(input.config.setupMode).toBe("managed");
  });
  it("rejects missing operator variables and incompatible model authentication", () => {
    const apply = harnessDefaults(
      JSON.stringify({
        codex: { environment: [{ name: "OPENAI_API_KEY", value: "${MISSING}", sensitive: true }] },
      }),
      { APERTURE_UPSTREAM: "http://aperture" },
    );
    expect(() => apply({ driver: ProviderDriverKind.make("codex") })).toThrow("requires MISSING");
    expect(() =>
      validateHarnessLaunch(
        { driver: ProviderDriverKind.make("cursor") },
        { APERTURE_UPSTREAM: "http://aperture" },
      ),
    ).toThrow("cannot use Aperture");
    expect(() =>
      validateHarnessLaunch(
        { driver: ProviderDriverKind.make("muse") },
        { APERTURE_UPSTREAM: "http://aperture" },
      ),
    ).toThrow("cannot use Aperture");
    expect(apply({ driver: ProviderDriverKind.make("cursor") }).driver).toBe("cursor");
    expect(apply({ driver: ProviderDriverKind.make("cursor"), enabled: false }).enabled).toBe(
      false,
    );
  });
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
