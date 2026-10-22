// @effect-diagnostics nodeBuiltinImport:off -- Content addresses for immutable native preference snapshots.
import { createPendingAttachmentId, attachmentRelativePath } from "../attachmentStore.ts";
import { receiveWorkerBlob } from "./workerBlobTransfer.ts";
import * as IdeExtensions from "./IdeExtensions.ts";
import * as NodeCrypto from "node:crypto";
import {
  SandboxIdeError,
  type IdeSetupState,
  type IdeSetupStage,
  type IdeSetupCommandInput,
  IdeSetupExport,
  SandboxIdePreferenceFiles,
  SandboxIdePreferencePath,
  SandboxIdePreferenceRead,
  type SandboxIdePreferenceResolveInput,
  type SandboxIdePreferenceStatus,
  SandboxIdeTarget,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import {
  defaultIdePreferences,
  mergeIdePreferences,
  portableIdePreference,
} from "./portableIdePreferences.ts";

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const Manifest = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  paths: Schema.Array(Schema.String),
});
const validPath = Schema.is(SandboxIdePreferencePath);
const decodeFiles = Schema.decodeUnknownEffect(SandboxIdePreferenceFiles);
const encodeBoolean = Schema.encodeEffect(Schema.fromJsonString(Schema.Boolean));
const encodeFiles = Schema.encodeSync(Schema.fromJsonString(SandboxIdePreferenceFiles));
const filesRevision = (files: SandboxIdePreferenceFiles) =>
  hash(
    encodeFiles(
      Object.fromEntries(
        Object.keys(files)
          .sort()
          .map((name) => [name, files[name] ?? ""]),
      ),
    ),
  );
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(SandboxIdePreferenceRead));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeObservation = Schema.decodeUnknownEffect(SandboxIdePreferenceRead);
const targetKey = Schema.encodeSync(Schema.fromJsonString(SandboxIdeTarget));
const failure = (cause: unknown) => new SandboxIdeError({ reason: "unavailable", cause });

export class IdeSetup extends Context.Service<
  IdeSetup,
  {
    readonly opening: (target: SandboxIdeTarget) => Effect.Effect<void>;
    readonly get: (target?: SandboxIdeTarget) => Effect.Effect<IdeSetupState, SandboxIdeError>;
    readonly manage: (input: IdeSetupCommandInput) => Effect.Effect<void, SandboxIdeError>;
    readonly export: (
      target: SandboxIdeTarget,
    ) => Effect.Effect<typeof IdeSetupExport.Type, SandboxIdeError>;
    readonly resolve: (
      input: SandboxIdePreferenceResolveInput,
    ) => Effect.Effect<void, SandboxIdeError>;
    readonly prepare: (client: ExecutionClient) => Effect.Effect<void, SandboxIdeError>;
    readonly sync: (client: ExecutionClient) => Effect.Effect<void, SandboxIdeError>;
    readonly status: (
      target: SandboxIdeTarget,
    ) => Effect.Effect<SandboxIdePreferenceStatus, SandboxIdeError>;
  }
