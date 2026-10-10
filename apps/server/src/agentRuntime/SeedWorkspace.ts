import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as Fork from "../execution/ForkWorkspaceProtocol.ts";
import * as Assets from "./worker/AssetProtocol.ts";

class SeedTransferError extends Schema.TaggedError<SeedTransferError>()("SeedTransferError", {
  message: Schema.String,
}) {}

/** Each root receives a stable project snapshot, including uncommitted files. */
export const seedWorkspace = (input: {
  source: Pick<ExecutionClient, "call" | "transient">;
  destination: Pick<ExecutionClient, "call" | "transient">;
  sourceCwd: string;
  destinationCwd: string;
  key: string;
}) =>
  Effect.gen(function* () {
    const checkpointRef = `refs/t3/seeds/${input.key}`;
    const operation = `seed:${input.key}`;
    yield* Effect.tryPromise(() =>
      input.source.call(
        "git.captureCheckpoint",
        { cwd: input.sourceCwd, checkpointRef },
        `${operation}:capture`,
      ),
    );
    const bundle = yield* Effect.tryPromise(() =>
      input.source.call(
        "git.bundleFork",
        { cwd: input.sourceCwd, checkpointRef },
        `${operation}:bundle`,
      ),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Fork.ForkBundle)));
    const blob = yield* Effect.tryPromise(() =>
      input.source.call("asset.snapshot", { path: bundle.bundlePath }, `${operation}:snapshot`),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Blob)));
    yield* Effect.tryPromise(() =>
      input.source.call("git.cleanupFork", { bundlePath: bundle.bundlePath }),
    ).pipe(Effect.ignore);
    for (let offset = 0; ; offset += Assets.CHUNK_BYTES) {
      const part = yield* Effect.tryPromise(() =>
        input.source.transient("asset.read", {
          blobId: blob.blobId,
          offset,
          maxBytes: Assets.CHUNK_BYTES,
          ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
        }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.ReadResult)));
      if (part.offset !== offset || part.size !== blob.size)
        return yield* new SeedTransferError({ message: "Project seed changed during transfer" });
      const staged = yield* Effect.tryPromise(() =>
        input.destination.transient("asset.stage", {
          blobId: blob.blobId,
          offset,
          size: blob.size,
          data: part.data,
        }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Assets.Staged)));
      if (staged.complete) break;
      if (offset + Assets.CHUNK_BYTES >= blob.size)
        return yield* new SeedTransferError({ message: "Project seed transfer was not verified" });
    }
    const { bundlePath: _path, ...snapshot } = bundle;
    yield* Effect.tryPromise(() =>
      input.destination.call(
        "git.importFork",
        {
          ...snapshot,
          cwd: input.destinationCwd,
          blobId: blob.blobId,
        },
        `${operation}:import`,
      ),
    );
  });
