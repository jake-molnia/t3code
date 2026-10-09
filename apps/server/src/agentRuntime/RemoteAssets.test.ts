import * as SqlClient from "effect/sql/SqlClient";
import * as RuntimeSchema from "./Schema.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as Assets from "./RemoteAssets.ts";
import * as P from "./worker/AssetProtocol.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "asset-central-" }),
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.layer(layer, { excludeTestServices: true })("remote asset publication", (it) => {
  it.effect(
    "reads the worker copy of an identical absolute path and retains media plus relative HTML resources",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        yield* RuntimeSchema.migrate;
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('a','thread')`;
        yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id,workspace_id) VALUES ('thread','a')`;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "central-trap-" });
        const samePath = path.join(temporary, "report.png");
        yield* fs.writeFileString(samePath, "CENTRAL MUST NOT BE READ");
        const files = new Map([
          [samePath, "WORKER IMAGE"],
          ["/workspace/a/repo/index.html", '<link rel="stylesheet" href="style.css">'],
          ["/workspace/a/repo/style.css", "body { color: red; }"],
        ]);
        const blobs = new Map<string, Uint8Array>();
        const manifests = new Map<string, typeof P.Blob.Type>();
        for (const [filename, text] of files) {
          const bytes = new TextEncoder().encode(text);
          const blobId = Array.from(yield* crypto.digest("SHA-256", bytes))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          blobs.set(blobId, bytes);
          manifests.set(filename, { blobId, size: bytes.length, name: path.basename(filename) });
        }
        let released = false;
        const requested: string[] = [];
        const identity = {
          workspaceId: "a",
          allocationId: "1",
          generation: 1,
          incarnation: "one",
          podUid: "pod",
          protocolVersion: 1,
        } satisfies ExecutionClient["identity"];
        const client: ExecutionClient = {
          credentialSource: () => {
            throw new Error("Credential sharing is unused in this fixture");
          },
          identity,
          call: async (method, input) => {
            if (released) throw new Error("worker released");
            if (method !== "asset.snapshot") throw new Error("unexpected command");
            const value = Schema.decodeUnknownSync(P.Snapshot)(input);
            requested.push(value.path);
            const blob = manifests.get(value.path);
            if (!blob) throw new Error("worker file missing");
            return blob;
          },
          transient: async (method, input) => {
            if (released) throw new Error("worker released");
            if (method !== "asset.read") throw new Error("unexpected transient operation");
            const value = Schema.decodeUnknownSync(P.Read)(input);
            const bytes = blobs.get(value.blobId);
            if (!bytes) throw new Error("blob missing");
            return {
              data: Base64.encode(bytes.subarray(value.offset, value.offset + value.maxBytes)),
              offset: value.offset,
              size: bytes.length,
            };
          },
          events: async () => [],
          ack: async () => {},
          operationStatus: async () => ({ state: "missing" }),
          inspectIdentity: async () => identity,
        };
        const runtime = RuntimeClient.RuntimeClient.of({
          enabled: true,
          forThread: () => Effect.succeed(client),
          forWorkspace: () =>
            released
              ? Effect.fail(
                  new RuntimeClient.RuntimeClientError({
                    operation: "ensure",
                    cause: "worker released",
                  }),
                )
              : Effect.succeed(client),
          forUtility: () => Effect.succeed(client),
          observeThread: () => Effect.succeed({ kind: "running", client }),
          observeWorkspace: () =>
            Effect.succeed(released ? { kind: "stopped" } : { kind: "running", client }),
          sessionResidency: () => Effect.succeed(identity),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        const built = yield* Layer.build(Assets.layer.pipe(Layer.provide(Routing.layer))).pipe(
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
        );
        const assets = Context.get(built, Assets.RemoteAssets);
        const media = yield* assets.prepare({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: samePath },
          workspaceRoot: "/workspace/a/repo",
        });
        if (media.resource._tag !== "media-file")
          return yield* Effect.die("expected media resource");
        expect(requested[0]).toBe(samePath);
        expect(yield* fs.readFileString(media.resource.path)).toBe("WORKER IMAGE");
        expect(yield* fs.readFileString(samePath)).toBe("CENTRAL MUST NOT BE READ");
        const html = yield* assets.prepare({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread"),
            path: "index.html",
          },
          workspaceRoot: "/workspace/a/repo",
        });
        if (!html.workspaceRoot) return yield* Effect.die("mirror missing");
        yield* assets.populate(html.workspaceRoot, "style.css");
        released = true;
        const renewed = yield* assets.prepare({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: samePath },
          workspaceRoot: "/workspace/a/repo",
        });
        expect(renewed.resource).toEqual(media.resource);
        yield* assets.populate(html.workspaceRoot, "style.css");
        expect(yield* fs.readFileString(path.join(html.workspaceRoot, "style.css"))).toContain(
          "color: red",
        );
        expect(yield* fs.readFileString(media.resource.path)).toBe("WORKER IMAGE");
      }),
  );
});
