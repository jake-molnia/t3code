// @effect-diagnostics nodeBuiltinImport:off -- Streaming adapter for the worker's content-addressed asset protocol.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as P from "./worker/AssetProtocol.ts";

const decodeBlob = Schema.decodeUnknownSync(P.Blob);
const decodeDigest = Schema.decodeUnknownSync(P.Digest);
const decodeReadResult = Schema.decodeUnknownSync(P.ReadResult);
const decodeStaged = Schema.decodeUnknownSync(P.Staged);

export async function receiveWorkerBlob(
  client: ExecutionClient,
  source: string,
  directory: string,
  signal?: AbortSignal,
) {
  const blob = decodeBlob(await client.call("asset.snapshot", { path: source }, undefined, signal));
  if (blob.size > P.MAX_BLOB_BYTES) throw new Error("IDE archive exceeds the transfer limit");
  await NodeFSP.mkdir(directory, { recursive: true });
  const destination = NodePath.join(directory, blob.blobId);
  const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    const hash = NodeCrypto.createHash("sha256");
    for (let offset = 0; offset < blob.size;) {
      const part = decodeReadResult(
        await client.transient(
          "asset.read",
          {
            blobId: blob.blobId,
            leaseId: blob.leaseId,
            offset,
            maxBytes: P.CHUNK_BYTES,
          },
          signal,
        ),
      );
      const bytes = Buffer.from(part.data, "base64");
      if (
        part.offset !== offset ||
        part.size !== blob.size ||
        bytes.length === 0 ||
        offset + bytes.length > blob.size
      )
        throw new Error("Invalid archive transfer range");
      hash.update(bytes);
      await file.writeFile(bytes);
      offset += bytes.length;
    }
    if (hash.digest("hex") !== blob.blobId) throw new Error("Archive content digest mismatch");
    await file.sync();
    await NodeFSP.rename(temporary, destination);
    return { digest: blob.blobId, size: blob.size };
  } finally {
    await file.close();
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function sendWorkerBlob(
  client: ExecutionClient,
  directory: string,
  digest: string,
  signal?: AbortSignal,
) {
  decodeDigest(digest);
  const file = await NodeFSP.open(NodePath.join(directory, digest), "r");
  try {
    const { size } = await file.stat();
    if (size > P.MAX_BLOB_BYTES) throw new Error("IDE archive exceeds the transfer limit");
    let destination: string | undefined;
    for (let offset = 0; offset < size;) {
      const bytes = Buffer.alloc(Math.min(P.CHUNK_BYTES, size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw new Error("Saved archive is incomplete");
      const result = decodeStaged(
        await client.transient(
          "asset.stage",
          {
            blobId: digest,
            offset,
            size,
            data: bytes.toString("base64"),
          },
          signal,
        ),
      );
      offset += bytesRead;
      if (result.complete) {
        destination = result.path;
        break;
      }
    }
    if (destination === undefined) throw new Error("Archive staging did not complete");
    return destination;
  } finally {
    await file.close();
  }
}
