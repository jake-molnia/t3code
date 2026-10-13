import type { ChatAttachment, ThreadId } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as P from "./worker/AssetProtocol.ts";

export class AttachmentStagingError extends Schema.TaggedError<AttachmentStagingError>()(
  "AttachmentStagingError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The attachment could not be transferred to this conversation's sandbox.";
  }
}
export class AttachmentStaging extends Context.Service<
  AttachmentStaging,
  {
    readonly enabled: boolean;
    readonly stage: (
      threadId: ThreadId,
      attachments: ReadonlyArray<ChatAttachment>,
    ) => Effect.Effect<ReadonlyMap<string, string>, AttachmentStagingError>;
  }
>()("t3/agentRuntime/AttachmentStaging") {}
export const layer = Layer.effect(
  AttachmentStaging,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    return AttachmentStaging.of({
      enabled: true,
      stage: (threadId, attachments) =>
        Effect.gen(function* () {
          const paths = new Map<string, string>();
          if (attachments.length === 0) return paths;
          const client = yield* runtime.forThread(threadId);
          for (const attachment of attachments) {
            if (attachment.type !== "image" && attachment.type !== "file") continue;
            const source = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            if (!source)
              return yield* new AttachmentStagingError({ cause: "Invalid attachment reference" });
            const info = yield* fs.stat(source);
            if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes)
              return yield* new AttachmentStagingError({
                cause: "Attachment bytes no longer match their claimed size",
              });
            const bytes = yield* fs.readFile(source);
            if (bytes.length !== attachment.sizeBytes)
              return yield* new AttachmentStagingError({
                cause: "Attachment changed during transfer",
              });
            const digest = yield* crypto.digest("SHA-256", bytes);
            const blobId = Array.from(digest)
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            for (let offset = 0; ; offset += P.CHUNK_BYTES) {
              const result = yield* Effect.tryPromise(() =>
                client.transient("input.stage", {
                  attachment,
                  blobId,
                  offset,
                  size: bytes.length,
                  data: Base64.encode(bytes.subarray(offset, offset + P.CHUNK_BYTES)),
                }),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(P.Staged)));
              if (result.complete) {
                paths.set(attachment.id, result.path);
                break;
              }
              if (offset + P.CHUNK_BYTES >= bytes.length)
                return yield* new AttachmentStagingError({
                  cause: "Worker did not verify the completed attachment",
                });
            }
          }
          return paths;
        }).pipe(Effect.mapError((cause) => new AttachmentStagingError({ cause }))),
    });
  }),
);
