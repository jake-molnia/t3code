import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as UsageService from "../usage/UsageService.ts";
import type { History } from "../usage/UsageHistorySources.ts";

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
const ExportId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const Export = Schema.Struct({
  exportId: ExportId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  size: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_EXPORT_BYTES),
  ),
});
export const Chunk = Schema.Struct({
  offset: Schema.Int,
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(CHUNK_BYTES / 3) * 4)),
});
const Read = Schema.Struct({
  exportId: ExportId,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const Release = Schema.Struct({ exportId: ExportId });
const decodeRead = Schema.decodeUnknownEffect(Read);
const decodeRelease = Schema.decodeUnknownEffect(Release);
async function writeHistory(path: string, sources: History) {
  const handle = await NodeFSP.open(path, "wx", 0o600);
  const digest = NodeCrypto.createHash("sha256");
  let size = 0;
  let buffered = "";
  async function append(text: string) {
    size += Buffer.byteLength(text);
    if (size > MAX_EXPORT_BYTES)
      throw new Error("Normalized usage history exceeds the 128 MiB export limit");
    buffered += text;
    if (buffered.length >= 65536) {
      digest.update(buffered);
      await handle.writeFile(buffered);
      buffered = "";
    }
  }
  try {
    await append("[");
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (!source) continue;
      if (index > 0) await append(",");
      if (source.files === null) {
        await append(JSON.stringify(source));
        continue;
      }
      await append(JSON.stringify({ ...source, files: undefined }).slice(0, -1) + ',"files":[');
      for (let fileIndex = 0; fileIndex < source.files.length; fileIndex++) {
        const file = source.files[fileIndex];
        if (!file) continue;
        if (fileIndex > 0) await append(",");
        await append('{"path":' + JSON.stringify(file.path) + ',"records":[');
        for (let recordIndex = 0; recordIndex < file.records.length; recordIndex++) {
          if (recordIndex > 0) await append(",");
          await append(JSON.stringify(file.records[recordIndex]));
        }
        await append("]}");
      }
      await append("]}");
    }
    await append("]");
    digest.update(buffered);
    await handle.writeFile(buffered);
    await handle.sync();
    return { size, digest: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Short-lived exports contain only normalized billing records, never transcript contents. */
export const makeWorkerUsage = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const directory = NodePath.join(config.stateDir, "usage-history-exports");
  yield* Effect.tryPromise(async () => {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await NodeFSP.readdir(directory))
      await NodeFSP.rm(NodePath.join(directory, name), { force: true });
  });
  const exports = new Map<string, { expires: number; size: number }>();
  let activeOperations = 0;
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of exports) {
      if (entry.expires > now) continue;
      yield* Effect.tryPromise(() => NodeFSP.rm(NodePath.join(directory, id), { force: true }));
      exports.delete(id);
    }
  });
  const execute = (method: string, input: unknown) =>
    lock.withPermit(
      Effect.gen(function* () {
        activeOperations++;
        try {
          yield* prune;
          if (method === "usage.history") {
            if (exports.size >= 2)
              return yield* Effect.fail(new Error("Usage history export already in progress"));
            const history = yield* usage.readHistory;
            const exportId = NodeCrypto.randomUUID();
            const destination = NodePath.join(directory, exportId);
            const exported = yield* Effect.tryPromise(() =>
              writeHistory(destination, history),
            ).pipe(
              Effect.onError(() => Effect.promise(() => NodeFSP.rm(destination, { force: true }))),
            );
            exports.set(exportId, {
              size: exported.size,
              expires: (yield* Clock.currentTimeMillis) + 120_000,
            });
            return { exportId, ...exported };
          }
          if (method === "usage.read") {
            const request = yield* decodeRead(input);
            const entry = exports.get(request.exportId);
            if (!entry || request.offset >= entry.size)
              return yield* Effect.fail(new Error("Usage export unavailable"));
            return yield* Effect.tryPromise(async () => {
              const handle = await NodeFSP.open(NodePath.join(directory, request.exportId), "r");
              try {
                const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, entry.size - request.offset));
                const read = await handle.read(bytes, 0, bytes.length, request.offset);
                return {
                  offset: request.offset,
                  data: bytes.subarray(0, read.bytesRead).toString("base64"),
                };
              } finally {
                await handle.close();
              }
            });
          }
          if (method === "usage.release") {
            const request = yield* decodeRelease(input);
            if (exports.has(request.exportId)) {
              yield* Effect.tryPromise(() =>
                NodeFSP.rm(NodePath.join(directory, request.exportId), { force: true }),
              );
              exports.delete(request.exportId);
            }
            return null;
          }
          return yield* Effect.fail(new Error("Unsupported usage method"));
        } finally {
          activeOperations--;
        }
      }),
    );
  return {
    execute,
    activity: Clock.currentTimeMillis.pipe(
      Effect.map((now) => ({
        activeOperations:
          activeOperations + [...exports.values()].filter((entry) => entry.expires > now).length,
        pendingCallbacks: 0,
      })),
    ),
  };
});
