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

const request = <A>(operation: string, run: () => Promise<A>) =>
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
  request("destination.inspect", () => client.call("git.isRepository", { cwd })).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
  );

export const transferForkBundle = (input: {
  source: Pick<ExecutionClient, "call" | "transient">;
  destination: Pick<ExecutionClient, "call" | "transient">;
  bundle: typeof Fork.ForkBundle.Type;
}) =>
  Effect.gen(function* () {
    const transfer = (assetPath: string, expectedDigest?: string) =>
      Effect.gen(function* () {
        const blob = yield* request("source.snapshot", () =>
          input.source.call("asset.snapshot", { path: assetPath }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Blob)));
        if (expectedDigest && blob.blobId !== expectedDigest)
          return yield* new SeedWorkspaceError({
            operation: "source.snapshot",
            code: "lfs_digest_mismatch",
            cause: "LFS content did not match its object id",
          });
        for (let offset = 0; ; offset += Assets.CHUNK_BYTES) {
          const part = yield* request("source.read", () =>
            input.source.transient("asset.read", {
              blobId: blob.blobId,
              offset,
              maxBytes: Assets.CHUNK_BYTES,
              ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.ReadResult)));
          if (part.offset !== offset || part.size !== blob.size)
            return yield* new SeedWorkspaceError({
              operation: "source.read",
              code: "snapshot_changed",
              cause: "Blob size or offset changed during transfer",
            });
          const staged = yield* request("destination.stage", () =>
            input.destination.transient("asset.stage", {
              blobId: blob.blobId,
              offset,
              size: blob.size,
              data: part.data,
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Staged)));
          if (staged.complete) break;
          if (offset + Assets.CHUNK_BYTES >= blob.size)
            return yield* new SeedWorkspaceError({
              operation: "destination.stage",
              code: "transfer_unverified",
              cause: "Destination did not verify the complete blob",
            });
        }
        return blob.blobId;
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
export const seedWorkspace = (input: {
  source: Pick<ExecutionClient, "call" | "transient">;
  destination: Pick<ExecutionClient, "call" | "transient">;
  sourceCwd: string;
  destinationCwd: string;
  key: string;
}) =>
  Effect.gen(function* () {
    // Checkpoint refs and atomic import receipts provide retry safety. Transport
    // receipts cannot be reused for temporary exports or failed transfers.
    const checkpointRef = `refs/t3/seeds/${input.key}`;
    const prepared = yield* inspectSeedDestination(input.destination, input.destinationCwd);
    if (prepared) return;
    yield* request("source.checkpoint", () =>
      input.source.call("git.captureCheckpoint", { cwd: input.sourceCwd, checkpointRef }),
    );
    const bundle = yield* request("source.bundle", () =>
      input.source.call("git.bundleFork", { cwd: input.sourceCwd, checkpointRef }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Fork.ForkBundle)));
    const transferred = yield* transferForkBundle({ ...input, bundle });
    const { bundlePath: _path, lfsObjects: _lfsObjects, ...snapshot } = bundle;
    yield* request("destination.import", () =>
      input.destination.call("git.importFork", {
        ...snapshot,
        cwd: input.destinationCwd,
        ...transferred,
      }),
    );
  });
