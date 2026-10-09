import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectFile from "../project/T3ProjectFileLoader.ts";
import * as RepositoryIdentity from "../project/RepositoryIdentityResolver.ts";
import * as Favicon from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeClient from "./RuntimeClient.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as RuntimeSchema from "./Schema.ts";
import * as RemoteMetadata from "./RemoteProjectMetadata.ts";
import { makeMetadataExecutor } from "./worker/MetadataExecutor.ts";
import { validateCloneSourceUrl } from "./RepositoryUrl.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
const layer = Layer.mergeAll(
  RepositoryIdentity.layer,
  Favicon.layer,
  ProcessRunner.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
).pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ProjectFile.layer),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer, { excludeTestServices: true })("remote project metadata", (it) => {
  it.effect(
    "loads worker t3.json and repository identity without central filesystem reads or credential exposure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const processes = yield* ProcessRunner.ProcessRunner;
        yield* RuntimeSchema.migrate;
        yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES ('project-seed','utility:project')`;
        yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,utility_key,source_url) VALUES ('/workspace/repo','project-seed','repo','project','https://github.com/example/repo.git')`;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "metadata-worker-" });
        const repo = path.join(root, "repo");
        yield* fs.makeDirectory(path.join(repo, "assets"), { recursive: true });
        yield* fs.writeFileString(
          path.join(repo, "t3.json"),
          ' { "defaultThreadEnvMode":"worktree", "worktreeSubmodules":"none", "iconPath":"assets/logo.svg", "scripts":[{"name":"Setup","command":"echo worker","runOnWorktreeCreate":true,"async":false}] } ',
        );
        yield* fs.writeFileString(
          path.join(repo, "assets/logo.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        );
        yield* processes.run({ command: "git", args: ["init"], cwd: repo });
        yield* processes.run({
          command: "git",
          args: [
            "remote",
            "add",
            "origin",
            "https://user:credential-sentinel@github.com/example/repo.git?token=also-secret",
          ],
          cwd: repo,
        });
        const worker = yield* makeMetadataExecutor({
          resolve: (cwd) => Effect.succeed(path.resolve(root, cwd)),
        });
        const identity = {
          workspaceId: "project-seed",
          allocationId: "1",
          generation: 1,
          incarnation: "one",
          podUid: "pod",
          protocolVersion: 1,
        } satisfies ExecutionClient["identity"];
        let stopped = false;
        let calls = 0;
        let wakes = 0;
        const client: ExecutionClient = {
          credentialSource: () => {
            throw new Error("Credential sharing is unused in this fixture");
          },
          identity,
          call: (method, input) => {
            calls++;
            return Effect.runPromise(worker.execute(method, input));
          },
          transient: async () => null,
          events: async () => [],
          ack: async () => {},
          operationStatus: async () => ({ state: "missing" }),
          inspectIdentity: async () => identity,
        };
        const runtime = RuntimeClient.RuntimeClient.of({
          enabled: true,
          forThread: () => Effect.succeed(client),
          forWorkspace: () =>
            Effect.sync(() => {
              wakes++;
              return client;
            }),
          forUtility: () => Effect.succeed(client),
          observeThread: () =>
            Effect.succeed(stopped ? { kind: "stopped" } : { kind: "running", client }),
          observeWorkspace: () =>
            Effect.succeed(stopped ? { kind: "stopped" } : { kind: "running", client }),
          sessionResidency: () => Effect.succeed(identity),
          rememberSession: () => Effect.void,
          getEventCursor: () => Effect.succeed(0),
          stop: () => Effect.void,
        });
        const built = yield* Layer.build(
          Layer.mergeAll(
            RemoteMetadata.projectFileLayer,
            RemoteMetadata.repositoryLayer,
            RemoteMetadata.faviconLayer,
          ).pipe(Layer.provide(Routing.layer)),
        ).pipe(
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: () => Effect.die("Central must not read t3.json or Git config"),
          }),
        );
        const file = yield* Context.get(built, ProjectFile.T3ProjectFileLoader).load(
          "/workspace/repo",
        );
        expect(Option.getOrNull(file)).toMatchObject({
          defaultThreadEnvMode: "worktree",
          worktreeSubmodules: "none",
          scripts: [{ command: "echo worker", async: false }],
        });
        const repositories = Context.get(built, RepositoryIdentity.RepositoryIdentityResolver);
        const repoIdentity = yield* repositories.resolve("/workspace/repo");
        expect(repoIdentity).toMatchObject({
          canonicalKey: "github.com/example/repo",
          rootPath: "/workspace/repo",
          locator: { remoteUrl: "https://github.com/example/repo.git" },
        });
        expect(JSON.stringify(repoIdentity)).not.toContain("credential-sentinel");
        expect(JSON.stringify(repoIdentity)).not.toContain("also-secret");
        expect(
          yield* Context.get(built, Favicon.ProjectFaviconResolver).resolvePath("/workspace/repo"),
        ).toBe("/workspace/repo/assets/logo.svg");
        const before = calls;
        const wakeCount = wakes;
        stopped = true;
        expect(yield* repositories.resolve("/workspace/repo")).toEqual(repoIdentity);
        expect(calls).toBe(before);
        expect(wakes).toBe(wakeCount);
        expect(() => validateCloneSourceUrl("https://token@github.com/example/repo.git")).toThrow(
          "credentials",
        );
      }),
  );
});
