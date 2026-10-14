// @effect-diagnostics nodeBuiltinImport:off -- Hash recording chunks without retaining the video in memory.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { parseAttachmentUuid, PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as Assets from "./worker/AssetProtocol.ts";

const decodeArtifact = Schema.decodeUnknownEffect(C.PreviewAutomationRecordingArtifact);
const decodeBlob = Schema.decodeUnknownEffect(Assets.Blob);
const isTransferError = Schema.is(C.PreviewAutomationRecordingTransferError);
const decodeChunk = Schema.decodeUnknownEffect(Assets.ReadResult);

/** Copies a worker recording into central attachment storage before the MCP handler claims it. */
export const retain = Effect.fn("PreviewRecording.retain")(function* (
  client: ExecutionClient,
  threadId: C.ThreadId,
  result: unknown,
) {
  return yield* Effect.gen(function* () {
    const artifact = yield* decodeArtifact(result);
    if (
      artifact.sizeBytes <= 0 ||
      artifact.sizeBytes > C.PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
      !["video/mp4", "video/webm"].includes(artifact.mimeType)
    )
      return yield* new C.PreviewAutomationRecordingTransferError({ threadId });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const extension = artifact.mimeType === "video/mp4" ? ".mp4" : ".webm";
    const uuid = parseAttachmentUuid(artifact.id);
    const uploadedAttachmentId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension.slice(1)}`;
    if (!uuid || artifact.id !== uploadedAttachmentId)
      return yield* new C.PreviewAutomationRecordingTransferError({ threadId });
    const blob = yield* Effect.tryPromise(() =>
      client.call("asset.snapshot", { path: artifact.path }),
    ).pipe(Effect.flatMap(decodeBlob));
    const destination = path.join(config.attachmentsDir, `${uploadedAttachmentId}${extension}`);
    const temporary = `${destination}.${yield* crypto.randomUUIDv4}.part`;
    return yield* Effect.gen(function* () {
      if (blob.size !== artifact.sizeBytes)
        return yield* new C.PreviewAutomationRecordingTransferError({ threadId });
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(temporary, new Uint8Array());
      const hash = NodeCrypto.createHash("sha256");
      for (let offset = 0; offset < blob.size;) {
        const chunk = yield* Effect.tryPromise((signal) =>
          client.transient(
            "asset.read",
            {
              blobId: blob.blobId,
              ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
              offset,
              maxBytes: Assets.CHUNK_BYTES,
            },
            signal,
          ),
        ).pipe(Effect.flatMap(decodeChunk));
        const bytes = yield* Effect.fromResult(Base64.decode(chunk.data));
        if (
          chunk.offset !== offset ||
          chunk.size !== blob.size ||
          bytes.length === 0 ||
          bytes.length > Assets.CHUNK_BYTES ||
          offset + bytes.length > blob.size
        )
          return yield* new C.PreviewAutomationRecordingTransferError({ threadId });
        hash.update(bytes);
        yield* fs.writeFile(temporary, bytes, { flag: "a" });
        offset += bytes.length;
      }
      if (hash.digest("hex") !== blob.blobId)
        return yield* new C.PreviewAutomationRecordingTransferError({ threadId });
      yield* fs.rename(temporary, destination);
      return { ...artifact, path: destination, uploadedAttachmentId };
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            fs.remove(temporary, { force: true }).pipe(Effect.ignore),
            Effect.tryPromise((signal) =>
              client.transient(
                "asset.read",
                {
                  blobId: blob.blobId,
                  ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
                  offset: blob.size,
                  maxBytes: 1,
                },
                signal,
              ),
            ).pipe(Effect.interruptible, Effect.timeout("5 seconds"), Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
  }).pipe(
    Effect.mapError((cause) =>
      isTransferError(cause)
        ? cause
        : new C.PreviewAutomationRecordingTransferError({ threadId, cause }),
    ),
  );
});
