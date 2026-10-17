// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real worker HTTP boundary and retained Git repository.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as C from "@t3tools/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointCapture from "../orchestration-v2/CheckpointCaptureService.ts";
import * as RunFinalization from "../orchestration-v2/RunFinalizationService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectFile from "../project/T3ProjectFileLoader.ts";
import * as RepositoryFiles from "../git/RepositoryFiles.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import { WorkspaceActivity, WorkspaceRecentActivity } from "./WorkspaceActivity.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as RemoteProcess from "./RemoteVcsProcess.ts";
import * as Remote from "./RemoteGitDriver.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { fileSystemLayer } from "./RemoteWorkspaceServices.ts";
import { makeWorkspaceExecutor } from "./worker/WorkspaceExecutor.ts";
import { makeGitDriverExecutor } from "./worker/GitDriverExecutor.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";

const workspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const services = Layer.mergeAll(
  workspaceEntries,
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(Layer.merge(WorkspacePaths.layer, workspaceEntries)),
  ),
  CheckpointStore.layer.pipe(Layer.provide(Registry.layer.pipe(Layer.provide(VcsProcess.layer)))),
  Git.layer,
  Registry.layer,
  ProcessRunner.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(
  Layer.provideMerge(ProjectFile.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "remote-git-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(services, { excludeTestServices: true })("remote Git HTTP", (it) => {
  it.effect(
    "commits with hooks, pushes, reads reviews and instructions, and owns worktrees across central routing rebuilds",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const native = yield* Git.GitVcsDriver;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "remote-git-worker-" });
        const repo = path.join(root, "allocation/repo");
        const bare = path.join(root, "origin.git");
        yield* fs.makeDirectory(repo, { recursive: true });
        const run = (args: string[], cwd = repo) =>
          native.execute({ operation: "fixture", cwd, args });
        yield* run(["init", "--bare", bare]);
        yield* run(["init", "-b", "main"]);
        yield* run(["config", "user.email", "worker@example.test"]);
        yield* run(["config", "user.name", "Worker Test"]);
        yield* run(["remote", "add", "origin", bare]);
        yield* fs.writeFileString(path.join(repo, "README.md"), "first\n");
        yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "Keep this worker instruction.\n");
        yield* run(["add", "."]);
        yield* run(["commit", "-m", "initial"]);
        yield* run(["push", "-u", "origin", "main"]);
        yield* run(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
        yield* run(["remote", "set-head", "origin", "main"]);
        const bodyFile = path.join(root, "t3code-pr-body-test.md");
        yield* fs.writeFileString(bodyFile, "review body transferred to worker");
        const cli = path.join(root, "source-control-cli");
        yield* fs.writeFileString(cli, '#!/bin/sh\ncat "${1#description=@}"\n');
        yield* fs.chmod(cli, 0o755);
        const initial = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
        yield* fs.writeFileString(
          path.join(repo, ".git/hooks/pre-commit"),
          "#!/bin/sh\necho hook-observed\n",
        );
        yield* fs.chmod(path.join(repo, ".git/hooks/pre-commit"), 0o755);
        const identity = {
          workspaceId: "git-workspace",
          allocationId: "one",
          generation: 1,
          incarnation: "one",
          podUid: "one",
          protocolVersion: 1,
        } satisfies ExecutionClient["identity"];
        const token = "git-test-token-with-more-than-thirty-two-characters";
        const journal = yield* Effect.acquireRelease(
          Effect.tryPromise(() => openWorkerJournal(path.join(root, "journal"))),
          (value) => Effect.promise(() => value.close()),
        );
        const runPromise = yield* captureRunPromise;
        let publish: (id: string, event: unknown) => Promise<void>;
        const executor = yield* makeGitDriverExecutor({
          resolve: (cwd) => Effect.succeed(path.resolve(root, cwd)),
          publish: (id, event) =>
            Effect.promise(() => publish(`git:${id}`, event)).pipe(Effect.asVoid),
        });
        const workspaceExecutor = yield* makeWorkspaceExecutor({
          root,
          incarnation: identity.incarnation,
        });
        const makeWorker = (workerIdentity: ExecutionClient["identity"]) =>
          createExecutionWorker({
            identity: workerIdentity,
            token,
            journal,
            execute: (method, input) =>
              runPromise(
                method.startsWith("git.driver.") || method.startsWith("vcs.")
                  ? executor.execute(method, input)
                  : workspaceExecutor.execute(method, input),
              ),
          });
        const worker = makeWorker(identity);
        let servingWorker = worker;
        publish = worker.publish;
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({
              host: "127.0.0.1",
              port: 0,
              handle: (request) => servingWorker.handle(request),
            }),
          ),
          (value) => Effect.promise(() => value.close()),
        );
        const client = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
        });
        let activeClient = client;
        let ensureCalls = 0;
        let observeCalls = 0;
        let observedRunning = true;
        const runtime = RuntimeClient.RuntimeClient.of({
          enabled: true,
          forThread: () => Effect.succeed(client),
          forWorkspace: () =>
            Effect.sync(() => {
              ensureCalls++;
              observedRunning = true;
              return activeClient;
            }),
          forUtility: () =>
            Effect.sync(() => {
              ensureCalls++;
              return client;
            }),
          observeThread: () => Effect.succeed({ kind: "running", client }),
          observeWorkspace: () =>
            Effect.sync(() => {
              observeCalls++;
              return observedRunning
                ? { kind: "running" as const, client: activeClient }
                : { kind: "stopped" as const };
            }),
          sessionResidency: () => Effect.succeed(identity),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        yield* RuntimeSchema.migrate;
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('git-workspace','owner')`;
        yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,utility_key) VALUES ('/workspace/allocation/repo','git-workspace','allocation/repo','test')`;
        const build = Layer.build(
          Layer.merge(
            Remote.registryLayer.pipe(Layer.provideMerge(Remote.layer)),
            RemoteProcess.layer,
          ).pipe(Layer.provideMerge(Routing.layer)),
        ).pipe(
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (target) =>
              target === bodyFile
                ? fs.readFileString(target)
                : Effect.die("central repository read"),
            realPath: () => Effect.die("central repository realpath"),
          }),
        );
        const central = yield* build;
        const git = Context.get(central, Git.GitVcsDriver);
        const cwd = "/workspace/allocation/repo";
        yield* run(["tag", "release-test"]);
        yield* run(["update-ref", "refs/remotes/origin/remote-only", initial]);
        expect(yield* git.resolveBranchName(cwd, "main")).toBe("main");
        expect(yield* git.resolveBranchName(cwd, "refs/remotes/origin/main")).toBe("main");
        expect(yield* git.resolveBranchName(cwd, "remote-only")).toBe("remote-only");
        expect(yield* git.resolveBranchName(cwd, "release-test")).toBeNull();
        expect(yield* git.resolveBranchName(cwd, initial)).toBeNull();
        expect(yield* git.resolveBranchName(cwd, "missing-branch")).toBeNull();
        expect(
          yield* Context.get(central, RepositoryFiles.RepositoryFiles).readInstructions(
            cwd,
            "AGENTS.md",
          ),
        ).toBe("Keep this worker instruction.");
        const process = Context.get(central, VcsProcess.VcsProcess);
        expect(
          (yield* process.run({
            command: "git",
            args: ["rev-parse", "HEAD"],
            cwd,
            operation: "source-control",
          })).stdout.trim(),
        ).toBe(initial);
        expect(
          (yield* process.run({
            command: cli,
            args: [`description=@${bodyFile}`],
            cwd,
            operation: "source-control-create-pr",
          })).stdout,
        ).toBe("review body transferred to worker");
        yield* fs.makeDirectory(path.join(root, "bin"));
        yield* fs.writeFileString(
          path.join(root, "bin/gh"),
          "#!/bin/sh\necho credential-probe-sentinel\n",
        );
        yield* fs.chmod(path.join(root, "bin/gh"), 0o755);
        expect(
          (yield* process.run({
            command: "gh",
            args: ["auth", "token"],
            env: { PATH: `${path.join(root, "bin")}:${globalThis.process.env.PATH}` },
            cwd,
            operation: "credential-probe",
          })).stdout.trim(),
        ).toBe("credential-probe-sentinel");
        expect(yield* fs.readFileString(path.join(root, "journal"))).not.toContain(
          "credential-probe-sentinel",
        );
        const denied = yield* Effect.tryPromise(() =>
          client.transient("vcs.process.probe", {
            command: "git",
            args: ["init"],
            cwd: "allocation/repo",
            operation: "denied",
            attachments: [],
          }),
        ).pipe(Effect.exit);
        expect(denied._tag).toBe("Failure");
        const routes = Context.get(central, Routing.WorkspaceRouting);
        const active = yield* WorkspaceActivity;
        const recent = yield* WorkspaceRecentActivity;
        yield* fs.writeFileString(path.join(repo, "untracked.txt"), "one\ntwo\n");
        const beforeEnsure = ensureCalls;
        const beforeRecent = recent.get(identity.workspaceId);
        // GitManager builds caches outside observation scopes. Cache lookups must
        // retain the reading fiber's routing context, including their loader fibers.
        const statusCache = yield* Cache.make({
          capacity: 1,
          lookup: (cwd: string) => git.statusDetailsLocal(cwd, { includeBranchChanges: true }),
        });
        const observedStatus = yield* routes.observe(
          cwd,
          Effect.gen(function* () {
            expect(active.get(identity.workspaceId)).toBeGreaterThan(0);
            const details = yield* Cache.get(statusCache, cwd);
            expect(
              (yield* process.run({
                command: "gh",
                args: ["auth", "token"],
                env: { PATH: `${path.join(root, "bin")}:${globalThis.process.env.PATH}` },
                cwd: "/",
                operation: "passive-credential-probe",
              })).stdout.trim(),
            ).toBe("credential-probe-sentinel");
            expect(
              (yield* process.run({
                command: "git",
                args: ["rev-parse", "--git-dir"],
                cwd,
                operation: "passive-read",
              })).exitCode,
            ).toBe(0);
            return details;
          }),
        );
        expect(observedStatus?.branchChanges).toMatchObject({ insertions: 2, deletions: 0 });
        expect(ensureCalls).toBe(beforeEnsure);
        expect(recent.get(identity.workspaceId)).toBe(beforeRecent);
        expect(active.has(identity.workspaceId)).toBe(false);
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('other-workspace','other-owner')`;
        yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,utility_key) VALUES ('/workspace/other/repo','other-workspace','allocation/repo','other')`;
        expect(
          (yield* routes
            .observe(cwd, routes.clientForCwd("/workspace/other/repo"))
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* routes
            .observe(cwd, git.statusDetailsLocal("/workspace/other/repo"))
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(active.has(identity.workspaceId)).toBe(false);
        expect(ensureCalls).toBe(beforeEnsure);
        expect(recent.get(identity.workspaceId)).toBe(beforeRecent);
        observedRunning = false;
        expect(
          yield* routes.observe(cwd, Effect.die("stopped worker must not be read")),
        ).toBeNull();
        expect(ensureCalls).toBe(beforeEnsure);
        yield* git.statusDetailsLocal(cwd, { includeBranchChanges: true });
        expect(ensureCalls).toBeGreaterThan(beforeEnsure);
        const checkpoints = yield* CheckpointService.CheckpointServiceV2.pipe(
          Effect.provide(
            CheckpointService.layer.pipe(
              Layer.provide(Layer.fresh(CheckpointStore.layer)),
              Layer.provide(IdAllocator.layer),
              Layer.provide(Layer.succeedContext(central)),
            ),
          ),
        );
        const checkpointScope: C.OrchestrationV2CheckpointScope = {
          id: C.CheckpointScopeId.make("remote-finalization"),
          threadId: C.ThreadId.make("owner"),
          runId: C.RunId.make("finalizing-run"),
          nodeId: C.NodeId.make("finalizing-node"),
          parentScopeId: null,
          providerThreadId: C.ProviderThreadId.make("provider-thread"),
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd,
          createdAt: yield* DateTime.now,
        };
        const remoteFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem.pipe(
          Effect.provide(fileSystemLayer),
          Effect.provide(central),
        );
        let captures = 0;
        let refreshes = 0;
        let captureActive = false;
        let refreshActive = false;
        const finalizationDependencies = Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [checkpointScope],
              }),
          }),
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: (input) =>
              checkpoints
                .capture({
                  scope: checkpointScope,
                  runId: input.runId,
                  nodeId: C.NodeId.make("finalizing-node"),
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  capturedAt: checkpointScope.createdAt,
                })
                .pipe(
                  Effect.tap((checkpoint) =>
                    Effect.sync(() => {
                      expect(checkpoint.status).toBe("ready");
                      captureActive = (active.get(identity.workspaceId) ?? 0) > 0;
                      captures++;
                    }),
                  ),
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new CheckpointCapture.CheckpointCaptureExecutionError({
                        ...input,
                        cause,
                      }),
                  ),
                ),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refreshAfterTurn: () => Effect.void,
            refresh: () =>
              Effect.gen(function* () {
                refreshActive = (active.get(identity.workspaceId) ?? 0) > 0;
                const status = yield* routes.observe(
                  cwd,
                  routes.execute(cwd, Cache.get(statusCache, cwd)),
                );
                expect(status?.isRepo).toBe(true);
                expect(
                  yield* Context.get(central, RepositoryFiles.RepositoryFiles).readInstructions(
                    cwd,
                    "AGENTS.md",
                  ),
                ).toBe("Keep this worker instruction.");
                expect(
                  (yield* remoteFiles.readFile({
                    cwd,
                    relativePath: "AGENTS.md",
                    passive: true,
                  })).contents,
                ).toBe("Keep this worker instruction.\n");
                refreshes++;
              }).pipe(
                Effect.mapError(
                  (cause) => new RunFinalization.RunFinalizationRefreshError({ cwd, cause }),
                ),
              ),
          }),
        );
        const finalizer = yield* RunFinalization.RunFinalizationService.pipe(
          Effect.provide(
            RunFinalization.layer.pipe(
              Layer.provide(finalizationDependencies),
              Layer.provide(Layer.succeedContext(central)),
            ),
          ),
        );
        const beforeFinalization = ensureCalls;
        yield* finalizer.finalize({
          threadId: checkpointScope.threadId,
          runId: C.RunId.make("finalizing-run"),
          scopeId: checkpointScope.id,
        });
        expect(captures).toBe(1);
        expect(refreshes).toBe(1);
        expect(ensureCalls - beforeFinalization).toBe(1);
        expect(captureActive).toBe(true);
        expect(refreshActive).toBe(true);
        expect(active.has(identity.workspaceId)).toBe(false);
        yield* sql`INSERT INTO agent_runtime_thread_bindings(thread_id,workspace_id) VALUES ('owner','git-workspace'),('other-owner','other-workspace')`;
        const beforeNested = ensureCalls;
        const beforeNestedObservations = observeCalls;
        const read = { cwd, method: "files.read", input: { relativePath: "AGENTS.md" } };
        yield* routes.execute(
          cwd,
          Effect.gen(function* () {
            expect(yield* routes.observeCall(read)).toMatchObject({
              contents: "Keep this worker instruction.\n",
            });
            expect(
              yield* routes.callThread(C.ThreadId.make("owner"), "files.read", {
                cwd,
                relativePath: "AGENTS.md",
              }),
            ).toMatchObject({ contents: "Keep this worker instruction.\n" });
            for (const action of [
              routes.execute("/workspace/other/repo", Effect.void),
              routes.observeCall({ ...read, cwd: "/workspace/other/repo" }),
              routes.callThread(C.ThreadId.make("other-owner"), "files.read", {
                cwd: "/workspace/other/repo",
                relativePath: "AGENTS.md",
              }),
            ])
              expect((yield* action.pipe(Effect.exit))._tag).toBe("Failure");
            expect(active.has("other-workspace")).toBe(false);
          }),
        );
        expect(ensureCalls - beforeNested).toBe(1);
        expect(observeCalls).toBe(beforeNestedObservations);
        expect(active.has(identity.workspaceId)).toBe(false);
        const beforePassiveExecute = ensureCalls;
        const beforePassiveRecent = recent.get(identity.workspaceId);
        yield* routes.observe(cwd, routes.execute(cwd, routes.observeCall(read)));
        expect(ensureCalls).toBe(beforePassiveExecute);
        expect(recent.get(identity.workspaceId)).toBe(beforePassiveRecent);
        const beforeReplacement = ensureCalls;
        const replacementIdentity = {
          ...identity,
          generation: 2,
          incarnation: "replacement",
          podUid: "replacement",
        };
        const failed = yield* routes
          .execute(
            cwd,
            Effect.gen(function* () {
              servingWorker = makeWorker(replacementIdentity);
              activeClient = createExecutionClient({
                identity: replacementIdentity,
                token,
                endpoint: `http://127.0.0.1:${server.port}`,
              });
              return yield* routes.call(read);
            }),
          )
          .pipe(Effect.exit);
        expect(failed._tag).toBe("Failure");
        expect(ensureCalls - beforeReplacement).toBe(1);
        expect(active.has(identity.workspaceId)).toBe(false);
        const replacementRoutes = Context.get(yield* build, Routing.WorkspaceRouting);
        expect(yield* replacementRoutes.execute(cwd, replacementRoutes.call(read))).toMatchObject({
          contents: "Keep this worker instruction.\n",
        });
        expect(ensureCalls - beforeReplacement).toBe(2);
        expect(active.has(identity.workspaceId)).toBe(false);
        servingWorker = worker;
        activeClient = client;
        observedRunning = true;
        yield* fs.remove(path.join(repo, "untracked.txt"));
        // Review guides need concurrent detached copies of the same commit in
        // their originating sandbox, with paths usable by later text generation.
        const guides = yield* Effect.all(
          [0, 1].map(() =>
            git.createWorktree(
              { cwd, refName: initial, path: null },
              { detached: true, submodules: "none", worktreesDirectory: "/head-only/worktrees" },
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(guides[0]!.worktree.path).not.toBe(guides[1]!.worktree.path);
        for (const { worktree } of guides) {
          expect(worktree.path.startsWith("/workspace/allocation/")).toBe(true);
          expect((yield* routes.clientForCwd(worktree.path)).identity.workspaceId).toBe(
            identity.workspaceId,
          );
          expect((yield* git.statusDetailsLocal(worktree.path)).branch).toBeNull();
          expect(
            (yield* git.resolveCommit({ cwd: worktree.path, revision: "HEAD" })).commitSha,
          ).toBe(initial);
          expect(
            yield* Context.get(central, RepositoryFiles.RepositoryFiles).readInstructions(
              worktree.path,
              "AGENTS.md",
            ),
          ).toBe("Keep this worker instruction.");
          yield* git.removeWorktree({ cwd, path: worktree.path, force: true });
          expect((yield* routes.clientForCwd(worktree.path).pipe(Effect.exit))._tag).toBe(
            "Failure",
          );
          expect(yield* fs.exists(path.join(root, worktree.path.slice("/workspace/".length)))).toBe(
            false,
          );
        }
        expect((yield* git.statusDetailsLocal(cwd)).branch).toBe("main");
        expect(
          (yield* git
            .createWorktree(
              { cwd, refName: initial, newRefName: "must-not-exist", path: null },
              { detached: true },
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* git.listLocalBranchNames(cwd)).not.toContain("must-not-exist");
        const temporary = yield* routes
          .call({ cwd, method: "vcs.temp.create", input: {} })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)));
        yield* process.run({
          command: "git",
          args: ["init", "--quiet"],
          cwd: temporary,
          operation: "temporary-clone",
        });
        expect(
          yield* fs.exists(path.join(root, temporary.slice("/workspace/".length), ".git")),
        ).toBe(true);
        yield* routes.call({ cwd: temporary, method: "vcs.temp.remove", input: {} });
        expect(yield* fs.exists(path.join(root, temporary.slice("/workspace/".length)))).toBe(
          false,
        );
        expect(yield* git.readConfigValue(cwd, "user.name")).toBe("Worker Test");
        yield* fs.writeFileString(path.join(repo, "README.md"), "second\n");
        expect((yield* git.prepareCommitContext(cwd))?.stagedPatch).toContain("second");
        const output: string[] = [];
        const hooks: string[] = [];
        const commit = git.commit(cwd, "remote commit", "body", {
          stage: {},
          progress: {
            onHookStarted: (name) =>
              Effect.sync(() => {
                hooks.push(name);
              }),
            onOutputLine: (event) =>
              Effect.sync(() => {
                output.push(event.text);
              }),
          },
        });
        const committed = yield* commit.pipe(
          Effect.provideService(Remote.GitActionScope, {
            id: "commit-action",
            counters: new Map(),
          }),
        );
        expect(
          yield* commit.pipe(
            Effect.provideService(Remote.GitActionScope, {
              id: "commit-action",
              counters: new Map(),
            }),
          ),
        ).toEqual(committed);
        expect((yield* run(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
        expect(committed.commitSha).not.toBe(initial);
        expect(hooks).toContain("pre-commit");
        expect(output.join("\n")).toContain("hook-observed");
        expect((yield* git.pushCurrentBranch(cwd, "main")).status).toBe("pushed");
        expect((yield* run(["rev-parse", "refs/heads/main"], bare)).stdout.trim()).toBe(
          committed.commitSha,
        );
        expect((yield* git.readRangeContext(cwd, initial)).diffPatch).toContain("second");
        const preview = yield* git.getReviewDiffPreview({ cwd, baseRef: initial });
        expect(preview.cwd).toBe(cwd);
        expect(preview.sources.some((source) => source.diff.includes("second"))).toBe(true);
        expect(
          yield* git.getReviewDiffFileContents({
            cwd,
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: initial,
            headRef: "HEAD",
            oldPath: "README.md",
            newPath: "README.md",
          }),
        ).toEqual({ oldContents: "first\n", newContents: "second\n" });
        expect(
          (yield* git.listRefs({ cwd })).refs.find((ref) => ref.name === "main")?.worktreePath,
        ).toBe(cwd);
        expect(yield* git.remoteExists({ cwd, remoteName: "origin" })).toBe(true);
        expect(yield* git.remoteBranchExists({ cwd, remoteName: "origin", refName: "main" })).toBe(
          true,
        );
        expect(yield* git.resolveDefaultBranchName(cwd, "origin")).toBe("main");
        const handle = yield* Context.get(central, Registry.VcsDriverRegistry).resolve({ cwd });
        expect(handle.repository.rootPath).toBe(cwd);
        expect((yield* handle.driver.listRemotes(cwd)).remotes.length).toBe(1);
        const claims: string[] = [];
        const created = yield* git.createWorktree(
          { cwd, path: null, refName: "main", newRefName: "feature" },
          {
            submodules: "none",
            progress: {
              onWorktreeClaimed: (value) =>
                Effect.sync(() => {
                  claims.push(value);
                }),
            },
          },
        );
        expect(created.worktree.path).toMatch(/^\/workspace\/allocation\/repo-worktrees\//);
        expect(claims).toContain(created.worktree.path);
        const rebuilt = yield* build;
        const restarted = Context.get(rebuilt, Git.GitVcsDriver);
        expect((yield* restarted.statusDetails(created.worktree.path)).branch).toBe("feature");
        const branches = yield* Effect.all(
          [cwd, created.worktree.path].map((cwd) =>
            restarted.execute({ cwd, operation: "branch", args: ["branch", "--show-current"] }),
          ),
        ).pipe(
          Effect.provideService(Remote.GitActionScope, {
            id: "two-checkouts",
            counters: new Map(),
          }),
        );
        expect(branches.map((value) => value.stdout.trim())).toEqual(["main", "feature"]);
        expect(yield* restarted.listWorktreePaths(cwd)).toContain(created.worktree.path);
        yield* restarted.removeWorktree({ cwd, path: created.worktree.path, force: false });
        expect(yield* restarted.listWorktreePaths(cwd)).not.toContain(created.worktree.path);
        const missing = yield* Context.get(rebuilt, Routing.WorkspaceRouting)
          .validate(created.worktree.path)
          .pipe(Effect.flip);
        expect(missing._tag).toBe("WorkspaceRoutingError");
      }),
  );
});
