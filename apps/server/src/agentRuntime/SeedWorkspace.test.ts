import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createExecutionClient, ExecutionOperationError } from "../execution/ExecutionClient.ts";
import { inspectSeedDestination, seedWorkspace, SeedWorkspaceError } from "./SeedWorkspace.ts";

const identity = {
  workspaceId: "seed-diagnostics",
  generation: 1,
  allocationId: "allocation",
  podUid: "pod",
  incarnation: "incarnation",
  protocolVersion: 1,
} as const;
const replies: Record<string, unknown> = {
  "git.isRepository": false,
  "git.captureCheckpoint": null,
  "git.bundleFork": {
    bundlePath: "/tmp/seed.bundle",
    checkpointRef: "refs/t3/seeds/root",
    checkpointOid: "a".repeat(40),
    baseCommit: null,
    branch: "main",
    origin: null,
  },
  "asset.snapshot": { blobId: "b".repeat(64), size: 0, name: "seed.bundle" },
  "git.cleanupFork": null,
  "asset.read": { data: "", offset: 0, size: 0 },
  "asset.stage": { complete: true, path: "/tmp/staged" },
};

it.each([
  ["git.isRepository", "destination.inspect"],
  ["git.captureCheckpoint", "source.checkpoint"],
  ["git.bundleFork", "source.bundle"],
  ["asset.snapshot", "source.snapshot"],
  ["asset.read", "source.read"],
  ["asset.stage", "destination.stage"],
  ["git.importFork", "destination.import"],
])("retains the failed %s boundary and worker code", async (failedMethod, operation) => {
  const client = createExecutionClient({
    identity,
    token: "local-test-token",
    endpoint: "http://seed.invalid",
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (
        typeof body !== "object" ||
        body === null ||
        !("method" in body) ||
        typeof body.method !== "string"
      )
        throw new Error("Missing test operation");
      return Response.json(
        body.method === failedMethod
          ? { ok: false, code: "worker_not_admitting" }
          : { ok: true, value: replies[body.method] ?? null },
        { status: body.method === failedMethod ? 409 : 200 },
      );
    },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      seedWorkspace({
        source: client,
        destination: client,
        sourceCwd: "source",
        destinationCwd: "destination",
        key: "root",
      }),
    ),
  );
  expect(error).toBeInstanceOf(SeedWorkspaceError);
  expect(error).toMatchObject({ operation, code: "worker_not_admitting" });
  expect(error.message).toBe(`Project seed ${operation} failed (worker_not_admitting)`);
});

it("keeps transport classification without exposing rejected messages", async () => {
  const secret = "sensitive-provider-stderr";
  const client = createExecutionClient({
    identity,
    token: "local-test-token",
    endpoint: "http://seed.invalid",
    fetch: async () => {
      throw new Error(secret);
    },
  });
  const error = await Effect.runPromise(Effect.flip(inspectSeedDestination(client, "destination")));
  expect(error).toMatchObject({ operation: "destination.inspect", code: "unavailable" });
  expect(error.message).not.toContain(secret);
});

it("retains the original rejection for diagnostics but displays only safe codes", async () => {
  const cause = new ExecutionOperationError("secret value in invalid code");
  const error = await Effect.runPromise(
    Effect.flip(
      inspectSeedDestination(
        {
          call: async () => {
            throw cause;
          },
        },
        "destination",
      ),
    ),
  );
  expect(error).toMatchObject({ operation: "destination.inspect", code: "request_failed", cause });
  expect(error.message).not.toContain(cause.code);
});
