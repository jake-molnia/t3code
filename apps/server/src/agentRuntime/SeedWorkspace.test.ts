import { CheckpointRef, WORKSPACE_SEED_STAGE_ORDER } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Assets from "./worker/AssetProtocol.ts";
import * as Fork from "../execution/ForkWorkspaceProtocol.ts";
import { createExecutionClient, ExecutionOperationError } from "../execution/ExecutionClient.ts";
import {
  inspectSeedDestination,
  seedWorkspace,
  transferForkBundle,
  SeedWorkspaceError,
} from "./SeedWorkspace.ts";

const decodeRead = Schema.decodeUnknownSync(Assets.Read);
const decodeStage = Schema.decodeUnknownSync(Assets.Stage);

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

it.effect.each([
  ["git.isRepository", "destination.inspect"],
  ["git.captureCheckpoint", "source.checkpoint"],
  ["git.bundleFork", "source.bundle"],
  ["asset.snapshot", "source.snapshot"],
  ["asset.read", "source.read"],
  ["asset.stage", "destination.stage"],
  ["git.importFork", "destination.import"],
])("retains the failed %s boundary and worker code", ([failedMethod, operation]) =>
  Effect.gen(function* () {
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
    const error = yield* Effect.flip(
      seedWorkspace({
        source: Effect.succeed(client),
        destination: client,
        sourceCwd: "source",
        destinationCwd: "destination",
        key: "root",
      }),
    );
    expect(error).toBeInstanceOf(SeedWorkspaceError);
    expect(error).toMatchObject({ operation, code: "worker_not_admitting" });
    expect(error.message).toBe(`Project seed ${operation} failed (worker_not_admitting)`);
  }),
);

it.effect("keeps transport classification without exposing rejected messages", () =>
  Effect.gen(function* () {
    const secret = "sensitive-provider-stderr";
    const client = createExecutionClient({
      identity,
      token: "local-test-token",
      endpoint: "http://seed.invalid",
      fetch: async () => {
        throw new Error(secret);
      },
    });
    const error = yield* Effect.flip(inspectSeedDestination(client, "destination"));
    expect(error).toMatchObject({ operation: "destination.inspect", code: "unavailable" });
    expect(error.message).not.toContain(secret);
  }),
);

it.effect("retains the original rejection for diagnostics but displays only safe codes", () =>
  Effect.gen(function* () {
    const cause = new ExecutionOperationError("secret value in invalid code");
    const error = yield* Effect.flip(
      inspectSeedDestination(
        {
          call: async () => {
            throw cause;
          },
        },
        "destination",
      ),
    );
    expect(error).toMatchObject({
      operation: "destination.inspect",
      code: "request_failed",
      cause,
    });
    expect(error.message).not.toContain(cause.code);
  }),
);

it.effect("rejects an LFS object whose transferred content digest differs from its pointer", () =>
  Effect.gen(function* () {
    let staged = 0;
    const error = yield* Effect.flip(
      transferForkBundle({
        source: {
          call: async (method) =>
            method === "asset.snapshot" ? { blobId: "b".repeat(64), size: 0, name: "blob" } : null,
          transient: async () => ({ data: "", offset: 0, size: 0 }),
        },
        destination: {
          call: async () => null,
          transient: async () => {
            staged++;
            return { complete: true, path: "/staged" };
          },
        },
        bundle: {
          bundlePath: "/bundle",
          checkpointRef: CheckpointRef.make("refs/t3/seeds/test"),
          checkpointOid: "a".repeat(40),
          baseCommit: null,
          branch: null,
          origin: null,
          lfsObjects: [{ oid: "c".repeat(64), path: "/local-lfs-object" }],
        },
      }),
    );
    expect(error).toMatchObject({ operation: "source.snapshot", code: "lfs_digest_mismatch" });
    expect(staged).toBe(1);
  }),
);

