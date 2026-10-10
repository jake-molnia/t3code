// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real worker HTTP boundary and retained Git repository.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
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
import * as RuntimeSchema from "./Schema.ts";
import * as RemoteProcess from "./RemoteVcsProcess.ts";
import * as Remote from "./RemoteGitDriver.ts";
import { makeGitDriverExecutor } from "./worker/GitDriverExecutor.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";

const services = Layer.mergeAll(
  Git.layer,
  Registry.layer,
  ProcessRunner.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(
  Layer.provide(ProjectFile.layer),
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
        const worker = createExecutionWorker({
          identity,
          token,
          journal,
          execute: (method, input) => runPromise(executor.execute(method, input)),
        });
        publish = worker.publish;
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle }),
          ),
          (value) => Effect.promise(() => value.close()),
        );
        const client = createExecutionClient({
          identity,
          token,
          endpoint: `http://127.0.0.1:${server.port}`,
        });
        const runtime = RuntimeClient.RuntimeClient.of({
          ideOrigin: () => Effect.die("IDE origin is not used by this test"),
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
