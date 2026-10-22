// @effect-diagnostics nodeBuiltinImport:off -- Real worker transport and durable central storage; native Nix is the external boundary.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IdeExtensionInventory, IdeExtensionSources } from "@t3tools/contracts";
import { createExecutionClient, type ExecutionClient } from "../execution/ExecutionClient.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import * as Config from "../config.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Extensions from "./IdeExtensions.ts";

const decodeAcknowledgement = Schema.decodeUnknownSync(
  Schema.Struct({
    baseline: IdeExtensionInventory,
    applied: Schema.NullOr(Schema.String),
  }),
);
const decodeBuildRequest = Schema.decodeUnknownSync(
  Schema.Struct({ sources: IdeExtensionSources }),
);
const decodeBlobRead = Schema.decodeUnknownSync(
  Schema.Struct({ offset: Schema.Number, maxBytes: Schema.Number }),
);
const decodeInstallRequest = Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.String }));

it.effect(
  "merges isolated native inventories, keeps a failed build unpublished, and restores durable state after central restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ide-extension-central-" });
      const clients = new Map<string, ExecutionClient>();
      let failBuild = false;
      let buildCount = 0;
      const create = (workspaceId: string, incarnation: string) =>
        Effect.gen(function* () {
          const journal = yield* Effect.acquireRelease(
            Effect.promise(() => openWorkerJournal(`${root}/${workspaceId}/${incarnation}.jsonl`)),
            (value) => Effect.promise(value.close),
          );
          const identity = {
            workspaceId,
            incarnation,
            allocationId: workspaceId,
            generation: 1,
            podUid: incarnation,
            protocolVersion: 1 as const,
          };
          let installed: IdeExtensionInventory = {};
          let privateIds: string[] = [];
          let baseline: IdeExtensionInventory | null = null;
          let applied: string | null = null;
          let bytes = Buffer.from("empty");
          const worker = createExecutionWorker({
            identity,
            token: "x".repeat(32),
            journal,
            execute: async (method, input) => {
              if (method === "ide.extensions.read")
                return { installed, baseline, applied, privateIds, provisioning: false };
              if (method === "ide.extensions.acknowledge") {
                const request = decodeAcknowledgement(input);
                baseline = request.baseline;
                applied = request.applied;
                return { installed, baseline, applied, privateIds, provisioning: false };
              }
              if (method === "ide.extensions.build") {
                buildCount++;
                if (failBuild) throw new Error("Nix failed");
                const request = decodeBuildRequest(input);
                bytes = Buffer.from(JSON.stringify(request.sources));
                return {
                  path: "/workspace/bundle.tar",
                  sources: request.sources,
                  flake: "native flake",
                  lock: "pinned lock",
                };
              }
              if (method === "asset.snapshot")
                return {
                  blobId: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                  size: bytes.length,
                  name: "bundle.tar",
                };
              if (method === "asset.read") {
                const request = decodeBlobRead(input);
                return {
                  data: bytes
                    .subarray(request.offset, request.offset + request.maxBytes)
                    .toString("base64"),
                  offset: request.offset,
                  size: bytes.length,
                };
              }
              if (method === "asset.stage") return { complete: true, path: "/workspace/staged" };
              if (method === "ide.extensions.install") {
                const request = decodeInstallRequest(input);
                applied = request.revision;
                return { revision: applied };
              }
              throw new Error(`Unexpected operation ${method}`);
            },
          });
          const client = createExecutionClient({
            identity,
            token: "x".repeat(32),
            endpoint: "http://worker",
            fetch: (url, init) => worker.handle(new Request(url, init)),
          });
          clients.set(workspaceId, client);
          return {
            client,
            edit: (next: IdeExtensionInventory, privateExtensions: string[] = []) => {
              installed = next;
              privateIds = privateExtensions;
            },
          };
        });
      const one = yield* create("root-one", "one");
      const two = yield* create("root-two", "two");
      yield* create("t3:utility:ide-extension-build", "builder");
      const runtime = Layer.mock(RuntimeClient.RuntimeClient)({
        enabled: true,
        forUtility: (id) =>
          Effect.sync(() => {
            const client = clients.get(`t3:utility:${id}`);
            if (!client) throw new Error("Unknown utility");
            return client;
          }),
        observeWorkspace: (id) =>
          Effect.sync(() => {
            const client = clients.get(id);
            if (!client) throw new Error("Unknown workspace");
            return { kind: "running" as const, client };
          }),
      });
      const layers = Extensions.layer.pipe(
        Layer.provide(runtime),
        Layer.provide(Config.layerTest(root, `${root}/central`)),
      );
      let published: string | null = null;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Extensions.IdeExtensions;
          one.edit({ "publisher.existing": "1.0.0" });
          yield* service.observe(one.client, true);
          expect((yield* service.read).sources).toHaveLength(0);
          yield* service.observe(two.client, true);
          one.edit({ "publisher.first": "1.0.0" });
          yield* service.observe(one.client, true);
          yield* service.reconcile;
          const ready = yield* service.read;
          expect(ready.build.state).toBe("ready");
          published = ready.published?.revision ?? null;
          expect(published).not.toBeNull();
          yield* service.observe(two.client, true);
          expect((yield* service.read).sources).toHaveLength(1);
          // A descendant uses the parent's client and baseline, not another path key.
          yield* service.observe(one.client, true);
          expect((yield* service.read).sources).toHaveLength(1);
          failBuild = true;
          two.edit({ "publisher.second": "2.0.0" });
          yield* service.observe(two.client, true);
          yield* service.reconcile;
          expect((yield* service.read).build.state).toBe("failed");
          expect((yield* service.read).published?.revision).toBe(published);
        }).pipe(Effect.provide(layers)),
      );
      failBuild = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Extensions.IdeExtensions;
          expect((yield* service.read).published?.revision).toBe(published);
          yield* service.retry;
          yield* service.reconcile;
          expect((yield* service.read).build.state).toBe("ready");
          expect((yield* service.read).sources).toHaveLength(2);
          yield* service.apply(one.client);
          expect(service.applied(one.client.identity.workspaceId)).toBe(
            (yield* service.read).published?.revision,
          );
          yield* service.rollback;
          expect((yield* service.read).published?.revision).toBe(published);
          const beforePrivateImport = (yield* service.read).sources;
          two.edit({ "publisher.first": "1.0.0" }, ["publisher.first"]);
          expect((yield* Effect.result(service.import(two.client)))._tag).toBe("Failure");
          expect((yield* service.read).sources).toEqual(beforePrivateImport);
          yield* service.observe(two.client, true);
          expect((yield* service.read).build).toMatchObject({
            state: "failed",
            reason: "archive_missing",
          });
          expect((yield* service.read).sources).toEqual(beforePrivateImport);
          yield* create("root-one", "replacement");
          expect((yield* Effect.result(service.observe(one.client, true)))._tag).toBe("Failure");
          expect(buildCount).toBe(3);
          two.edit({ "publisher.first": "1.0.0" });
          yield* service.import(two.client);
          expect((yield* service.read).sources).toEqual([
            { id: "publisher.first", version: "1.0.0", archive: null },
          ]);
        }).pipe(Effect.provide(layers)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
