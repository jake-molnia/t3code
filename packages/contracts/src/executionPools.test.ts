import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ExecutionPoolId, ExecutionPoolsSnapshot } from "./executionPools.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { WsRpcGroup, WS_METHODS } from "./rpc.ts";

const decode = Schema.decodeUnknownSync(ExecutionPoolsSnapshot);
const encode = Schema.encodeSync(ExecutionPoolsSnapshot);

describe("execution pool contracts", () => {
  it("round trips capacity and provider compatibility without backend credentials", () => {
    const snapshot = {
      defaultPoolId: ExecutionPoolId.make("gompers"),
      pools: [
        {
          id: ExecutionPoolId.make("gompers"),
          label: "Gompers",
          available: true,
          resources: {
            sampledAt: 123,
            cpuCount: 20,
            cpuUtilization: 0.25,
            totalMemoryBytes: 96000,
            availableMemoryBytes: 72000,
          },
          providerDrivers: [ProviderDriverKind.make("codex")],
        },
      ],
    };
    expect(decode(JSON.parse(JSON.stringify(encode(snapshot))))).toEqual(snapshot);
    expect(
      decode({
        ...snapshot,
        token: "private",
        pools: [{ ...snapshot.pools[0], endpoint: "private", token: "private" }],
      }),
    ).toEqual(snapshot);
    expect(WsRpcGroup.requests.has(WS_METHODS.serverExecutionPools)).toBe(true);
  });
  it("supports unavailable pools while rejecting invalid capacity and empty IDs", () => {
    const unavailable = {
      defaultPoolId: "portal",
      pools: [
        { id: "portal", label: "Portal", available: false, resources: null, providerDrivers: [] },
      ],
    };
    expect(decode(unavailable)).toEqual(unavailable);
    expect(() => decode({ ...unavailable, defaultPoolId: "" })).toThrow();
    expect(() =>
      decode({
        ...unavailable,
        pools: [
          {
            ...unavailable.pools[0],
            resources: {
              sampledAt: 123,
              cpuCount: -1,
              cpuUtilization: 2,
              totalMemoryBytes: 1,
              availableMemoryBytes: 1,
            },
          },
        ],
      }),
    ).toThrow();
  });
});
