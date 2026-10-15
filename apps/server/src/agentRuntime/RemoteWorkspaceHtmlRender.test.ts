import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerConfig from "../config.ts";
import * as RemoteHtml from "./RemoteWorkspaceHtmlRender.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";

const services = ServerConfig.layerTest(process.cwd(), { prefix: "remote-html-central-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(services, { excludeTestServices: true })("remote HTML publication", (it) => {
  it.effect(
    "inlines worker-only images before central publication and keeps the artifact after worker loss",
    () =>
      Effect.gen(function* () {
        const run = yield* captureRunPromise;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const workerRoot = yield* fs.makeTempDirectoryScoped({ prefix: "remote-html-worker-" });
        const image = path.join(workerRoot, "diagram.svg");
        yield* fs.writeFileString(
          image,
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        );
        const native = yield* Layer.build(
          HtmlRender.layer.pipe(
            Layer.provide(
              Layer.succeed(PreviewBrowser.PreviewBrowser, {
                installed: Effect.succeed(Option.none()),
                executable: Effect.die("No browser allowed in this test"),
              }),
            ),
          ),
        );
        const workerHtml = Context.get(native, HtmlRender.HtmlRender);
        const identity = {
          workspaceId: "html",
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
            if (method !== "html.prepare") throw new Error("unexpected operation");
            const decoded = Schema.decodeUnknownSync(Schema.Struct({ html: Schema.String }))(input);
            return run(workerHtml.prepare(decoded.html));
          },
          events: async () => [],
          ack: async () => {},
          operationStatus: async () => ({ state: "missing" }),
          inspectIdentity: async () => identity,
          transient: async () => null,
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
        let centralImageReads = 0;
        const centralFs: FileSystem.FileSystem = {
          ...fs,
          readFile: (filename) => {
            if (filename === image) {
              centralImageReads++;
              return Effect.die("Central cannot read sandbox image");
            }
            return fs.readFile(filename);
          },
        };
        const remoteContext = yield* Layer.build(RemoteHtml.layer).pipe(
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
          Effect.provideService(FileSystem.FileSystem, centralFs),
        );
        const publication = Context.get(remoteContext, HtmlRender.HtmlRender);
        const reference = yield* publication.publish({
          threadId: ThreadId.make("thread-html"),
          html: `<h1>Worker chart</h1><img src="${image}">`,
          title: "Chart",
          height: 400,
        });
        expect(centralImageReads).toBe(0);
        yield* fs.remove(image);
        const attachment = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: reference.attachmentId,
        });
        if (attachment === null) return yield* Effect.die("Attachment path invalid");
        const saved = yield* fs.readFileString(attachment);
        expect(saved).toContain("data:image/svg+xml;base64,");
        expect(saved).not.toContain(image);
        expect(saved).toContain("Worker chart");
      }),
  );
});
