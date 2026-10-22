// @effect-diagnostics nodeBuiltinImport:off -- Immutable extension source revisions are content addressed.
import * as NodeCrypto from "node:crypto";
import {
  IdeDigest,
  IdeExtensionSnapshot as Observation,
  IdeExtensionBuildResult as Built,
  IdeExtensionSources,
  IdeSetupBuild,
  SandboxIdeError,
  type SandboxIdePreferenceFiles,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Config from "../config.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { sameIdentity } from "../execution/ExecutionWorker.ts";
import { receiveWorkerBlob, sendWorkerBlob } from "./workerBlobTransfer.ts";

const Release = Schema.Struct({
  revision: IdeDigest,
  digest: IdeDigest,
  sources: IdeExtensionSources,
  flake: Schema.String,
  lock: Schema.String,
});
const State = Schema.Struct({
  attempt: Schema.Number,
  sources: IdeExtensionSources,
  build: IdeSetupBuild,
  published: Schema.NullOr(Release),
  previous: Schema.NullOr(Release),
});
const Inspected = Schema.Struct({ id: Schema.String, version: Schema.String });
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const decodeSources = Schema.decodeUnknownEffect(IdeExtensionSources);
const failure = (cause: unknown) => new SandboxIdeError({ reason: "unavailable", cause });
const revisionOf = (sources: typeof IdeExtensionSources.Type) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(sources)).digest("hex");

export class IdeExtensions extends Context.Service<
  IdeExtensions,
  {
    readonly read: Effect.Effect<typeof State.Type>;
    readonly reconcile: Effect.Effect<void>;
    readonly observe: (
      client: ExecutionClient,
      capture: boolean,
    ) => Effect.Effect<void, SandboxIdeError>;
    readonly apply: (
      client: ExecutionClient,
      replace?: boolean,
    ) => Effect.Effect<void, SandboxIdeError>;
    readonly import: (client: ExecutionClient) => Effect.Effect<void, SandboxIdeError>;
    readonly importVsix: (
      client: ExecutionClient,
      path: string,
    ) => Effect.Effect<void, SandboxIdeError>;
    readonly reset: Effect.Effect<void, SandboxIdeError>;
    readonly retry: Effect.Effect<void, SandboxIdeError>;
    readonly rollback: Effect.Effect<void, SandboxIdeError>;
    readonly applied: (workspaceId: string) => string | null;
    readonly pending: (workspaceId: string) => boolean;
    readonly export: (
      client: ExecutionClient,
      files: SandboxIdePreferenceFiles,
    ) => Effect.Effect<{ flake: string; lock: string; bundlePath: string | null }, SandboxIdeError>;
  }
