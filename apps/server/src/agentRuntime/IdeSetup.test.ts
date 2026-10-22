// @effect-diagnostics nodeBuiltinImport:off -- Real worker transport and native files in disposable roots.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { SandboxIdeError, ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { openIdeExtensions } from "../execution/IdeExtensions.ts";
import { openIdePreferences } from "../execution/IdePreferences.ts";
import { createExecutionClient, type ExecutionClient } from "../execution/ExecutionClient.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as IdeExtensions from "./IdeExtensions.ts";
import * as Preferences from "./IdeSetup.ts";

it.effect(
  "syncs separate roots and inherited children, survives central restart, and rejects replaced workers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ide-central-" });
      const clients = new Map<string, ExecutionClient>();
      let observationFails = false;
      let preferencesFail = false;
      let pauseFails = false;
      let extensionPending = false;
      let waiting = false;
      let resumes = 0;
      let failTransfer = false;
      const exportBytes = Buffer.from("private VSIX export");
      const create = (workspaceId: string, incarnation: string) =>
        Effect.gen(function* () {
          const directory = `${root}/${workspaceId}/ide`;
          const preferences = yield* Effect.acquireRelease(
            Effect.promise(() => openIdePreferences(directory)),
            (value) => Effect.promise(value.close),
          );
          const nativeExtensions = yield* Effect.acquireRelease(
            Effect.promise(() => openIdeExtensions(directory, root)),
            (value) => Effect.promise(value.close),
          );
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
          let beforeAcknowledge = () => Promise.resolve();
          const worker = createExecutionWorker({
            identity,
            token: "s".repeat(32),
            journal,
            execute: async (method, input) => {
              if (method === "ide.extensions.releaseExport")
                return nativeExtensions.execute(method, input);
              if (method === "asset.snapshot") {
                if (failTransfer) throw new Error("Transfer unavailable");
                return {
                  blobId: NodeCrypto.createHash("sha256").update(exportBytes).digest("hex"),
                  size: exportBytes.length,
                  name: "vscode-setup.tar",
                };
              }
              if (method === "asset.read")
                return {
                  data: exportBytes.toString("base64"),
                  offset: 0,
                  size: exportBytes.length,
                };
              if (method === "ide.lifecycle.read") return { state: waiting ? "waiting" : "ready" };
              if (method === "ide.lifecycle.resume") resumes++;
              if (method === "ide.lifecycle.pause" && pauseFails)
                throw new Error("Pause response lost");
              if (method === "ide.preferences.read" && preferencesFail)
                throw new Error("Preference RPC failed");
              if (method === "ide.lifecycle.resume" || method === "ide.lifecycle.pause")
                return null;
              if (method === "ide.preferences.acknowledge") {
                const intercept = beforeAcknowledge;
                beforeAcknowledge = () => Promise.resolve();
                await intercept();
              }
              return preferences.execute(method, input);
            },
          });
          const client = createExecutionClient({
            identity,
            token: "s".repeat(32),
            endpoint: "http://worker",
            fetch: (url, init) => worker.handle(new Request(url, init)),
          });
          clients.set(workspaceId, client);
          return {
            client,
            journal,
            directory,
            interceptAcknowledgement: (intercept: () => Promise<void>) => {
              beforeAcknowledge = intercept;
            },
          };
        });
      const one = yield* create("one", "original");
      const two = yield* create("two", "original");
      const current = (id: string) => {
        const found = clients.get(id === "child" ? "one" : id);
        if (!found) throw new Error(`Unexpected workspace ${id}`);
        return found;
      };
      const runtime = RuntimeClient.RuntimeClient.of({
        enabled: true,
        forThread: (id) => Effect.succeed(current(id)),
        forWorkspace: (id) => Effect.succeed(current(id)),
        forUtility: (id) => Effect.succeed(current(id)),
        observeThread: (id) => Effect.succeed({ kind: "running", client: current(id) }),
        observeWorkspace: (id) => Effect.succeed({ kind: "running", client: current(id) }),
        sessionResidency: () => Effect.succeed(null),
        rememberSession: () => Effect.void,
        getEventCursor: () => Effect.succeed(0),
        stop: () => Effect.void,
      });
      const layers = Preferences.layer.pipe(
        Layer.provide(
          Layer.mock(IdeExtensions.IdeExtensions)({
            observe: () =>
              observationFails
                ? Effect.fail(new SandboxIdeError({ reason: "unavailable" }))
                : Effect.void,
            apply: () =>
              Effect.sync(() => {
                extensionPending = false;
              }),
            export: (client) =>
              Effect.gen(function* () {
                const directory = `${root}/${client.identity.workspaceId}/ide/exports`;
                yield* fs.makeDirectory(directory, { recursive: true });
                const bundlePath = `${directory}/vscode-setup-fixture.tar`;
                yield* fs.writeFile(bundlePath, exportBytes);
                return { bundlePath, flake: "", lock: "" };
              }).pipe(Effect.orDie),
            import: () => Effect.fail(new SandboxIdeError({ reason: "unavailable" })),
            applied: () => null,
            pending: () => extensionPending,
            read: Effect.succeed({
              attempt: 0,
              sources: [],
              build: { state: "idle" },
              published: null,
              previous: null,
            }),
          }),
        ),
        Layer.provide(Layer.succeed(RuntimeClient.RuntimeClient, runtime)),
        Layer.provide(ServerConfig.layerTest(root, `${root}/central`)),
      );
      const edit = (value: typeof one, text: string) =>
        Effect.promise(async () => {
          await NodeFSP.writeFile(`${value.directory}/user-data/User/settings.json`, text);
          await value.client.transient("ide.preferences.read", { force: true });
        });
      const initial = '{// preserved comment\n"editor.fontSize":18}';
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Preferences.IdeSetup;
          observationFails = true;
          yield* service.prepare(one.client);
          expect(resumes).toBe(1);
          expect((yield* service.get({ threadId: ThreadId.make("one") })).stage).toBe(
            "ready_with_errors",
          );
          observationFails = false;
          extensionPending = true;
          waiting = true;
          yield* service.prepare(one.client);
          expect((yield* service.get({ threadId: ThreadId.make("one") })).stage).toBe("ready");
          waiting = false;
          preferencesFail = true;
          const beforeRecovery = resumes;
          yield* service.prepare(one.client);
          expect(resumes).toBe(beforeRecovery + 1);
          expect((yield* service.get({ threadId: ThreadId.make("one") })).stage).toBe(
            "ready_with_errors",
          );
          expect((yield* service.status({ threadId: ThreadId.make("one") })).state).toBe(
            "needs_attention",
          );
          preferencesFail = false;
          pauseFails = true;
          const beforePauseFailure = resumes;
          expect(
            (yield* Effect.result(
              service.manage({
                target: { threadId: ThreadId.make("one") },
                command: { kind: "apply" },
              }),
            ))._tag,
          ).toBe("Failure");
          expect(resumes).toBe(beforePauseFailure + 1);
          pauseFails = false;
          yield* edit(one, initial);
          yield* service.sync(one.client);
          yield* service.prepare(two.client);
          expect(yield* fs.readFileString(`${two.directory}/user-data/User/settings.json`)).toBe(
            initial,
          );
          expect((yield* service.status({ threadId: ThreadId.make("child") })).state).toBe("saved");
          yield* edit(one, '{"editor.fontSize":20}');
          yield* service.sync(one.client);
          yield* edit(two, '{"editor.fontSize":22}');
          yield* service.sync(two.client);
          expect((yield* service.status({ threadId: ThreadId.make("two") })).issues).toContainEqual(
            { path: "settings.json", reason: "conflict" },
          );
          yield* service.resolve({
            target: { threadId: ThreadId.make("two") },
            path: "settings.json",
            choice: "saved",
          });
          expect(yield* fs.readFileString(`${two.directory}/user-data/User/settings.json`)).toBe(
            '{"editor.fontSize":20}',
          );
          expect(one.journal.operations.size).toBe(5);
          expect(two.journal.operations.size).toBe(1);
          // Applying must discard uncaptured local settings without importing them.
          const beforeImport = yield* service.get();
          yield* edit(one, '{"editor.fontSize":98}');
          const importBaseline = yield* Effect.promise(() =>
            one.client.transient("ide.preferences.read", { force: true }),
          );
          expect(
            (yield* Effect.result(
              service.manage({
                target: { threadId: ThreadId.make("one") },
                command: { kind: "import" },
              }),
            ))._tag,
          ).toBe("Failure");
          expect((yield* service.get()).settingsRevision).toBe(beforeImport.settingsRevision);
          expect(
            yield* Effect.promise(() =>
              one.client.transient("ide.preferences.read", { force: true }),
            ),
          ).toEqual(importBaseline);
          const beforeApply = yield* service.get();
          yield* edit(one, '{"editor.fontSize":');
          yield* service.manage({
            target: { threadId: ThreadId.make("one") },
            command: { kind: "apply" },
          });
          expect((yield* service.get()).settingsRevision).toBe(beforeApply.settingsRevision);
          expect(yield* fs.readFileString(`${one.directory}/user-data/User/settings.json`)).toBe(
            '{"editor.fontSize":20}',
          );

          // Hold a stale conflict acknowledgement while another root resolves it centrally.
          yield* edit(one, '{"editor.fontSize":21}');
          yield* service.sync(one.client);
          yield* edit(two, '{"editor.fontSize":22}');
          const acknowledging = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          two.interceptAcknowledgement(() => {
            acknowledging.resolve();
            return release.promise;
          });
          const stale = yield* service.sync(two.client).pipe(Effect.forkScoped);
          yield* Effect.promise(() => acknowledging.promise);
          yield* edit(one, '{"editor.fontSize":22}');
          yield* service.sync(one.client);
          release.resolve();
          yield* Fiber.join(stale);
          yield* service.sync(two.client);
          expect((yield* service.status({ threadId: ThreadId.make("two") })).issues).toEqual([]);
          const attachmentsDir = yield* Effect.gen(function* () {
            return (yield* ServerConfig.ServerConfig).attachmentsDir;
          }).pipe(Effect.provide(ServerConfig.layerTest(root, `${root}/central`)));
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          const exported = yield* service.export({ threadId: ThreadId.make("one") });
          expect(exported).not.toHaveProperty("bundlePath");
          expect(yield* fs.exists(`${one.directory}/exports/vscode-setup-fixture.tar`)).toBe(false);
          failTransfer = true;
          expect(
            (yield* Effect.result(service.export({ threadId: ThreadId.make("one") })))._tag,
          ).toBe("Failure");
          expect(yield* fs.exists(`${one.directory}/exports/vscode-setup-fixture.tar`)).toBe(false);
          failTransfer = false;
        }).pipe(Effect.provide(layers)),
      );
      // The central service is recreated while both worker transports remain alive.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Preferences.IdeSetup;
          const beforePause = yield* service.get();
          yield* service.manage({ command: { kind: "remember", enabled: false } });
          yield* edit(one, '{"editor.fontSize":24}');
          yield* service.sync(one.client);
          expect((yield* service.get()).settingsRevision).toBe(beforePause.settingsRevision);
          expect((yield* service.status({ threadId: ThreadId.make("one") })).state).toBe("paused");
          yield* edit(one, '{"unfinished":');
          yield* service.sync(one.client);
          expect((yield* service.status({ threadId: ThreadId.make("one") })).state).toBe(
            "needs_attention",
          );
          yield* edit(one, '{"editor.fontSize":24}');
          yield* service.manage({ command: { kind: "remember", enabled: true } });
          yield* service.sync(one.client);
          const replacement = yield* create("one", "replacement");
          expect((yield* service.sync(one.client).pipe(Effect.exit))._tag).toBe("Failure");
          const beforeStalePrepare = resumes;
          expect((yield* Effect.result(service.prepare(one.client)))._tag).toBe("Failure");
          expect(resumes).toBe(beforeStalePrepare);
          yield* service.sync(replacement.client);
          const three = yield* create("three", "new");
          yield* service.prepare(three.client);
          expect(yield* fs.readFileString(`${three.directory}/user-data/User/settings.json`)).toBe(
            '{"editor.fontSize":24}',
          );
          expect((yield* service.status({ threadId: ThreadId.make("child") })).state).toBe("saved");
          const beforeReset = yield* service.get();
          yield* service.manage({ command: { kind: "reset_settings" } });
          yield* service.manage({ command: { kind: "reset_settings" } });
          expect((yield* service.get()).settingsRevision).not.toBe(beforeReset.settingsRevision);
          yield* service.manage({ command: { kind: "rollback_settings" } });
          expect((yield* service.get()).settingsRevision).toBe(beforeReset.settingsRevision);
          yield* Effect.promise(async () => {
            await NodeFSP.rm(`${replacement.directory}/user-data/User/settings.json`);
            await replacement.client.transient("ide.preferences.read", { force: true });
          });
          yield* service.sync(replacement.client);
          const deletedRevision = (yield* service.get()).settingsRevision;
          yield* edit(two, '{"editor.fontSize":22,"git.path":"/local/git"}');
          yield* service.manage({
            target: { threadId: ThreadId.make("two") },
            command: { kind: "apply" },
          });
          yield* service.sync(two.client);
          expect((yield* service.get()).settingsRevision).toBe(deletedRevision);
          expect(
            yield* fs.readFileString(`${two.directory}/user-data/User/settings.json`),
          ).toContain("/local/git");
        }).pipe(Effect.provide(layers)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
