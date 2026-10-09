import * as Clock from "effect/Clock";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
// @effect-diagnostics nodeBuiltinImport:off -- Chunked binary I/O holds file descriptors and syncs atomic publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { pipeline } from "node:stream/promises";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import { openMediaFile } from "../../assets/MediaFile.ts";
import * as P from "./AssetProtocol.ts";

export const blobPath = (stateDir: string, blobId: string) =>
  NodePath.join(stateDir, "worker-blobs", blobId);
export class AssetExecutionError extends Schema.TaggedError<AssetExecutionError>()(
  "AssetExecutionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const digestHandle = async (file: NodeFSP.FileHandle) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected binary stream");
    hash.update(chunk);
  }
  return hash.digest("hex");
};
export const makeAssetExecutor = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const favicon = yield* Effect.serviceOption(ProjectFaviconResolver.ProjectFaviconResolver);
  const locks = yield* KeyedLock.make<string>();
  const pendingUploads = new Map<string, number>();
  const pendingReads = new Map<string, number>();
  const io = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new AssetExecutionError({ operation, cause }),
    });
  const allowedPath = (requested: string) =>
    io("resolve", async () => {
      const resolved = await NodeFSP.realpath(
        NodePath.isAbsolute(requested) ? requested : NodePath.resolve(config.cwd, requested),
      );
      const roots = await Promise.all([NodeFSP.realpath(config.cwd), NodeFSP.realpath("/tmp")]);
      if (
        !roots.some((root) => {
          const relative = NodePath.relative(root, resolved);
          return (
            relative === "" ||
            (!NodePath.isAbsolute(relative) &&
              relative !== ".." &&
              !relative.startsWith(`..${NodePath.sep}`))
          );
        })
      )
        throw new Error("Asset path is outside the sandbox workspace and temporary directory");
      return resolved;
    });
  const stage = (input: typeof P.Stage.Type, destination: string) =>
    locks
      .withLock(
        destination,
        io("stage", async () => {
          const bytes = Buffer.from(input.data, "base64");
          if (
            bytes.length > P.CHUNK_BYTES ||
            input.offset + bytes.length > input.size ||
            bytes.toString("base64") !== input.data
          )
            throw new Error("Invalid asset chunk");
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          let existing: NodeFSP.FileHandle | undefined;
          try {
            existing = await NodeFSP.open(
              destination,
              NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
            );
            const info = await existing.stat();
            if (
              !info.isFile() ||
              info.size !== input.size ||
              (await digestHandle(existing)) !== input.blobId
            )
              throw new Error("Immutable asset content conflict");
            return { complete: true, path: destination };
          } catch (error) {
            if (!missing(error)) throw error;
          } finally {
            await existing?.close();
          }
          const partial = `${destination}.${input.blobId}.part`;
          const file = await NodeFSP.open(
            partial,
            NodeFS.constants.O_RDWR | NodeFS.constants.O_CREAT | NodeFS.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const info = await file.stat();
            if (!info.isFile() || info.size < input.offset)
              throw new Error("Asset chunk has a gap");
            if (info.size > input.offset) {
              if (info.size < input.offset + bytes.length)
                throw new Error("Asset chunk overlaps partial data");
              const previous = Buffer.alloc(bytes.length);
              const read = await file.read(previous, 0, bytes.length, input.offset);
              if (read.bytesRead !== bytes.length || !previous.equals(bytes))
                throw new Error("Asset retry changed bytes");
            } else {
              let written = 0;
              while (written < bytes.length) {
                const result = await file.write(
                  bytes,
                  written,
                  bytes.length - written,
                  input.offset + written,
                );
                if (result.bytesWritten === 0) throw new Error("Asset write stalled");
                written += result.bytesWritten;
              }
            }
            const final = await file.stat();
            if (final.size !== input.size) return { complete: false, path: destination };
            if ((await digestHandle(file)) !== input.blobId)
              throw new Error("Asset digest mismatch");
            await file.sync();
            await NodeFSP.rename(partial, destination);
            return { complete: true, path: destination };
          } finally {
            await file.close();
          }
        }),
      )
      .pipe(
        Effect.tap((result) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              if (result.complete) pendingUploads.delete(destination);
              else pendingUploads.set(destination, now);
            }),
          ),
        ),
      );
  const execute = (method: string, raw: unknown) =>
    Effect.gen(function* () {
      if (method === "input.stage") {
        const input = yield* Schema.decodeUnknownEffect(P.StageAttachment)(raw);
        const relative = attachmentRelativePath(input.attachment);
        const destination = relative
          ? resolveAttachmentRelativePath({
              attachmentsDir: config.attachmentsDir,
              relativePath: relative,
            })
          : null;
        if (!destination)
          return yield* new AssetExecutionError({
            operation: "stage",
            cause: "Invalid attachment filename",
          });
        if (input.size !== input.attachment.sizeBytes)
          return yield* new AssetExecutionError({
            operation: "stage",
            cause: "Attachment size mismatch",
          });
        return yield* stage(input, destination);
      }
      if (method === "asset.stage") {
        const input = yield* Schema.decodeUnknownEffect(P.Stage)(raw);
        return yield* stage(input, blobPath(config.stateDir, input.blobId));
      }
      if (method === "asset.read") {
        const input = yield* Schema.decodeUnknownEffect(P.Read)(raw);
        return yield* io("read", async () => {
          const file = await NodeFSP.open(
            blobPath(config.stateDir, input.blobId),
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile() || input.offset > stat.size) throw new Error("Invalid blob range");
            const bytes = Buffer.alloc(Math.min(input.maxBytes, stat.size - input.offset));
            const read = await file.read(bytes, 0, bytes.length, input.offset);
            return {
              data: bytes.subarray(0, read.bytesRead).toString("base64"),
              offset: input.offset,
              size: stat.size,
            };
          } finally {
            await file.close();
          }
        }).pipe(
          Effect.tap((result) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                const key = input.leaseId ?? input.blobId;
                if (result.offset + Buffer.from(result.data, "base64").length >= result.size)
                  pendingReads.delete(key);
                else pendingReads.set(key, now);
              }),
            ),
          ),
        );
      }
      if (method === "asset.favicon") {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ cwd: Schema.String, preferred: Schema.optional(Schema.String) }),
        )(raw);
        if (Option.isNone(favicon))
          return yield* new AssetExecutionError({
            operation: method,
            cause: "Favicon resolver unavailable",
          });
        return yield* favicon.value.resolvePath(yield* allowedPath(input.cwd), input.preferred);
      }
      if (method === "asset.stat") {
        const input = yield* Schema.decodeUnknownEffect(P.Stat)(raw);
        const path = yield* allowedPath(input.path);
        return yield* io("stat", async () => {
          const info = await NodeFSP.stat(path);
          if (!info.isFile()) throw new Error("Asset is not a regular file");
          return { size: info.size, mtimeMs: info.mtimeMs };
        });
      }
      if (method === "asset.snapshot") {
        const input = yield* Schema.decodeUnknownEffect(P.Snapshot)(raw);
        const path = yield* allowedPath(input.path);
        const temporaryName = yield* crypto.randomUUIDv4;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const source = yield* openMediaFile(path);
            if (!source || source.info.size > BigInt(P.MAX_BLOB_BYTES))
              return yield* new AssetExecutionError({
                operation: "snapshot",
                cause: "Asset unavailable or too large",
              });
            return yield* io("snapshot", async () => {
              const directory = NodePath.join(config.stateDir, "worker-blobs");
              await NodeFSP.mkdir(directory, { recursive: true });
              const temporary = NodePath.join(directory, `${temporaryName}.part`);
              const hash = NodeCrypto.createHash("sha256");
              let size = 0;
              const hashing = new NodeStream.Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.length;
                  if (size > P.MAX_BLOB_BYTES) {
                    callback(new Error("Asset exceeds size limit"));
                    return;
                  }
                  hash.update(chunk);
                  callback(null, chunk);
                },
              });
              try {
                await pipeline(
                  source.handle.createReadStream({ autoClose: false }),
                  hashing,
                  NodeFS.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
                );
                const blobId = hash.digest("hex");
                const destination = blobPath(config.stateDir, blobId);
                const file = await NodeFSP.open(temporary, "r+");
                try {
                  await file.sync();
                } finally {
                  await file.close();
                }
                await NodeFSP.rename(temporary, destination);
                return { blobId, size, name: NodePath.basename(path), leaseId: temporaryName };
              } finally {
                await NodeFSP.rm(temporary, { force: true });
              }
            });
          }),
        ).pipe(
          Effect.tap((blob) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                if (blob.size > 0) pendingReads.set(blob.leaseId, now);
              }),
            ),
          ),
        );
      }
      return yield* new AssetExecutionError({
        operation: method,
        cause: "Unsupported asset operation",
      });
    });
  return {
    execute,
    activity: Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        for (const [destination, updatedAt] of pendingUploads)
          if (now - updatedAt > 60_000) pendingUploads.delete(destination);
        for (const [leaseId, updatedAt] of pendingReads)
          if (now - updatedAt > 60_000) pendingReads.delete(leaseId);
        return { activeOperations: pendingUploads.size + pendingReads.size, pendingCallbacks: 0 };
      }),
    ),
  };
});
