import * as Schema from "effect/Schema";
import { CheckpointRef } from "@t3tools/contracts";
import { Digest } from "../agentRuntime/worker/AssetProtocol.ts";
const Oid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
export const ExportFork = Schema.Struct({
  cwd: Schema.NonEmptyString,
  checkpointRef: CheckpointRef,
});
export const ForkBundle = Schema.Struct({
  bundlePath: Schema.String,
  lfsObjects: Schema.optionalKey(Schema.Array(Schema.Struct({ oid: Digest, path: Schema.String }))),
  checkpointRef: CheckpointRef,
  checkpointOid: Oid,
  baseCommit: Schema.NullOr(Oid),
  branch: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
});
export const ImportFork = Schema.Struct({
  cwd: Schema.NonEmptyString,
  blobId: Digest,
  lfsObjects: Schema.optionalKey(Schema.Array(Digest)),
  checkpointRef: CheckpointRef,
  checkpointOid: Oid,
  baseCommit: Schema.NullOr(Oid),
  branch: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
});
export const ForkReceipt = Schema.Struct({ blobId: Digest, checkpointOid: Oid });
