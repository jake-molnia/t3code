import * as C from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Registry from "../sourceControl/SourceControlProviderRegistry.ts";
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
import * as Assets from "./RemoteAssets.ts";
import { captureRunPromise } from "../execution/EffectHttpBoundary.ts";
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
        const runPromise = yield* captureRunPromise;
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
            return runPromise(worker.execute(method, input));
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
        const cachedFavicons: Array<{
          cwd: string;
          preferred: string | undefined;
          found: string | null;
        }> = [];
        const built = yield* Layer.build(
          Layer.mergeAll(
            RemoteMetadata.projectFileLayer,
            RemoteMetadata.repositoryLayer,
            RemoteMetadata.faviconLayer,
          ).pipe(Layer.provide(Routing.layer)),
        ).pipe(
          Effect.provideService(RuntimeClient.RuntimeClient, runtime),
          Effect.provideService(Assets.RemoteAssets, {
            enabled: true,
            prepare: () => Effect.die("Asset preparation is not part of metadata lookup"),
            populate: () => Effect.void,
            rememberFavicon: (cwd, preferred, found) =>
              Effect.sync(() => {
                cachedFavicons.push({ cwd, preferred, found });
              }),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => Effect.die("Central Git is forbidden"),
          }),
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
        expect(cachedFavicons).toEqual([
          {
            cwd: "/workspace/repo",
            preferred: undefined,
            found: "/workspace/repo/assets/logo.svg",
          },
        ]);
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

const database = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(database, { excludeTestServices: true })("remote repository identity", (it) => {
  it.effect(
    "refines live worker metadata centrally and preserves stopped identity without waking",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* RuntimeSchema.migrate;
        for (const id of ["first", "second"]) {
          yield* sql`INSERT INTO agent_runtime_workspaces(workspace_id,owner_thread_id) VALUES (${id},${id})`;
          yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,source_url)
          VALUES (${`/workspace/${id}/repo`},${id},'repo',${`https://user:secret@forge.test/team/${id}.git`})`;
        }
        const calls: Array<{ workspaceId: string; method: string; input: unknown }> = [];
        let running = false;
        let generation = 1;
        let failRefinement = false;
        const client = (workspaceId: string): ExecutionClient => {
          const identity = {
            workspaceId,
            generation,
            allocationId: "allocation",
            incarnation: String(generation),
            protocolVersion: 1,
            podUid: "pod",
          } satisfies ExecutionClient["identity"];
          return {
            identity,
            credentialSource: () => {
              throw new Error("Credentials are not used by metadata");
            },
            call: async (method, input) => {
              calls.push({ workspaceId, method, input });
              if (method === "forge.resolve") return null;
              if (method !== "project.repositoryIdentity") throw new Error(`Unexpected ${method}`);
              return {
                identity: RepositoryIdentity.buildRepositoryIdentity({
                  remoteName: "origin",
                  remoteUrl: `https://forge.test/team/${workspaceId}-${generation}.git`,
                  originUrl: undefined,
                  rootPath: `/workspace/${workspaceId}/repo`,
                }),
              };
            },
            transient: async () => null,
            events: async () => [],
            ack: async () => {},
            operationStatus: async () => ({ state: "missing" }),
            inspectIdentity: async () => identity,
          };
        };
        const runtime = Layer.mock(RuntimeClient.RuntimeClient)({
          enabled: true,
          observeWorkspace: (id) =>
            Effect.sync(() =>
              running ? { kind: "running", client: client(id) } : { kind: "stopped" },
            ),
          forWorkspace: () => Effect.die("Metadata must not wake a worker"),
          forUtility: () => Effect.die("Metadata must not acquire utility compute"),
        });
        const routes = yield* Routing.WorkspaceRouting.pipe(
          Effect.provide(Routing.layer.pipe(Layer.provide(runtime))),
        );
        const unused = () => Effect.die("Unexpected repository operation");
        const provider = SourceControlProvider.SourceControlProvider.of({
          kind: C.SourceControlProviderKind.make("forgejo"),
          listChangeRequests: unused,
          getChangeRequest: unused,
          createChangeRequest: unused,
          getRepositoryCloneUrls: unused,
          createRepository: unused,
          getDefaultBranch: unused,
          checkoutChangeRequest: unused,
          refineRepositoryIdentity: ({ identity, resolveContext }) =>
            Effect.gen(function* () {
              if (!identity.rootPath) return identity;
              yield* resolveContext({
                cwd: identity.rootPath,
                context: {
                  provider: {
                    kind: C.SourceControlProviderKind.make("unknown"),
                    name: "Unknown",
                    baseUrl: "",
                  },
                  remoteName: identity.locator.remoteName,
                  remoteUrl: identity.locator.remoteUrl,
                },
              });
              return {
                ...identity,
                provider: C.SourceControlProviderKind.make("forgejo"),
                webUrl: "https://forge.test/mount/team/repo",
              };
            }),
        });
        const registry = Layer.mock(Registry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          get: () => Effect.succeed(provider),
          resolveHandle: ({ cwd }) =>
            Effect.gen(function* () {
              if (failRefinement)
                return yield* new C.SourceControlProviderError({
                  provider: C.SourceControlProviderKind.make("forgejo"),
                  operation: "refine",
                  cwd,
                  detail: "Forge unavailable",
                });
              yield* routes.call({ cwd, method: "forge.resolve", input: {} }).pipe(Effect.orDie);
              return { provider, context: null };
            }),
        });
        const metadataLayer = RemoteMetadata.refinedRepositoryLayer.pipe(
          Layer.provide(registry),
          Layer.provide(Layer.succeed(Routing.WorkspaceRouting, routes)),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () => Effect.die("Central Git is forbidden"),
            }),
          ),
        );
        const resolver = yield* RepositoryIdentity.RepositoryIdentityResolver.pipe(
          Effect.provide(metadataLayer),
        );
        const first = "/workspace/first/repo";
        const second = "/workspace/second/repo";
        expect((yield* resolver.resolve(first))?.locator.remoteUrl).toBe(
          "https://forge.test/team/first.git",
        );
        expect(calls).toEqual([]);
        running = true;
        const live = yield* resolver.resolve(first, { refresh: true });
        expect(live?.provider).toBe("forgejo");
        expect(live?.webUrl).toBe("https://forge.test/mount/team/repo");
        expect(calls).toEqual([
          {
            workspaceId: "first",
            method: "project.repositoryIdentity",
            input: { cwd: "repo", refresh: true },
          },
          { workspaceId: "first", method: "forge.resolve", input: { cwd: "repo" } },
        ]);
        expect((yield* resolver.resolve(second))?.canonicalKey).toBe("forge.test/team/second-1");
        running = false;
        const count = calls.length;
        expect(yield* resolver.resolve(first)).toEqual(live);
        expect(calls).toHaveLength(count);
        const restarted = yield* RepositoryIdentity.RepositoryIdentityResolver.pipe(
          Effect.provide(metadataLayer),
        );
        expect((yield* restarted.resolve(first))?.canonicalKey).toBe("forge.test/team/first");
        expect(calls).toHaveLength(count);
        running = true;
        generation = 2;
        failRefinement = true;
        expect((yield* resolver.resolve(first, { refresh: true }))?.canonicalKey).toBe(
          "forge.test/team/first-2",
        );
      }),
  );
});
