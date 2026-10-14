import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 100;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const PastedTextAttachmentSource = Schema.TaggedStruct("pasted-text", {});
export type PastedTextAttachmentSource = typeof PastedTextAttachmentSource.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
  /** Clipboard text folded by a client. Providers keep these path-only so the
      agent can inspect the file selectively instead of eagerly spending the
      same context the fold is intended to preserve. */
  source: Schema.optional(PastedTextAttachmentSource),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

/**
 * Catch-all for attachment types this build does not know. Attachments ride on
 * persisted events and thread streams, so a newer server or client must be able
 * to introduce a type without making older readers fail to decode the whole
 * message. Decoders keep the shared base fields; consumers skip these or render
 * them as unsupported. Mirrors how `OrchestrationThreadActivity` keeps `kind`
 * open. The known discriminators are excluded so a malformed image or file
 * attachment fails its own schema instead of sliding through here with its
 * size and mime constraints unchecked.
 */
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  id: Schema.optional(ChatAttachmentId),
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;

export function getProviderAttachmentLimitError(
  attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes">>,
): string | undefined {
  if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message or question response.`;
  }
  const imageBytes = attachments.reduce(
    (total, attachment) =>
      total +
      (attachment.type === "image" || isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
        ? attachment.sizeBytes
        : 0),
    0,
  );
  if (imageBytes > PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES) {
    return "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.";
  }
}

export const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const PersistChatAttachmentsInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachments: Schema.Array(UploadChatAttachment),
});
export type PersistChatAttachmentsInput = typeof PersistChatAttachmentsInput.Type;

export const PersistChatAttachmentsResult = Schema.Struct({
  attachments: Schema.Array(ChatAttachment),
});
export type PersistChatAttachmentsResult = typeof PersistChatAttachmentsResult.Type;

export class PersistChatAttachmentsError extends Schema.TaggedError<PersistChatAttachmentsError>()(
  "PersistChatAttachmentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
