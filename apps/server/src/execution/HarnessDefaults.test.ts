import { describe, it, expect } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { harnessDefaults, sandboxPolicy, validateHarnessLaunch } from "./HarnessDefaults.ts";

describe("sandbox harness defaults", () => {
  it("resolves operator credentials privately and preserves native instance settings", () => {
    const apply = harnessDefaults(
      JSON.stringify({
        codex: {
          config: { setupMode: "existing", launchArgs: "${T3_GATEWAY_URL}/v1" },
          environment: [
            { name: "OPENAI_API_KEY", value: "${T3_GATEWAY_API_KEY}", sensitive: true },
          ],
        },
      }),
      { T3_GATEWAY_URL: "http://gateway", T3_GATEWAY_API_KEY: "private" },
    );
    const input = {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "/opt/codex", setupMode: "managed" },
    };
    const result = apply(input);
    expect(result.config).toEqual({
      binaryPath: "/opt/codex",
      setupMode: "existing",
      launchArgs: "http://gateway/v1",
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
      { T3_GATEWAY_URL: "http://gateway" },
    );
    expect(() => apply({ driver: ProviderDriverKind.make("codex") })).toThrow("requires MISSING");
    expect(() =>
      validateHarnessLaunch(
        { driver: ProviderDriverKind.make("cursor") },
        { T3_GATEWAY_URL: "http://gateway" },
      ),
    ).toThrow("cannot use model gateway");
    expect(() =>
      validateHarnessLaunch(
        { driver: ProviderDriverKind.make("muse") },
        { T3_GATEWAY_URL: "http://gateway" },
      ),
    ).toThrow("cannot use model gateway");
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
