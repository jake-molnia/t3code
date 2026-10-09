import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Base64 from "effect/encoding/Base64";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import { makeAssetExecutor, blobPath } from "./AssetExecutor.ts";
import * as P from "./AssetProtocol.ts";

const services = ServerConfig.layerTest(process.cwd(), { prefix: "worker-asset-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const hash = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return Array.from(yield* crypto.digest("SHA-256", bytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
it.layer(services, { excludeTestServices: true })("worker binary assets", (it) => {
  it.effect(
    "resumes chunk uploads, rejects changed retries, verifies content and reuses finalized files",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeAssetExecutor;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const bytes = new Uint8Array(P.CHUNK_BYTES + 7).fill(37);
        const blobId = yield* hash(bytes);
        const first = {
          blobId,
          offset: 0,
          size: bytes.length,
          data: Base64.encode(bytes.subarray(0, P.CHUNK_BYTES)),
        };
        expect(yield* executor.execute("asset.stage", first)).toMatchObject({ complete: false });
        expect((yield* executor.activity).activeOperations).toBe(1);
        expect(yield* executor.execute("asset.stage", first)).toMatchObject({ complete: false });
        const bad = yield* Effect.exit(
          executor.execute("asset.stage", {
            ...first,
            data: Base64.encode(new Uint8Array(P.CHUNK_BYTES).fill(38)),
          }),
        );
        expect(bad._tag).toBe("Failure");
        const done = yield* Schema.decodeUnknownEffect(P.Staged)(
          yield* executor.execute("asset.stage", {
            ...first,
            offset: P.CHUNK_BYTES,
            data: Base64.encode(bytes.subarray(P.CHUNK_BYTES)),
          }),
        );
        expect(done.complete).toBe(true);
        expect((yield* executor.activity).activeOperations).toBe(0);
        expect(yield* hash(yield* fs.readFile(blobPath(config.stateDir, blobId)))).toBe(blobId);
        const reconstructed = yield* makeAssetExecutor;
        expect(yield* reconstructed.execute("asset.stage", first)).toMatchObject({
          complete: true,
          path: done.path,
        });
      }),
  );
  it.effect(
    "stages claimed attachments into the provider attachment directory and snapshots immutable output",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeAssetExecutor;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bytes = new TextEncoder().encode("reply-file-content");
        const blobId = yield* hash(bytes);
        const attachment = {
          type: "file",
          id: "thread-123e4567-e89b-12d3-a456-426614174000-txt",
          name: "answer.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.length,
        };
        const done = yield* Schema.decodeUnknownEffect(P.Staged)(
          yield* executor.execute("input.stage", {
            attachment,
            blobId,
            offset: 0,
            size: bytes.length,
            data: Base64.encode(bytes),
          }),
        );
        expect(done.path.startsWith(config.attachmentsDir)).toBe(true);
        expect(yield* fs.readFileString(done.path)).toBe("reply-file-content");
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "worker-output-" });
        const output = path.join(directory, "report.png");
        yield* fs.writeFile(output, bytes);
        const snapshot = yield* Schema.decodeUnknownEffect(P.Blob)(
          yield* executor.execute("asset.snapshot", { path: output }),
        );
        expect((yield* executor.activity).activeOperations).toBe(1);
        yield* fs.writeFileString(output, "changed later");
        const read = yield* Schema.decodeUnknownEffect(P.ReadResult)(
          yield* executor.execute("asset.read", {
            blobId: snapshot.blobId,
            ...(snapshot.leaseId ? { leaseId: snapshot.leaseId } : {}),
            offset: 0,
            maxBytes: 1024,
          }),
        );
        expect(read.data).toBe(Base64.encode(bytes));
        expect((yield* executor.activity).activeOperations).toBe(0);
        expect(
          (yield* Effect.exit(executor.execute("asset.snapshot", { path: "/etc/passwd" })))._tag,
        ).toBe("Failure");
      }),
  );
});
