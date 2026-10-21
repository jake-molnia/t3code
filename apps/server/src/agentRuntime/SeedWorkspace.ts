import { WORKSPACE_SEED_STAGE_ORDER, type WorkspaceSeedStageId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ExecutionOperationError,
  ExecutionTransportError,
  type ExecutionClient,
} from "../execution/ExecutionClient.ts";
import * as Fork from "../execution/ForkWorkspaceProtocol.ts";
import * as Assets from "./worker/AssetProtocol.ts";

export class SeedWorkspaceError extends Schema.TaggedError<SeedWorkspaceError>()(
  "SeedWorkspaceError",
  {
    operation: Schema.String,
    code: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Project seed ${this.operation} failed (${this.code})`;
  }
}

const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SeedWorkspaceError({
        operation,
        code:
          (cause instanceof ExecutionOperationError || cause instanceof ExecutionTransportError) &&
          /^[a-z][a-z0-9_]{0,79}$/.test(cause.code)
            ? cause.code
            : "request_failed",
        cause,
      }),
  });

export const inspectSeedDestination = (client: Pick<ExecutionClient, "call">, cwd: string) =>
  request("destination.inspect", (signal) =>
    client.call("git.isRepository", { cwd }, undefined, signal),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)));

export const transferForkBundle = (input: {
  source: Pick<ExecutionClient, "call" | "transient">;
  destination: Pick<ExecutionClient, "call" | "transient">;
  bundle: typeof Fork.ForkBundle.Type;
  onBytes?: (bytes: number) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const transfer = (assetPath: string, expectedDigest?: string) =>
      Effect.gen(function* () {
        const blob = yield* request("source.snapshot", (signal) =>
          input.source.call("asset.snapshot", { path: assetPath }, undefined, signal),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Blob)));
        yield* input.onBytes?.(blob.size) ?? Effect.void;
        if (expectedDigest && blob.blobId !== expectedDigest)
          return yield* new SeedWorkspaceError({
            operation: "source.snapshot",
            code: "lfs_digest_mismatch",
            cause: "LFS content did not match its object id",
          });
        // Reads may overlap, but the worker only accepts contiguous staged chunks.
        // A fixed window bounds retained base64 payloads even for very large bundles.
        const chunks = Math.max(1, Math.ceil(blob.size / Assets.CHUNK_BYTES));
        for (let first = 0; first < chunks; first += 4) {
          const parts = yield* Effect.forEach(
            Array.from(
              { length: Math.min(4, chunks - first) },
              (_, index) => (first + index) * Assets.CHUNK_BYTES,
            ),
            (offset) =>
              request("source.read", (signal) =>
                input.source.transient(
                  "asset.read",
                  {
                    blobId: blob.blobId,
                    offset,
                    maxBytes: Assets.CHUNK_BYTES,
                    ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
                  },
                  signal,
                ),
              ).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Assets.ReadResult)),
                Effect.flatMap((part) =>
                  part.offset === offset && part.size === blob.size
                    ? Effect.succeed(part)
                    : Effect.fail(
                        new SeedWorkspaceError({
                          operation: "source.read",
                          code: "snapshot_changed",
                          cause: "Blob size or offset changed during transfer",
                        }),
                      ),
                ),
              ),
            { concurrency: 4 },
          );
          for (const part of parts) {
            const staged = yield* request("destination.stage", (signal) =>
              input.destination.transient(
                "asset.stage",
                {
                  blobId: blob.blobId,
                  offset: part.offset,
                  size: blob.size,
                  data: part.data,
                },
                signal,
              ),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Staged)));
            if (staged.complete) return blob.blobId;
          }
        }
        return yield* new SeedWorkspaceError({
          operation: "destination.stage",
          code: "transfer_unverified",
          cause: "Destination did not verify the complete blob",
        });
      });
    const blobId = yield* transfer(input.bundle.bundlePath).pipe(
      Effect.ensuring(
        request("source.cleanup", () =>
          input.source.call("git.cleanupFork", { bundlePath: input.bundle.bundlePath }),
        ).pipe(Effect.ignore),
      ),
    );
    const lfsObjects: string[] = [];
    for (const object of input.bundle.lfsObjects ?? [])
      lfsObjects.push(yield* transfer(object.path, object.oid));
    return { blobId, ...(lfsObjects.length > 0 ? { lfsObjects } : {}) };
  });

/** Each root receives a stable project snapshot, including uncommitted files. */
export const seedWorkspace = <E, R>(input: {
  source: Effect.Effect<Pick<ExecutionClient, "call" | "transient">, E, R>;
  destination: Pick<ExecutionClient, "call" | "transient">;
  sourceCwd: string;
  destinationCwd: string;
  key: string;
  checkoutBranch?: string;
  checkoutRef?: string;
  onStage?: (
    stage: WorkspaceSeedStageId,
    status: "running" | "done" | "skipped",
    detail?: string,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const stage = input.onStage ?? (() => Effect.void);
    const runStage = <A, E2, R2>(
      id: WorkspaceSeedStageId,
      effect: Effect.Effect<A, E2, R2>,
      detail?: () => string,
    ) =>
      Effect.gen(function* () {
        yield* stage(id, "running");
        const startedAt = yield* Clock.currentTimeMillis;
        return yield* effect.pipe(
          Effect.tap(() => stage(id, "done", detail?.())),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const endedAt = yield* Clock.currentTimeMillis;
              yield* Effect.logInfo("Workspace seed stage finished").pipe(
                Effect.annotateLogs({
                  seedKey: input.key,
                  stage: id,
                  durationMs: endedAt - startedAt,
                  outcome: exit._tag,
                }),
              );
            }),
          ),
          Effect.withSpan(`SeedWorkspace.${id}`),
        );
      });
    // Checkpoint refs and atomic import receipts provide retry safety. Transport
    // receipts cannot be reused for temporary exports or failed transfers.
    const checkpointRef = `refs/t3/seeds/${input.key}`;
    const prepared = yield* inspectSeedDestination(input.destination, input.destinationCwd);
    if (prepared) {
      for (const id of WORKSPACE_SEED_STAGE_ORDER) yield* stage(id, "skipped");
      return;
    }
    const source = yield* runStage("seed-source", input.source);
    yield* runStage(
      "seed-checkpoint",
      request("source.checkpoint", (signal) =>
        source.call(
          "git.captureCheckpoint",
          { cwd: input.sourceCwd, checkpointRef },
          undefined,
          signal,
        ),
      ),
    );
    const bundle = yield* runStage(
      "seed-bundle",
      request("source.bundle", (signal) =>
        source.call(
          "git.bundleFork",
          {
            cwd: input.sourceCwd,
            checkpointRef,
            ...(input.checkoutBranch ? { checkoutBranch: input.checkoutBranch } : {}),
            ...(input.checkoutRef ? { checkoutRef: input.checkoutRef } : {}),
          },
          undefined,
          signal,
        ),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Fork.ForkBundle))),
    );
    let bytes = 0;
    const transferred = yield* runStage(
      "seed-transfer",
      transferForkBundle({
        source,
        destination: input.destination,
        bundle,
        onBytes: (size) =>
          Effect.sync(() => {
            bytes += size;
          }),
      }),
      () => `${bytes.toLocaleString("en-US")} bytes`,
    ).pipe(
      Effect.tap(() =>
        Effect.logInfo("Workspace seed transferred").pipe(
          Effect.annotateLogs({
            seedKey: input.key,
            bytes,
            lfsObjects: bundle.lfsObjects?.length ?? 0,
          }),
        ),
      ),
    );
    const { bundlePath: _path, lfsObjects: _lfsObjects, ...snapshot } = bundle;
    yield* runStage(
      "seed-import",
      request("destination.import", (signal) =>
        input.destination.call(
          "git.importFork",
          {
            ...snapshot,
            cwd: input.destinationCwd,
            ...transferred,
          },
          undefined,
          signal,
        ),
      ),
    );
  }).pipe(Effect.withSpan("SeedWorkspace.seed", { attributes: { seedKey: input.key } }));
