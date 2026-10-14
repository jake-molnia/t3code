import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readConfiguration } from "./configuration.ts";

it.effect("allows an explicitly unconfigured gateway", () =>
  Effect.gen(function* () {
    expect(yield* readConfiguration({})).toBeUndefined();
  }),
);
it.effect("rejects partial configuration instead of selecting unmanaged accounts", () =>
  Effect.gen(function* () {
    for (const environment of [
      { T3_GATEWAY_API_KEY: "key" },
      { T3_GATEWAY_MANAGEMENT_URL: "http://localhost:8317", T3_GATEWAY_API_KEY: "key" },
      { T3_GATEWAY_MANAGEMENT_URL: "" },
      {
        T3_GATEWAY_MANAGEMENT_URL: "file:///tmp/socket",
        T3_GATEWAY_API_KEY: "key",
        T3_GATEWAY_MANAGEMENT_KEY: "management",
      },
    ]) {
      expect((yield* readConfiguration(environment).pipe(Effect.flip))._tag).toBe(
        "ModelGatewayConfigurationError",
      );
    }
  }),
);
it.effect("accepts complete configuration", () =>
  Effect.gen(function* () {
    expect(
      yield* readConfiguration({
        T3_GATEWAY_MANAGEMENT_URL: "http://localhost:8317",
        T3_GATEWAY_API_KEY: "key",
        T3_GATEWAY_MANAGEMENT_KEY: "management",
      }),
    ).toEqual({ url: "http://localhost:8317", apiKey: "key", managementKey: "management" });
  }),
);
