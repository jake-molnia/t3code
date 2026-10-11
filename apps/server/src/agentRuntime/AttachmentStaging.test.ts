import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Staging from "./AttachmentStaging.ts";
import { makeAssetExecutor } from "./worker/AssetExecutor.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "attachment-central-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer, { excludeTestServices: true })("attachment locality", (it) => {
  it.effect("verifies bytes in the worker and puts worker paths into reply-file answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const central = yield* ServerConfig.ServerConfig;
      const workerContext = yield* Layer.build(
        ServerConfig.layerTest(process.cwd(), { prefix: "attachment-worker-" }),
      );
      const workerConfig = Context.get(workerContext, ServerConfig.ServerConfig);
      const worker = yield* makeAssetExecutor.pipe(
        Effect.provideService(ServerConfig.ServerConfig, workerConfig),
      );
      const attachment = yield* Schema.decodeUnknownEffect(C.ChatFileAttachment)({
        type: "file",
        id: "thread-123e4567-e89b-12d3-a456-426614174000-txt",
        name: "answer.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      });
      const stored = resolveAttachmentPath({ attachmentsDir: central.attachmentsDir, attachment });
      if (stored === null) return yield* Effect.die("invalid fixture attachment");
      yield* fs.writeFileString(stored, "reply bytes!");
      const identity = {
        workspaceId: "workspace",
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
        call: async () => {
          throw new Error("Binary upload must not enter journal");
        },
        transient: (method, input) => Effect.runPromise(worker.execute(method, input)),
        events: async () => [],
        ack: async () => {},
        operationStatus: async () => ({ state: "missing" }),
        inspectIdentity: async () => identity,
      };
      const runtime = RuntimeClient.RuntimeClient.of({
        enabled: true,
        forThread: () => Effect.succeed(client),
        forWorkspace: () => Effect.succeed(client),
        forUtility: () => Effect.succeed(client),
        observeThread: () => Effect.succeed({ kind: "running", client }),
        observeWorkspace: () => Effect.succeed({ kind: "running", client }),
        sessionResidency: () => Effect.succeed(identity),
        rememberSession: () => Effect.void,
        getEventCursor: () => Effect.succeed(0),
        stop: () => Effect.void,
      });
      const staging = yield* Staging.AttachmentStaging.pipe(
        Effect.provide(Staging.layer),
        Effect.provideService(RuntimeClient.RuntimeClient, runtime),
      );
      const paths = yield* staging.stage(C.ThreadId.make("thread"), [attachment]);
      const workerPath = paths.get(attachment.id);
      expect(workerPath?.startsWith(workerConfig.attachmentsDir)).toBe(true);
      if (!workerPath) return yield* Effect.die("file was not staged");
      expect(yield* fs.readFileString(workerPath)).toBe("reply bytes!");
      const answer = yield* appendUserInputAttachmentPaths({
        answers: { q: "see file" },
        attachmentsByQuestionId: { q: [attachment] },
        attachmentsDir: central.attachmentsDir,
        stagedPaths: paths,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) =>
            path === workerPath
              ? Effect.die("Central must not stat the sandbox path")
              : fs.exists(path),
        }),
      );
      expect(answer.q).toContain(workerPath);
      expect(answer.q).not.toContain(central.attachmentsDir);
    }),
  );
});
