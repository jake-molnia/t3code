import * as Schema from "effect/Schema";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { describe, it, expect, afterEach, vi } from "@effect/vitest";
import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import {
  harnessDefaults,
  gatewayRouting,
  sandboxPolicy,
  validateHarnessLaunch,
  deploymentHarnessDefaults,
} from "./HarnessDefaults.ts";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

afterEach(() => vi.unstubAllEnvs());

describe("sandbox harness defaults", () => {
  it("refuses missing model-access configuration in the shipped worker", () => {
    vi.stubEnv("T3_HARNESS_DEFAULTS_FILE", "");
    vi.stubEnv("T3_GATEWAY_HARNESS_CONFIG_FILE", "");
    vi.stubEnv("T3_GATEWAY_URL", "");
    const instance = { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } };
    expect(deploymentHarnessDefaults()(instance)).toBe(instance);
    vi.stubEnv("T3_GATEWAY_HARNESS_CONFIG_FILE", "/opt/t3/gateway-harnesses.json");
    expect(() => deploymentHarnessDefaults()).toThrow("Model access requires");
    vi.stubEnv("T3_GATEWAY_URL", "http://gateway");
    vi.stubEnv("T3_GATEWAY_API_KEY", "");
    expect(() => deploymentHarnessDefaults()).toThrow("Model access requires");
  });
  it("preserves execution options while giving the gateway ownership of model access", () => {
    const apply = gatewayRouting(
      JSON.stringify({
        codex: {
          config: { setupMode: "existing", launchArgs: "${T3_GATEWAY_URL}/v1" },
          environment: [
            { name: "OPENAI_API_KEY", value: "${T3_GATEWAY_API_KEY}", sensitive: true },
          ],
        },
      }),
      { T3_GATEWAY_URL: "http://gateway", T3_GATEWAY_API_KEY: "gateway-key" },
    );
    const instance = {
      driver: ProviderDriverKind.make("codex"),
      config: { setupMode: "managed", launchArgs: "native-route", binaryPath: "/native/codex" },
      environment: [
        { name: "OPENAI_API_KEY", value: "native-key", sensitive: true },
        { name: "CUSTOM", value: "kept", sensitive: false },
      ],
    };
    expect(apply(instance)).toEqual({
      ...instance,
      config: {
        setupMode: "existing",
        launchArgs: "native-route http://gateway/v1",
        binaryPath: "/native/codex",
      },
      environment: [
        { name: "OPENAI_API_KEY", value: "gateway-key", sensitive: true },
        { name: "CUSTOM", value: "kept", sensitive: false },
        { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false },
      ],
    });
    expect(apply({ ...instance, enabled: false })).toEqual({ ...instance, enabled: false });
  });
  it("does not let native account tokens override gateway credentials", () => {
    const apply = gatewayRouting(
      JSON.stringify({
        claudeAgent: {
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "${T3_GATEWAY_API_KEY}", sensitive: true },
          ],
        },
      }),
      { T3_GATEWAY_API_KEY: "gateway-key" },
    );
    const instance = {
      driver: ProviderDriverKind.make("claudeAgent"),
      config: { autoCompactWindow: "250000", binaryPath: "/tools/claude" },
      environment: [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "native-account", sensitive: true },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "other-account", sensitive: true },
        { name: "CLAUDE_CODE_USE_VERTEX", value: "1", sensitive: false },
        { name: "BUILD_MODE", value: "debug", sensitive: false },
      ],
    };
    expect(apply(instance)).toEqual({
      ...instance,
      environment: [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: true },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true },
        { name: "CLAUDE_CODE_USE_VERTEX", value: "0", sensitive: false },
        { name: "BUILD_MODE", value: "debug", sensitive: false },
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "0", sensitive: false },
        { name: "CLAUDE_CODE_USE_FOUNDRY", value: "0", sensitive: false },
        { name: "ANTHROPIC_API_KEY", value: "gateway-key", sensitive: true },
      ],
    });
    expect(instance.environment).toHaveLength(4);
  });
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
      config: { binaryPath: "/opt/codex", setupMode: "existing" },
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
    expect(input.config.setupMode).toBe("existing");
  });
  it("rejects missing operator variables without blocking native account providers", () => {
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
    "preserves %s native settings without an operator manifest",
    (driver) => {
      const instance = {
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        config: { customModels: [{ id: "account-model" }] },
        environment: [{ name: "ACCOUNT_CREDENTIAL", value: "private", sensitive: true }],
      };
      expect(harnessDefaults(undefined, {})(instance)).toBe(instance);
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

it.each(["instance", "inherited"])(
  "Codex %s launch arguments cannot discard gateway routing",
  (source) => {
    const environment = { T3CODE_CODEX_LAUNCH_ARGS: "--enable execution-feature" };
    const apply = gatewayRouting(
      JSON.stringify({
        codex: {
          config: {
            setupMode: "existing",
            launchArgs: "-c model_provider=gateway",
          },
        },
      }),
      environment,
    );
    const next = apply({
      driver: ProviderDriverKind.make("codex"),
      config: { launchArgs: "--enable configured-feature" },
      ...(source === "instance"
        ? {
            environment: [
              {
                name: "T3CODE_CODEX_LAUNCH_ARGS",
                value: "--enable instance-feature",
                sensitive: false,
              },
            ],
          }
        : {}),
    });
    const config = decodeCodexSettings(next.config);
    const resolved = resolveCodexLaunchArgs(config.launchArgs, {
      ...environment,
      ...Object.fromEntries(next.environment?.map((entry) => [entry.name, entry.value]) ?? []),
    });
    expect(resolved).toBe(
      `${source === "instance" ? "--enable instance-feature" : "--enable execution-feature"} -c model_provider=gateway`,
    );
  },
);

it("gateway routing retains native Pi and OpenCode configuration locations", () => {
  const route = gatewayRouting(
    JSON.stringify({
      pi: {
        environment: [{ name: "PI_CODING_AGENT_DIR", value: "/generated/pi", sensitive: false }],
      },
      opencode: {
        environment: [
          { name: "OPENCODE_CONFIG", value: "/generated/opencode.json", sensitive: false },
        ],
      },
    }),
  );
  for (const [driver, name, value] of [
    ["pi", "PI_CODING_AGENT_DIR", "/native/pi"],
    ["opencode", "OPENCODE_CONFIG", "/native/custom.jsonc"],
  ] as const) {
    const instance = {
      driver: ProviderDriverKind.make(driver),
      environment: [{ name, value, sensitive: false }],
    };
    expect(route(instance).environment).toEqual(instance.environment);
  }
});
