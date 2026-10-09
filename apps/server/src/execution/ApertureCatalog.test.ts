import { expect, test } from "@effect/vitest";
import { nativeApertureConfigs, managedApertureCatalog } from "./ApertureCatalog.ts";

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
