import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_BLOB_BYTES = 1024 * 1024 * 1024;
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Stage = Schema.Struct({
  blobId: Digest,
  offset: nonNegative,
  size: nonNegative.check(Schema.isLessThanOrEqualTo(MAX_BLOB_BYTES)),
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(CHUNK_BYTES / 3) * 4)),
});
export const StageAttachment = Schema.Struct({ ...Stage.fields, attachment: C.ChatAttachment });
export const Read = Schema.Struct({
  blobId: Digest,
  leaseId: Schema.optionalKey(Schema.String),
  offset: nonNegative,
  maxBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(CHUNK_BYTES)),
});
export const ReadResult = Schema.Struct({
  data: Schema.String,
  offset: nonNegative,
  size: nonNegative,
});
export const Staged = Schema.Struct({ complete: Schema.Boolean, path: Schema.String });
export const Snapshot = Schema.Struct({ path: Schema.String });
export const Blob = Schema.Struct({
  blobId: Digest,
  size: nonNegative,
  name: Schema.String,
  leaseId: Schema.optionalKey(Schema.String),
});
export const Stat = Schema.Struct({ path: Schema.String });
export const StatResult = Schema.Struct({ size: nonNegative, mtimeMs: Schema.Number });
