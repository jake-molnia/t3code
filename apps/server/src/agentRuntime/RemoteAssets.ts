import * as SqlClient from "effect/sql/SqlClient";
import * as Bindings from "./Bindings.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Hash large materialized media incrementally without buffering the entire file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type { AssetResource } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as ServerConfig from "../config.ts";
import * as P from "./worker/AssetProtocol.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";

export interface AssetInput {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
  readonly projectFaviconPath?: string;
  readonly projectCheckoutPending?: boolean;
}
export class RemoteAssetError extends Schema.TaggedError<RemoteAssetError>()("RemoteAssetError", {
  cause: Schema.Defect(),
}) {}
export class RemoteAssets extends Context.Service<
  RemoteAssets,
  {
    readonly enabled: boolean;
    readonly prepare: (input: AssetInput) => Effect.Effect<AssetInput, RemoteAssetError>;
    readonly populate: (
      workspaceRoot: string,
      relativePath: string,
    ) => Effect.Effect<void, RemoteAssetError>;
  }
>()("t3/agentRuntime/RemoteAssets") {}
const Origin = Schema.Struct({ workspaceId: Schema.String, virtualCwd: Schema.String });
export const layer = Layer.effect(
  RemoteAssets,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const sql = yield* SqlClient.SqlClient;
    const routes = yield* Routing.WorkspaceRouting;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const lock = yield* KeyedLock.make<string>();
    const cache = path.join(config.stateDir, "worker-assets");
    const mirrors = path.join(cache, "workspaces");
    const digest = (bytes: Uint8Array) =>
      crypto.digest("SHA-256", bytes).pipe(
        Effect.map((value) =>
          Array.from(value)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ),
      );
    const checkedRelative = (value: string) =>
      Effect.gen(function* () {
        if (
          path.isAbsolute(value) ||
          value.split(/[\\/]/).some((segment) => segment === "..") ||
          value.includes("\0")
        )
          return yield* new RemoteAssetError({ cause: "Asset escaped its registered workspace" });
        return value;
      });
    const download = (client: ExecutionClient, blob: typeof P.Blob.Type, destination: string) =>
      lock.withLock(
        destination,
        Effect.gen(function* () {
          const temporary = `${destination}.${blob.blobId}.part`;
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
          yield* fs.writeFile(temporary, new Uint8Array());
          yield* Effect.gen(function* () {
            for (let offset = 0; offset < blob.size;) {
              const chunk = yield* Effect.tryPromise(() =>
                client.transient("asset.read", {
                  blobId: blob.blobId,
                  ...(blob.leaseId ? { leaseId: blob.leaseId } : {}),
                  offset,
                  maxBytes: P.CHUNK_BYTES,
                }),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(P.ReadResult)));
              const bytes = yield* Effect.fromResult(Base64.decode(chunk.data));
              if (
                chunk.offset !== offset ||
                chunk.size !== blob.size ||
                bytes.length === 0 ||
                offset + bytes.length > blob.size
              )
                return yield* new RemoteAssetError({ cause: "Invalid asset transfer range" });
              yield* fs.writeFile(temporary, bytes, { flag: "a" });
              offset += bytes.length;
            }
            const actualDigest = yield* Effect.tryPromise(async () => {
              const hash = NodeCrypto.createHash("sha256");
              for await (const chunk of NodeFS.createReadStream(temporary)) {
                if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected media stream");
                hash.update(chunk);
              }
              return hash.digest("hex");
            });
            if (actualDigest !== blob.blobId)
              return yield* new RemoteAssetError({ cause: "Asset content digest mismatch" });
            yield* fs.rename(temporary, destination);
          }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
          return destination;
        }),
      );
    const snapshot = (client: ExecutionClient, source: string) =>
      Effect.tryPromise(() => client.call("asset.snapshot", { path: source })).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(P.Blob)),
        Effect.flatMap((blob) =>
          blob.size > P.MAX_BLOB_BYTES
            ? Effect.fail(
                new RemoteAssetError({
                  cause: "Preview asset exceeds the configured blob size limit",
                }),
              )
            : Effect.succeed(blob),
        ),
      );
    const releaseSnapshot = (client: ExecutionClient, blob: typeof P.Blob.Type) =>
      blob.leaseId
        ? Effect.tryPromise(() =>
            client.transient("asset.read", {
              blobId: blob.blobId,
              leaseId: blob.leaseId,
              offset: blob.size,
              maxBytes: 1,
            }),
          ).pipe(Effect.asVoid)
        : Effect.void;
    const mirrorFor = (workspaceId: string, virtualCwd: string) =>
      Effect.gen(function* () {
        const key = yield* digest(new TextEncoder().encode(`${workspaceId}\0${virtualCwd}`));
        const root = path.join(mirrors, key);
        yield* fs.makeDirectory(root, { recursive: true });
        const origins = path.join(cache, "origins");
        yield* fs.makeDirectory(origins, { recursive: true });
        const destination = path.join(origins, `${key}.json`);
        if (!(yield* fs.exists(destination))) {
          const temporary = `${destination}.${yield* crypto.randomUUIDv4}.part`;
          yield* fs.writeFileString(
            temporary,
            yield* Schema.encodeEffect(Schema.fromJsonString(Origin))({ workspaceId, virtualCwd }),
          );
          yield* fs
            .rename(temporary, destination)
            .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
        }
        return root;
      });
    const populate = (workspaceRoot: string, relativePath: string) =>
      Effect.gen(function* () {
        if (path.dirname(workspaceRoot) !== mirrors)
          return yield* new RemoteAssetError({
            cause: "No registered asset mirror owns this root",
          });
        const relative = yield* checkedRelative(relativePath);
        const destination = path.join(workspaceRoot, relative);
        if (yield* fs.exists(destination)) return;
        const origin = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Origin))(
          yield* fs.readFileString(
            path.join(cache, "origins", `${path.basename(workspaceRoot)}.json`),
          ),
        );
        const client = yield* runtime.forWorkspace(origin.workspaceId);
        const blob = yield* snapshot(client, path.join(origin.virtualCwd, relative));
        yield* download(client, blob, destination);
      }).pipe(Effect.mapError((cause) => new RemoteAssetError({ cause })));
    const prepare: RemoteAssets["Service"]["prepare"] = (input) =>
      Effect.gen(function* () {
        const resource = input.resource;
        if (
          resource._tag !== "workspace-file" &&
          resource._tag !== "media-file" &&
          resource._tag !== "draft-workspace-file" &&
          resource._tag !== "project-favicon"
        )
          return input;
        const virtualCwd = input.workspaceRoot ?? ("cwd" in resource ? resource.cwd : undefined);
        if (!virtualCwd)
          return yield* new RemoteAssetError({ cause: "Asset lacks a registered workspace" });
        const workspaceId =
          "threadId" in resource
            ? (yield* Bindings.read(resource.threadId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              )).workspaceId
            : (yield* routes.describeCwd(virtualCwd)).workspaceId;
        const requestedPath = "path" in resource ? resource.path : undefined;
        const isMedia =
          resource._tag === "media-file" ||
          (requestedPath !== undefined &&
            path.isAbsolute(requestedPath) &&
            !requestedPath.startsWith(`${virtualCwd}/`));
        const source =
          requestedPath === undefined
            ? undefined
            : path.isAbsolute(requestedPath)
              ? requestedPath
              : path.resolve(virtualCwd, requestedPath);
        const sourceKey =
          source === undefined
            ? undefined
            : yield* digest(new TextEncoder().encode(`${workspaceId}\0${source}`));
        const indexPath =
          sourceKey === undefined ? undefined : path.join(cache, "sources", `${sourceKey}.json`);
        let cached: typeof P.Blob.Type | undefined;
        if (isMedia && indexPath && (yield* fs.exists(indexPath))) {
          const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(P.Blob))(
            yield* fs.readFileString(indexPath),
          );
          if (
            path.basename(saved.name) === saved.name &&
            (yield* fs.exists(path.join(cache, "media", saved.blobId, saved.name)))
          )
            cached = saved;
        }
        const observed = yield* runtime.observeWorkspace(workspaceId).pipe(
          Effect.map((observation) => (observation.kind === "running" ? observation.client : null)),
          Effect.catch((cause) => (cached ? Effect.succeed(null) : Effect.fail(cause))),
        );
        const mirror = yield* mirrorFor(workspaceId, virtualCwd);
        const mediaResult = (destination: string): AssetInput => ({
          resource:
            resource._tag === "draft-workspace-file"
              ? { ...resource, cwd: mirror, path: destination }
              : "threadId" in resource
                ? { _tag: "media-file", threadId: resource.threadId, path: destination }
                : resource,
          workspaceRoot: mirror,
        });
        if (isMedia && cached && observed === null)
          return mediaResult(path.join(cache, "media", cached.blobId, cached.name));
        const client = observed ?? (yield* runtime.forWorkspace(workspaceId));
        if (resource._tag === "project-favicon") {
          const found = yield* Effect.tryPromise(() =>
            client.call("asset.favicon", {
              cwd: virtualCwd,
              ...(input.projectFaviconPath ? { preferred: input.projectFaviconPath } : {}),
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))));
          if (found === null)
            return {
              resource: { ...resource, cwd: mirror },
              workspaceRoot: mirror,
              projectCheckoutPending: true,
            };
          const blob = yield* snapshot(client, found);
          const destination = path.join(cache, "media", blob.blobId, path.basename(found));
          if (!(yield* fs.exists(destination))) yield* download(client, blob, destination);
          else yield* releaseSnapshot(client, blob);
          return {
            resource: { ...resource, cwd: mirror },
            workspaceRoot: mirror,
            projectFaviconPath: destination,
          };
        }
        const requested = resource.path;
        if (isMedia && source !== undefined) {
          const blob = yield* snapshot(client, source).pipe(
            Effect.catch((cause) => (cached ? Effect.succeed(cached) : Effect.fail(cause))),
          );
          const destination = path.join(cache, "media", blob.blobId, path.basename(source));
          if (!(yield* fs.exists(destination))) yield* download(client, blob, destination);
          else yield* releaseSnapshot(client, blob);
          if (indexPath) {
            yield* fs.makeDirectory(path.dirname(indexPath), { recursive: true });
            const temporary = `${indexPath}.${yield* crypto.randomUUIDv4}.part`;
            yield* fs.writeFileString(
              temporary,
              yield* Schema.encodeEffect(Schema.fromJsonString(P.Blob))({
                blobId: blob.blobId,
                size: blob.size,
                name: path.basename(source),
              }),
            );
            yield* fs.rename(temporary, indexPath);
          }
          return mediaResult(destination);
        }
        const relative = yield* checkedRelative(
          path.isAbsolute(requested) ? path.relative(virtualCwd, requested) : requested,
        );
        const blob = yield* snapshot(client, path.resolve(virtualCwd, relative));
        yield* download(client, blob, path.join(mirror, relative));
        return { resource: { ...resource, path: relative }, workspaceRoot: mirror };
      }).pipe(Effect.mapError((cause) => new RemoteAssetError({ cause })));
    return RemoteAssets.of({ enabled: true, prepare, populate });
  }),
);