>()("t3/agentRuntime/IdeSetup") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const atomicWrite = (input: Parameters<typeof writeFileStringAtomically>[0]) =>
    writeFileStringAtomically(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const config = yield* ServerConfig.ServerConfig;
  const runtime = yield* RuntimeClient.RuntimeClient;
  const extensions = yield* IdeExtensions.IdeExtensions;
  const lock = yield* Semaphore.make(1);
  const workspaces = yield* KeyedLock.make<string>();
  const directory = path.join(config.stateDir, "ide-preferences");
  const subscriptions = path.join(directory, "workspaces");
  const pointer = path.join(directory, "current.json");
  const previousPointer = path.join(directory, "previous.json");
  const management = path.join(directory, "management.json");
  let remembering = (yield* fs.exists(management))
    ? yield* fs
        .readFileString(management)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Boolean))))
    : true;
  yield* fs.makeDirectory(subscriptions, { recursive: true });
  const tracked = new Set<string>();
  const nextObservation = new Map<string, number>();
  const states = new Map<string, SandboxIdePreferenceStatus>();
  const localSettings = new Map<string, string>();
  const stages = new Map<string, IdeSetupStage>();
  const openingTargets = new Map<string, number>();
  const cursors = new Map<string, { incarnation: string; revision: string }>();
  for (const file of yield* fs.readDirectory(subscriptions)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const workspaceId = yield* fs
      .readFileString(path.join(subscriptions, file))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))));
    tracked.add(workspaceId);
  }
  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(pointer))) return defaultIdePreferences;
    const manifest = yield* fs.readFileString(pointer).pipe(Effect.flatMap(decodeManifest));
    const files: Record<string, string> = {};
    for (const name of manifest.paths) {
      if (!validPath(name)) return yield* failure("Invalid saved IDE preference path");
      files[name] = yield* fs.readFileString(
        path.join(directory, "revisions", manifest.revision, "User", name),
      );
    }
    return yield* decodeFiles(files);
  });
  const write = (files: SandboxIdePreferenceFiles) =>
    Effect.gen(function* () {
      const names = Object.keys(files).sort();
      if (names.length > 128 || Buffer.byteLength(encodeFiles(files)) > 2 * 1024 * 1024)
        return yield* failure("Saved IDE preferences exceed the size limit");
      const previous = (yield* fs.exists(pointer))
        ? (yield* fs.readFileString(pointer).pipe(Effect.flatMap(decodeManifest))).revision
        : null;
      const revision = hash(
        encodeFiles(Object.fromEntries(names.map((name) => [name, files[name] ?? ""]))),
      );
      if (previous === revision) return;
      for (const name of names) {
        const destination = path.join(directory, "revisions", revision, "User", name);
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* atomicWrite({ filePath: destination, contents: files[name] ?? "" });
      }
      if (previous !== null && previous !== revision)
        yield* atomicWrite({
          filePath: previousPointer,
          contents: yield* fs.readFileString(pointer),
        });
      yield* atomicWrite({
        filePath: pointer,
        contents: encodeManifest({ revision, paths: names }),
      });
      cursors.clear();
      const revisions = path.join(directory, "revisions");
      yield* fs.makeDirectory(revisions, { recursive: true });
      for (const candidate of yield* fs.readDirectory(revisions)) {
        if (/^[a-f0-9]{64}$/.test(candidate) && candidate !== revision && candidate !== previous)
          yield* fs
            .remove(path.join(revisions, candidate), { recursive: true })
            .pipe(Effect.ignore({ log: true }));
      }
    });
  const request = (client: ExecutionClient, method: string, input: unknown) =>
    Effect.tryPromise((signal) => client.transient(method, input, signal)).pipe(
      Effect.flatMap(decodeObservation),
    );
  const sync = (client: ExecutionClient) =>
    workspaces.withLock(
      client.identity.workspaceId,
      Effect.gen(function* () {
        const id = client.identity.workspaceId;
        yield* extensions.observe(client, remembering);
        const cursor = cursors.get(id);
        let observation = yield* request(
          client,
          "ide.preferences.read",
          cursor?.incarnation === client.identity.incarnation ? { after: cursor.revision } : {},
        );
        if (observation.snapshot === null) {
          const current = yield* runtime.observeWorkspace(id);
          if (current.kind !== "running" || !sameIdentity(client.identity, current.client.identity))
            return yield* failure("IDE preference worker changed");
          return;
        }
        if (observation.snapshot.baseline === null) {
          observation = yield* request(client, "ide.preferences.initialize", {
            files: yield* lock.withPermit(read),
          });
        }
        const snapshot = observation.snapshot;
        if (snapshot === null) return;
        localSettings.set(id, filesRevision(snapshot.files));
        if (!remembering) {
          states.set(id, { state: "saved", issues: snapshot.issues });
          return;
        }
        states.set(id, { state: "pending", issues: [] });
        const current = yield* runtime.observeWorkspace(id);
        if (current.kind !== "running" || !sameIdentity(client.identity, current.client.identity))
          return yield* failure("IDE preference worker changed");
        if (
          Object.keys(snapshot.files).length > 128 ||
          encodeSnapshot(observation).length > 4 * 1024 * 1024
        )
          return yield* failure("IDE preference snapshot is too large");
        if (snapshot.issues.some((issue) => issue.path === ""))
          return yield* failure("IDE preference observation is incomplete");
        for (const [name, text] of Object.entries(snapshot.files))
          if (portableIdePreference(name, text) !== text)
            return yield* failure("Invalid portable IDE preference");
        const merged = yield* lock.withPermit(
          Effect.gen(function* () {
            const saved = yield* read;
            const next = mergeIdePreferences(saved, snapshot);
            if (encodeFiles(next.files) !== encodeFiles(saved)) yield* write(next.files);
            return next;
          }),
        );
        const baseline = { ...snapshot.baseline };
        const unresolved = new Set(merged.issues.map((issue) => issue.path));
        for (const name of new Set([...Object.keys(baseline), ...Object.keys(snapshot.files)])) {
          if (unresolved.has(name)) continue;
          const value = snapshot.files[name];
          if (value === undefined) delete baseline[name];
          else baseline[name] = value;
        }
        const acknowledged = yield* request(client, "ide.preferences.acknowledge", {
          baseline: snapshot.baseline ?? {},
          files: baseline,
          issues: merged.issues.filter(
            (issue) => issue.reason === "conflict" || issue.reason === "import_required",
          ),
        });
        const next = acknowledged.snapshot;
        const pending =
          next !== null && encodeFiles(next.files) !== encodeFiles(next.baseline ?? {});
        const issues = next?.issues ?? merged.issues;
        states.set(id, {
          state: issues.length ? "needs_attention" : pending ? "pending" : "saved",
          issues,
        });
        const observedFilesUnchanged =
          next !== null &&
          encodeFiles(next.files) === encodeFiles(snapshot.files) &&
          encodeFiles(next.baseline ?? {}) === encodeFiles(baseline);
        if (observedFilesUnchanged)
          cursors.set(id, {
            incarnation: client.identity.incarnation,
            revision: acknowledged.revision,
          });
        else cursors.delete(id);
      }).pipe(
        Effect.mapError(failure),
        Effect.tapError(() =>
          Effect.sync(() =>
            states.set(client.identity.workspaceId, {
              state: "needs_attention",
              issues: [{ path: "", reason: "unavailable" }],
            }),
          ),
        ),
      ),
    );
  const prepare = (client: ExecutionClient) =>
    Effect.gen(function* () {
      const id = client.identity.workspaceId;
      if (!tracked.has(id)) {
        yield* atomicWrite({
          filePath: path.join(subscriptions, `${hash(id)}.json`),
          contents: encodeString(id),
        });
        tracked.add(id);
      }
      cursors.delete(id);
      nextObservation.delete(id);
      stages.set(id, "applying_settings");
      yield* sync(client);
      yield* workspaces.withLock(
        id,
        Effect.gen(function* () {
          const lifecycle = yield* Effect.tryPromise((signal) =>
            client.transient("ide.lifecycle.read", {}, signal),
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.String }))),
          );
          let incomplete = extensions.pending(id);
          if (lifecycle.state === "waiting") {
            stages.set(id, "restoring_extensions");
            yield* extensions.apply(client).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  incomplete = true;
                }),
              ),
            );
          }
          stages.set(id, "starting");
          yield* Effect.tryPromise((signal) =>
            client.call("ide.lifecycle.resume", {}, undefined, signal),
          );
          stages.set(id, incomplete ? "ready_with_errors" : "ready");
        }),
      );
    }).pipe(Effect.mapError(failure));
  yield* Effect.suspend(() =>
    Effect.forEach(
      tracked,
      (id) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if ((nextObservation.get(id) ?? 0) > now) return;
          nextObservation.set(id, now + 15_000);
          const current = yield* runtime.observeWorkspace(id);
          if (current.kind === "running") {
            yield* sync(current.client);
            nextObservation.delete(id);
          } else {
            cursors.delete(id);
            nextObservation.set(id, now + 60_000);
            states.set(id, { state: "offline", issues: [] });
          }
        }).pipe(Effect.catch(() => Effect.void)),
      { concurrency: 4, discard: true },
    ),
  ).pipe(Effect.repeat(Schedule.spaced("3 seconds")), Effect.forkScoped);
  const observedClient = (target: SandboxIdeTarget | undefined) =>
    Effect.gen(function* () {
      if (target === undefined) return yield* failure("Choose a sandbox for this operation");
      const observed = yield* "threadId" in target
        ? runtime.observeThread(target.threadId)
        : runtime.observeWorkspace(`t3:utility:project:${target.projectId}`);
      if (observed.kind !== "running") return yield* failure("IDE is offline");
      return observed.client;
    });
  const status = (target: SandboxIdeTarget) =>
    Effect.gen(function* () {
      const observed = yield* "threadId" in target
        ? runtime.observeThread(target.threadId)
        : runtime.observeWorkspace(`t3:utility:project:${target.projectId}`);
      if (observed.kind !== "running") return { state: "offline" as const, issues: [] };
      return (
        states.get(observed.client.identity.workspaceId) ?? {
          state: "not_opened" as const,
          issues: [],
        }
      );
    }).pipe(Effect.mapError(failure));
  const applyFiles = (client: ExecutionClient) =>
    Effect.gen(function* () {
      const observation = yield* request(client, "ide.preferences.read", { force: true });
      const files = yield* read;
      const snapshot = observation.snapshot;
      if (snapshot === null) return;
      for (const name of new Set([
        ...Object.keys(files),
        ...Object.keys(snapshot.files),
        ...Object.keys(snapshot.baseline ?? {}),
      ]))
        yield* request(client, "ide.preferences.resolve", { path: name, choice: "saved", files });
      cursors.delete(client.identity.workspaceId);
    });
  return IdeSetup.of({
    opening: (target) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          for (const [key, started] of openingTargets)
            if (now - started >= 120_000) openingTargets.delete(key);
          openingTargets.set(targetKey(target), now);
        }),
      ),
    get: (target) =>
      Effect.gen(function* () {
        const saved = yield* extensions.read;
        const files = yield* lock.withPermit(read);
        const previous = (yield* fs.exists(previousPointer))
          ? yield* fs.readFileString(previousPointer).pipe(Effect.flatMap(decodeManifest))
          : null;
        const observed =
          target === undefined
            ? null
            : yield* "threadId" in target
                ? runtime.observeThread(target.threadId)
                : runtime.observeWorkspace(`t3:utility:project:${target.projectId}`);
        const now = yield* Clock.currentTimeMillis;
        if (
          target &&
          observed?.kind === "running" &&
          stages.has(observed.client.identity.workspaceId)
        )
          openingTargets.delete(targetKey(target));
        const stage =
          observed?.kind === "running"
            ? (stages.get(observed.client.identity.workspaceId) ?? "not_opened")
            : target && now - (openingTargets.get(targetKey(target)) ?? 0) < 120_000
              ? "waking"
              : "not_opened";
        return {
          stage,
          remembering,
          settingsRevision: filesRevision(files),
          settingsMatch:
            observed?.kind === "running" && localSettings.has(observed.client.identity.workspaceId)
              ? localSettings.get(observed.client.identity.workspaceId) === filesRevision(files)
              : null,
          previousSettingsRevision: previous?.revision ?? null,
          extensions: saved.sources,
          build: saved.build,
          publishedRevision: saved.published?.revision ?? null,
          previousPublishedRevision: saved.previous?.revision ?? null,
          appliedRevision:
            observed?.kind === "running"
              ? extensions.applied(observed.client.identity.workspaceId)
              : null,
          preferences:
            target === undefined
              ? { state: "not_opened" as const, issues: [] }
              : yield* status(target),
        };
      }).pipe(Effect.mapError(failure)),
    export: (target) =>
      Effect.gen(function* () {
        const client = yield* observedClient(target);
        const files = yield* lock.withPermit(read);
        const saved = yield* extensions.read;
        const exported = yield* extensions.export(client, files);
        if (exported.bundlePath === null) return yield* failure("IDE export is missing");
        const source = exported.bundlePath;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ide-export-" });
        const blob = yield* Effect.tryPromise((signal) =>
          receiveWorkerBlob(client, source, temporary, signal),
        );
        const attachmentId = createPendingAttachmentId("tar");
        const relative = attachmentRelativePath({
          type: "file",
          id: attachmentId,
          name: "vscode-setup.tar",
          mimeType: "application/x-tar",
          sizeBytes: blob.size,
        });
        if (relative === null) return yield* failure("IDE export attachment is invalid");
        yield* fs.copyFile(
          path.join(temporary, blob.digest),
          path.join(config.attachmentsDir, relative),
        );
        return { files, extensions: saved.sources, attachmentId, ...exported };
      }).pipe(Effect.scoped, Effect.mapError(failure)),
    manage: ({ target, command }) =>
      Effect.gen(function* () {
        switch (command.kind) {
          case "remember":
            yield* lock.withPermit(
              Effect.gen(function* () {
                yield* atomicWrite({
                  filePath: management,
                  contents: yield* encodeBoolean(command.enabled),
                });
                remembering = command.enabled;
                cursors.clear();
              }),
            );
            return;
          case "reset_settings":
            yield* lock.withPermit(write(defaultIdePreferences));
            return;
          case "reset_extensions":
            yield* extensions.reset;
            return;
          case "retry":
            yield* extensions.retry;
            return;
          case "rollback_extensions":
            yield* extensions.rollback;
            return;
          case "rollback_settings":
            yield* lock.withPermit(
              Effect.gen(function* () {
                const manifest = yield* fs
                  .readFileString(previousPointer)
                  .pipe(Effect.flatMap(decodeManifest));
                const files: Record<string, string> = {};
                for (const name of manifest.paths) {
                  if (!validPath(name)) return yield* failure("Invalid saved path");
                  files[name] = yield* fs.readFileString(
                    path.join(directory, "revisions", manifest.revision, "User", name),
                  );
                }
                yield* write(files);
              }),
            );
            return;
          case "import_vsix":
            yield* extensions.importVsix(yield* observedClient(target), command.path);
            return;
          case "import": {
            const client = yield* observedClient(target);
            yield* workspaces.withLock(
              client.identity.workspaceId,
              lock.withPermit(
                Effect.gen(function* () {
                  const observation = yield* request(client, "ide.preferences.read", {
                    force: true,
                  });
                  const snapshot = observation.snapshot;
                  if (
                    snapshot === null ||
                    snapshot.issues.some(
                      (issue) => issue.reason !== "conflict" && issue.reason !== "import_required",
                    )
                  )
                    return yield* failure("Fix invalid native files before importing");
                  yield* write(snapshot.files);
                  yield* request(client, "ide.preferences.acknowledge", {
                    baseline: snapshot.baseline ?? {},
                    files: snapshot.files,
                    issues: [],
                  });
                  yield* extensions.import(client);
                }),
              ),
            );
            return;
          }
          case "apply": {
            const client = yield* observedClient(target);
            yield* sync(client);
            yield* workspaces.withLock(
              client.identity.workspaceId,
              Effect.gen(function* () {
                yield* Effect.tryPromise((signal) =>
                  client.call("ide.lifecycle.pause", {}, undefined, signal),
                );
                yield* lock.withPermit(applyFiles(client)).pipe(
                  Effect.andThen(extensions.apply(client, true)),
                  Effect.tap(() =>
                    Effect.sync(() => stages.set(client.identity.workspaceId, "ready")),
                  ),
                  Effect.tapError(() =>
                    Effect.sync(() => stages.set(client.identity.workspaceId, "ready_with_errors")),
                  ),
                  Effect.ensuring(
                    Effect.tryPromise((signal) =>
                      client.call("ide.lifecycle.resume", {}, undefined, signal),
                    ).pipe(Effect.ignore({ log: true })),
                  ),
                );
              }),
            );
            return;
          }
        }
      }).pipe(Effect.mapError(failure)),
    prepare,
    sync,
    resolve: (input) =>
      Effect.gen(function* () {
        const observed = yield* "threadId" in input.target
          ? runtime.observeThread(input.target.threadId)
          : runtime.observeWorkspace(`t3:utility:project:${input.target.projectId}`);
        if (observed.kind !== "running") return yield* failure("IDE is offline");
        yield* workspaces.withLock(
          observed.client.identity.workspaceId,
          lock.withPermit(
            Effect.gen(function* () {
              const files = yield* read;
              yield* request(observed.client, "ide.preferences.resolve", {
                path: input.path,
                choice: input.choice,
                files,
              });
              cursors.delete(observed.client.identity.workspaceId);
            }),
          ),
        );
        yield* sync(observed.client);
      }).pipe(Effect.mapError(failure)),
    status,
  });
});
export const layer = Layer.effect(IdeSetup, make);