it.effect("reads a bounded window ahead while staging chunks in order", () =>
  Effect.gen(function* () {
    const chunkBytes = 1024 * 1024;
    const size = chunkBytes * 9 + 13;
    const reads: number[] = [];
    const writes: number[] = [];
    let roundTrips = 0;
    let pendingRound: Promise<void> | undefined;
    const roundTrip = () => {
      pendingRound ??= Promise.resolve().then(() => {
        roundTrips++;
        pendingRound = undefined;
      });
      return pendingRound;
    };
    let cleaned = false;
    yield* transferForkBundle({
      source: {
        call: async (method) => {
          if (method === "git.cleanupFork") cleaned = true;
          return { blobId: "b".repeat(64), size, name: "bundle" };
        },
        transient: async (_method, raw) => {
          await roundTrip();
          const { offset } = decodeRead(raw);
          reads.push(offset);
          return {
            offset,
            size,
            data: Buffer.alloc(Math.min(chunkBytes, size - offset)).toString("base64"),
          };
        },
      },
      destination: {
        call: async () => null,
        transient: async (_method, raw) => {
          await roundTrip();
          const { offset, data } = decodeStage(raw);
          if (writes.length === 0) {
            expect(reads.length).toBeGreaterThan(1);
            expect(reads.length).toBeLessThanOrEqual(4);
          }
          expect(reads.length - writes.length).toBeLessThanOrEqual(4);
          writes.push(offset);
          return { complete: offset + Buffer.from(data, "base64").length === size, path: "/blob" };
        },
      },
      bundle: yield* Schema.decodeUnknownEffect(Fork.ForkBundle)(replies["git.bundleFork"]),
    });
    expect(writes).toEqual(Array.from({ length: 10 }, (_, index) => index * chunkBytes));
    // Three concurrent read windows plus ten ordered writes, previously twenty round trips.
    expect(roundTrips).toBe(13);
    expect(cleaned).toBe(true);
  }),
);

it.effect("skips every seed stage without acquiring a source for an existing destination", () =>
  Effect.gen(function* () {
    let inspections = 0;
    const stages: string[] = [];
    yield* seedWorkspace({
      source: Effect.die("A prepared workspace must not wake its source"),
      destination: {
        call: async (method) => {
          expect(method).toBe("git.isRepository");
          inspections++;
          return true;
        },
        transient: async () => {
          throw new Error("Unexpected transfer");
        },
      },
      sourceCwd: "repo",
      destinationCwd: "repo",
      key: "existing",
      onStage: (stage, status) =>
        Effect.sync(() => {
          stages.push(`${stage}:${status}`);
        }),
    });
    expect(inspections).toBe(1);
    expect(stages).toEqual(WORKSPACE_SEED_STAGE_ORDER.map((stage) => `${stage}:skipped`));
  }),
);

it.effect("reports seed boundaries and payload size in execution order", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const client = {
      call: async (method: string) => {
        events.push(method);
        return replies[method] ?? null;
      },
      transient: async (method: string) => replies[method] ?? null,
    };
    yield* seedWorkspace({
      source: Effect.sync(() => {
        events.push("wake-source");
        return client;
      }),
      destination: client,
      sourceCwd: "repo",
      destinationCwd: "repo",
      key: "progress",
      onStage: (stage, status, detail) =>
        Effect.sync(() => {
          events.push(`${stage}:${status}${detail ? `:${detail}` : ""}`);
        }),
    });
    expect(events).toEqual([
      "git.isRepository",
      "seed-source:running",
      "wake-source",
      "seed-source:done",
      "seed-checkpoint:running",
      "git.captureCheckpoint",
      "seed-checkpoint:done",
      "seed-bundle:running",
      "git.bundleFork",
      "seed-bundle:done",
      "seed-transfer:running",
      "asset.snapshot",
      "git.cleanupFork",
      "seed-transfer:done:0 bytes",
      "seed-import:running",
      "git.importFork",
      "seed-import:done",
    ]);
  }),
);

it.effect("aborts outstanding chunk reads and cleans the export when cancelled", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    let cleaned = false;
    const pending = yield* transferForkBundle({
      source: {
        call: async (method) => {
          if (method === "git.cleanupFork") cleaned = true;
          return { blobId: "b".repeat(64), size: Assets.CHUNK_BYTES * 8, name: "bundle" };
        },
        transient: async (_method, _input, signal) => {
          if (!signal) throw new Error("Missing cancellation signal");
          signals.push(signal);
          if (signals.length === 4) started.resolve();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
          });
        },
      },
      destination: {
        call: async () => null,
        transient: async () => {
          throw new Error("Unexpected stage");
        },
      },
      bundle: yield* Schema.decodeUnknownEffect(Fork.ForkBundle)(replies["git.bundleFork"]),
    }).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(pending);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cleaned).toBe(true);
  }),
);