>()("t3/agentRuntime/IdeExtensions") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const runtime = yield* RuntimeClient.RuntimeClient;
  const mutex = yield* Semaphore.make(1);
  const buildMutex = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "ide-extensions");
  const blobs = path.join(directory, "blobs");
  const pointer = path.join(directory, "current.json");
  yield* fs.makeDirectory(blobs, { recursive: true });
  let state: typeof State.Type = (yield* fs.exists(pointer))
    ? yield* fs
        .readFileString(pointer)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))))
    : { attempt: 0, sources: [], build: { state: "idle" }, published: null, previous: null };
  const applied = new Map<string, string | null>();
  const pending = new Set<string>();
  const write = (next: typeof State.Type) =>
    Effect.gen(function* () {
      const contents = yield* encodeState(next);
      if (contents === (yield* encodeState(state))) return;
      yield* writeFileStringAtomically({ filePath: pointer, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      state = next;
    });
  const updateSources = (sources: typeof IdeExtensionSources.Type) =>
    Effect.suspend(() => {
      const ordered = [...sources].sort((a, b) => a.id.localeCompare(b.id));
      const revision = revisionOf(ordered);
      return write({
        ...state,
        attempt: state.attempt + 1,
        sources: ordered,
        build: { state: "building", revision },
      });
    });
  const request = (client: ExecutionClient) =>
    Effect.tryPromise((signal) => client.transient("ide.extensions.read", {}, signal)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Observation)),
    );
  const currentIdentity = (client: ExecutionClient) =>
    Effect.gen(function* () {
      const current = yield* runtime.observeWorkspace(client.identity.workspaceId);
      if (current.kind !== "running" || !sameIdentity(current.client.identity, client.identity))
        return yield* failure("IDE worker changed");
    });
  const acknowledge = (client: ExecutionClient, snapshot: typeof Observation.Type) =>
    Effect.tryPromise((signal) =>
      client.transient(
        "ide.extensions.acknowledge",
        { baseline: snapshot.installed, applied: snapshot.applied },
        signal,
      ),
    );
  const observe = (client: ExecutionClient, capture: boolean) =>
    Effect.gen(function* () {
      const observed = yield* request(client);
      yield* currentIdentity(client);
      applied.set(client.identity.workspaceId, observed.applied);
      if (observed.provisioning) {
        pending.add(client.identity.workspaceId);
        return;
      }
      pending.delete(client.identity.workspaceId);
      if (observed.baseline === null) {
        // Enrollment establishes a baseline; importing existing extensions is explicit.
        yield* acknowledge(client, observed);
        return;
      }
      if (!capture) return;
      yield* mutex.withPermit(
        Effect.gen(function* () {
          const next = new Map(state.sources.map((source) => [source.id, source]));
          const baseline = observed.baseline ?? {};
          let conflict = false;
          let archiveMissing = false;
          let changed = false;
          for (const id of new Set([
            ...Object.keys(baseline),
            ...Object.keys(observed.installed),
          ])) {
            const before = baseline[id];
            const after = observed.installed[id];
            if (before === after) continue;
            const saved = next.get(id);
            if (
              after !== undefined &&
              observed.privateIds.includes(id) &&
              (saved?.version !== after || saved.archive === null)
            ) {
              archiveMissing = true;
              continue;
            }
            if (saved?.version !== before && saved?.version !== after) {
              conflict = true;
              continue;
            }
            if (after === undefined) next.delete(id);
            else
              next.set(id, {
                id,
                version: after,
                archive: saved?.version === after ? saved.archive : null,
              });
            changed = true;
          }
          if (conflict || archiveMissing) {
            yield* write({
              ...state,
              build: {
                state: "failed",
                revision: revisionOf(state.sources),
                reason: archiveMissing ? "archive_missing" : "conflict",
              },
            });
            return;
          }
          if (changed) yield* updateSources([...next.values()]);
          if (changed) yield* acknowledge(client, observed);
        }),
      );
    }).pipe(Effect.mapError(failure));

  const build = buildMutex
    .withPermit(
      Effect.gen(function* () {
        const intent = yield* mutex.withPermit(
          Effect.sync(() =>
            state.build.state === "building"
              ? {
                  revision: state.build.revision,
                  sources: state.sources,
                  attempt: state.attempt,
                  published: state.published,
                }
              : null,
          ),
        );
        if (intent === null) return;
        yield* Effect.gen(function* () {
          const client = yield* runtime.forUtility("ide-extension-build");
          const archives: Array<{ digest: string; path: string }> = [];
          for (const source of intent.sources) {
            if (source.archive === null) continue;
            const digest = source.archive;
            const staged = yield* Effect.tryPromise((signal) =>
              sendWorkerBlob(client, blobs, digest, signal),
            );
            archives.push({ digest, path: staged });
          }
          const publishedDigest = intent.published?.digest;
          const previous =
            publishedDigest === undefined
              ? null
              : {
                  digest: publishedDigest,
                  path: yield* Effect.tryPromise((signal) =>
                    sendWorkerBlob(client, blobs, publishedDigest, signal),
                  ),
                };
          const result = yield* Effect.tryPromise((signal) =>
            client.call(
              "ide.extensions.build",
              { revision: intent.revision, sources: intent.sources, archives, previous },
              `ide-build:${client.identity.incarnation}:${intent.revision}:${intent.attempt}`,
              signal,
            ),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Built)));
          const blob = yield* Effect.tryPromise((signal) =>
            receiveWorkerBlob(client, result.path, blobs, signal),
          );
          yield* currentIdentity(client);
          yield* mutex.withPermit(
            Effect.gen(function* () {
              if (
                state.build.state !== "building" ||
                state.build.revision !== intent.revision ||
                state.attempt !== intent.attempt
              )
                return;
              const revision = blob.digest;
              yield* write({
                ...state,
                sources: result.sources,
                build: { state: "ready", revision },
                previous: state.published?.revision === revision ? state.previous : state.published,
                published: {
                  revision,
                  digest: blob.digest,
                  sources: result.sources,
                  flake: result.flake,
                  lock: result.lock,
                },
              });
            }),
          );
        }).pipe(
          Effect.catch(() =>
            mutex.withPermit(
              Effect.gen(function* () {
                if (
                  state.build.state === "building" &&
                  state.build.revision === intent.revision &&
                  state.attempt === intent.attempt
                )
                  yield* write({
                    ...state,
                    build: { state: "failed", revision: intent.revision, reason: "build_failed" },
                  });
              }),
            ),
          ),
        );
      }),
    )
    .pipe(Effect.catch(() => Effect.logWarning("Saved IDE extension build could not be recorded")));
  yield* build.pipe(Effect.repeat(Schedule.spaced("3 seconds")), Effect.forkScoped);

  const apply = (client: ExecutionClient, replace = false) =>
    Effect.gen(function* () {
      const publication = state.published;
      if (publication === null) {
        yield* observe(client, false);
        return;
      }
      const current = yield* request(client);
      if (current.applied === publication.revision && !replace && !current.provisioning) return;
      const staged = yield* Effect.tryPromise((signal) =>
        sendWorkerBlob(client, blobs, publication.digest, signal),
      );
      yield* Effect.tryPromise((signal) =>
        client.call(
          "ide.extensions.install",
          { path: staged, digest: publication.digest, revision: publication.revision, replace },
          undefined,
          signal,
        ),
      );
      applied.set(client.identity.workspaceId, publication.revision);
      pending.delete(client.identity.workspaceId);
      if (replace)
        yield* mutex.withPermit(
          Effect.suspend(() =>
            state.build.state === "failed" &&
            (state.build.reason === "conflict" || state.build.reason === "archive_missing")
              ? updateSources(state.sources)
              : Effect.void,
          ),
        );
    }).pipe(Effect.mapError(failure));
  return IdeExtensions.of({
    read: Effect.sync(() => state),
    reconcile: build,
    observe,
    apply,
    applied: (workspaceId) => applied.get(workspaceId) ?? null,
    pending: (workspaceId) => pending.has(workspaceId),
    import: (client) =>
      Effect.gen(function* () {
        const observed = yield* request(client);
        yield* currentIdentity(client);
        yield* mutex.withPermit(
          Effect.gen(function* () {
            for (const id of observed.privateIds) {
              if (
                !state.sources.some(
                  (source) =>
                    source.id === id &&
                    source.version === observed.installed[id] &&
                    source.archive !== null,
                )
              )
                return yield* failure(
                  "Import the original private VSIX before importing this sandbox",
                );
            }
            yield* updateSources(
              Object.entries(observed.installed).map(([id, version]) => ({
                id,
                version,
                archive:
                  state.sources.find((source) => source.id === id && source.version === version)
                    ?.archive ?? null,
              })),
            );
          }),
        );
        yield* acknowledge(client, observed);
      }).pipe(Effect.mapError(failure)),
    importVsix: (client, source) =>
      Effect.gen(function* () {
        const blob = yield* Effect.tryPromise((signal) =>
          receiveWorkerBlob(client, source, blobs, signal),
        );
        const staged = yield* Effect.tryPromise((signal) =>
          sendWorkerBlob(client, blobs, blob.digest, signal),
        );
        const identity = yield* Effect.tryPromise((signal) =>
          client.call("ide.extensions.inspect", { path: staged }, undefined, signal),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Inspected)));
        const item = { ...identity, archive: blob.digest };
        yield* decodeSources([item]);
        yield* currentIdentity(client);
        yield* mutex.withPermit(
          Effect.suspend(() =>
            updateSources([...state.sources.filter((entry) => entry.id !== item.id), item]),
          ),
        );
      }).pipe(Effect.mapError(failure)),
    reset: mutex.withPermit(Effect.suspend(() => updateSources([]))).pipe(Effect.mapError(failure)),
    retry: mutex
      .withPermit(Effect.suspend(() => updateSources(state.sources)))
      .pipe(Effect.mapError(failure)),
    rollback: mutex
      .withPermit(
        Effect.gen(function* () {
          if (state.previous === null) return yield* failure("No previous extension release");
          yield* write({
            ...state,
            sources: state.previous.sources,
            published: state.previous,
            previous: state.published,
            build: { state: "ready", revision: state.previous.revision },
          });
        }),
      )
      .pipe(Effect.mapError(failure)),
    export: (client, files) =>
      Effect.gen(function* () {
        const publication = state.published;
        const bundle =
          publication === null
            ? null
            : {
                digest: publication.digest,
                path: yield* Effect.tryPromise((signal) =>
                  sendWorkerBlob(client, blobs, publication.digest, signal),
                ),
              };
        const result = yield* Effect.tryPromise((signal) =>
          client.transient("ide.extensions.export", { files, bundle }, signal),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))));
        return {
          flake: publication?.flake ?? "",
          lock: publication?.lock ?? "",
          bundlePath: result.path,
        };
      }).pipe(Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(IdeExtensions, make);
