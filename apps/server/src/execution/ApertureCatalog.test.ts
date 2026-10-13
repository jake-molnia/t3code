import { expect, test } from "@effect/vitest";
import {
  nativeApertureConfigs,
  managedApertureCatalog,
  filterApertureSnapshot,
  setApertureCatalog,
} from "./ApertureCatalog.ts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";

test("native configs preserve endpoint compatibility and reference credentials instead of copying them", () => {
  const result = nativeApertureConfigs(
    {
      data: [
        {
          id: "responses-only",
          supported_endpoints: ["/v1/responses"],
          context_window_tokens: 100000,
          max_output_tokens: 4096,
        },
        { id: "chat-only", supported_endpoints: ["/v1/chat/completions"] },
        { id: "claude", supported_endpoints: ["/v1/messages"] },
      ],
    },
    "http://aperture",
  );
  expect(Object.keys(result.opencode.providers.aperture!.models)).toEqual(["responses-only"]);
  expect(Object.keys(result.opencode.providers["aperture-chat"]!.models)).toEqual(["chat-only"]);
  expect(result.opencode.providers.aperture!.package).toBe(
    "@opencode/ai/providers/openai/responses",
  );
  expect(result.opencode.providers.aperture!.settings.apiKey).toBe("{env:APERTURE_API_KEY}");
  expect(result.pi.providers["aperture-anthropic"]!.api).toBe("anthropic-messages");
  expect(result.pi.providers.aperture!.apiKey).toBe("${APERTURE_API_KEY}");
});

test("subscription routes requiring personal credentials are not advertised as managed Aperture models", () => {
  expect(
    managedApertureCatalog({
      data: [
        {
          id: "managed",
          supported_endpoints: ["/v1/responses"],
          metadata: { provider: { requires_client_auth: false } },
        },
        {
          id: "personal",
          supported_endpoints: ["/v1/messages"],
          metadata: { provider: { requires_client_auth: true } },
        },
      ],
    }).data.map((model) => model.id),
  ).toEqual(["managed"]);
});

test("managed OpenCode snapshots advertise only compatible Aperture routes", () => {
  const snapshot = {
    ...buildServerProvider({
      presentation: { displayName: "OpenCode" },
      enabled: true,
      checkedAt: "2026-10-10T00:00:00Z",
      probe: {
        installed: true,
        version: "2.0.26",
        status: "ready",
        auth: { status: "authenticated" },
      },
      models: [
        "opencode/big-pickle",
        "aperture/responses-only",
        "aperture-chat/chat-only",
        "aperture-chat/responses-only",
      ].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }),
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
  };
  expect(filterApertureSnapshot(snapshot)).toEqual(snapshot);
  setApertureCatalog({
    data: [
      { id: "responses-only", supported_endpoints: ["/v1/responses"] },
      { id: "chat-only", supported_endpoints: ["/v1/chat/completions"] },
    ],
  });
  expect(filterApertureSnapshot(snapshot).models.map((model) => model.slug)).toEqual([
    "aperture/responses-only",
    "aperture-chat/chat-only",
  ]);
});
