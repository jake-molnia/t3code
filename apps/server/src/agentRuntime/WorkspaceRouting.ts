import { withWorkspaceActivity, withWorkspaceObservationActivity } from "./WorkspaceActivity.ts";
import { seedWorkspace } from "./SeedWorkspace.ts";
import * as GitProtocol from "./worker/GitDriverProtocol.ts";
import { validateCloneSourceUrl } from "./RepositoryUrl.ts";
import type { ExecutionClient } from "../execution/ExecutionClient.ts";
import * as RestoreSafety from "./RestoreSafety.ts";
import * as C from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Bindings from "./Bindings.ts";
import * as RuntimeClient from "./RuntimeClient.ts";

const Route = Schema.Struct({
  virtualCwd: Schema.String,
  workspaceId: Schema.String,
  relativeCwd: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  utilityKey: Schema.NullOr(Schema.String),
  sourceUrl: Schema.NullOr(Schema.String),
});
export class WorkspaceRoutingError extends Schema.TaggedError<WorkspaceRoutingError>()(
  "WorkspaceRoutingError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Remote workspace ${this.operation} failed: ${String(this.cause)}`;
  }
}
export class WorkspaceObservation extends Context.Reference<{
  readonly workspaceId: string;
  readonly client: ExecutionClient;
} | null>("t3/agentRuntime/WorkspaceObservation", { defaultValue: () => null }) {}

export class WorkspaceRouting extends Context.Service<
  WorkspaceRouting,
  {
    readonly enabled: boolean;
    /** Planned independent root, including before the thread exists. */
    readonly describeThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { workspaceId: string; virtualCwd: string; relativeCwd: string },
      WorkspaceRoutingError
    >;
    /** Existing durable binding; descendants resolve their parent's workspace. */
    readonly describeBoundThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { workspaceId: string; virtualCwd: string; relativeCwd: string },
      WorkspaceRoutingError
    >;
    readonly registerFork: (input: {
      targetThreadId: ThreadId;
      sourceCwd: string;
    }) => Effect.Effect<
      { workspaceId: string; virtualCwd: string; relativeCwd: string },
      WorkspaceRoutingError
    >;
    readonly describeCwd: (
      cwd: string,
    ) => Effect.Effect<
      { workspaceId: string; virtualCwd: string; relativeCwd: string },
      WorkspaceRoutingError
    >;
    readonly clientForCwd: (cwd: string) => Effect.Effect<ExecutionClient, WorkspaceRoutingError>;
    readonly project: (
      projectId: string,
      sourceUrl?: string,
    ) => Effect.Effect<string, WorkspaceRoutingError>;
    readonly prepareThread: (input: {
      threadId: ThreadId;
      projectCwd: string;
      branch?: string;
      refName?: string;
      submodules?: C.WorktreeSubmodules;
      onStage?: (
        stage: "sandbox" | "seed" | "checkout",
        status: "running" | "done" | "skipped",
      ) => Effect.Effect<void>;
    }) => Effect.Effect<string, WorkspaceRoutingError>;
    readonly callThread: (
      threadId: ThreadId,
      method: string,
      input: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, WorkspaceRoutingError>;
    readonly observe: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | null, E | WorkspaceRoutingError, R>;
    readonly observeCall: (input: {
      cwd: string;
      method: string;
      input: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<unknown, WorkspaceRoutingError>;
    readonly validate: (cwd: string) => Effect.Effect<string, WorkspaceRoutingError>;
    readonly call: (input: {
      cwd: string;
      method: string;
      input: Readonly<Record<string, unknown>>;
      operationId?: string;
    }) => Effect.Effect<unknown, WorkspaceRoutingError>;
  }
>()("t3/agentRuntime/WorkspaceRouting") {}

export const layer = Layer.effect(
  WorkspaceRouting,
  Effect.gen(function* () {
    const runtime = yield* RuntimeClient.RuntimeClient;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const restoreSafety = yield* RestoreSafety.RestoreSafety.pipe(
      Effect.provide(RestoreSafety.layer),
    );
    const failure = (operation: string) => (cause: unknown) =>
      new WorkspaceRoutingError({ operation, cause });
    const rootFor = (workspaceId: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(workspaceId)).pipe(
        Effect.map((bytes) => {
          const key = Array.from(bytes)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 32);
          return { virtualCwd: `/workspace/${key}/repo`, relativeCwd: `${key}/repo` };
        }),
      );
    const lookup = (cwd: string) =>
      Effect.gen(function* () {
        if (!cwd.startsWith("/workspace/") || cwd.split("/").includes("..") || cwd.includes("\\"))
          return yield* failure("resolve")(
            "This project must be imported into an agent-runtime workspace before use.",
          );
        const rows =
          yield* sql`SELECT virtual_cwd AS virtualCwd,workspace_id AS workspaceId,relative_cwd AS relativeCwd,thread_id AS threadId,utility_key AS utilityKey,source_url AS sourceUrl
      FROM agent_runtime_workspace_paths WHERE virtual_cwd=${cwd} OR substr(${cwd},1,length(virtual_cwd)+1)=virtual_cwd || '/' ORDER BY length(virtual_cwd) DESC LIMIT 1`;
        if (rows.length !== 1)
          return yield* failure("resolve")(
            "No registered execution workspace owns this path. Import the project first.",
          );
        return yield* Schema.decodeUnknownEffect(Route)(rows[0]);
      });
    const register = (route: typeof Route.Type) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO agent_runtime_workspace_paths(virtual_cwd,workspace_id,relative_cwd,thread_id,utility_key,source_url)
      VALUES (${route.virtualCwd},${route.workspaceId},${route.relativeCwd},${route.threadId},${route.utilityKey},${route.sourceUrl}) ON CONFLICT(virtual_cwd) DO NOTHING`;
        const existing = yield* lookup(route.virtualCwd);
        if (
          existing.workspaceId !== route.workspaceId ||
          existing.relativeCwd !== route.relativeCwd ||
          existing.sourceUrl !== route.sourceUrl
        )
          return yield* failure("register")("Workspace source or ownership changed.");
      });
    const clientForRoute = (route: typeof Route.Type) =>
      Effect.gen(function* () {
        const observation = yield* WorkspaceObservation;
        if (!observation) return yield* runtime.forWorkspace(route.workspaceId);
        if (observation.workspaceId !== route.workspaceId)
          return yield* failure("observe")("Passive reads cannot access another workspace.");
        return observation.client;
      });
    const withRouteActivity = <A, E, R>(workspaceId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const observation = yield* WorkspaceObservation;
        return yield* observation ? effect : withWorkspaceActivity(workspaceId, effect);
      });
    const call: WorkspaceRouting["Service"]["call"] = (input) =>
      Effect.gen(function* () {
        const route = yield* lookup(input.cwd);
        return yield* withRouteActivity(
          route.workspaceId,
          Effect.gen(function* () {
            const client = yield* clientForRoute(route);
            const cwd = route.relativeCwd + input.cwd.slice(route.virtualCwd.length);
            let payload: Readonly<Record<string, unknown>> = { ...input.input, cwd };
            if (
              input.method === "files.read" &&
              typeof input.input.relativePath === "string" &&
              input.input.relativePath.startsWith(`${route.virtualCwd}/`)
            )
              payload = {
                ...payload,
                relativePath: input.input.relativePath.slice(route.virtualCwd.length + 1),
              };
            if (
              input.method === "files.browse" &&
              typeof input.input.partialPath === "string" &&
              (input.input.partialPath === route.virtualCwd ||
                input.input.partialPath.startsWith(`${route.virtualCwd}/`))
            )
              payload = {
                ...payload,
                cwd: route.relativeCwd,
                partialPath: input.input.partialPath.slice(route.virtualCwd.length + 1) || "./",
              };
            if (
              input.method === "git.createWorktree" ||
              input.method === "git.driver.createWorktree"
            ) {
              const command = yield* Schema.decodeUnknownEffect(C.VcsCreateWorktreeInput)(
                input.input,
              );
              const suffix = yield* rootFor(
                `${route.workspaceId}:${command.newRefName ?? command.refName}`,
              );
              const target =
                command.path ?? `${route.virtualCwd}-worktrees/${suffix.relativeCwd.split("/")[0]}`;
              const allocationRoot = route.virtualCwd.slice(
                0,
                route.virtualCwd.indexOf("/", "/workspace/".length),
              );
              if (!target.startsWith(`${allocationRoot}/`) || target.split("/").includes(".."))
                return yield* failure("createWorktree")(
                  "Worktree must remain in the same sandbox.",
                );
              const options =
                input.method === "git.driver.createWorktree"
                  ? (yield* Schema.decodeUnknownEffect(GitProtocol.Git.createWorktree.input)(
                      input.input,
                    )).options
                  : undefined;
              payload = {
                ...payload,
                ...command,
                cwd,
                path: target.slice("/workspace/".length),
                ...(options
                  ? {
                      options: {
                        ...options,
                        worktreesDirectory: `${allocationRoot.slice("/workspace/".length)}/worktrees`,
                      },
                    }
                  : {}),
              };
            }
            if (
              input.method === "git.removeWorktree" ||
              input.method === "git.driver.removeWorktree"
            ) {
              const target = yield* lookup(String(input.input.path));
              if (target.workspaceId !== route.workspaceId)
                return yield* failure("removeWorktree")(
                  "Cannot remove another sandbox's checkout.",
                );
              payload = { ...payload, path: target.relativeCwd };
            }
            if (input.method === "git.restore") {
              if (
                !route.threadId ||
                !restoreSafety.check ||
                !(yield* restoreSafety.check(
                  { id: ThreadId.make(route.threadId), worktreePath: route.virtualCwd },
                  { cwd: input.cwd },
                ))
              )
                return yield* failure("restore")(
                  "File restore requires a workspace owned by exactly one active conversation.",
                );
              payload = { ...payload, isolated: true };
            }
            const result = yield* Effect.tryPromise({
              try: () => client.call(input.method, payload, input.operationId),
              catch: failure(input.method),
            });
            if (
              input.method === "git.createWorktree" ||
              input.method === "git.driver.createWorktree"
            ) {
              const envelope =
                input.method === "git.driver.createWorktree"
                  ? yield* Schema.decodeUnknownEffect(
                      GitProtocol.response(C.VcsCreateWorktreeResult),
                    )(result)
                  : {
                      ok: true as const,
                      value: yield* Schema.decodeUnknownEffect(C.VcsCreateWorktreeResult)(result),
                    };
              if (!envelope.ok) return result;
              const created = envelope.value;
              if (!created.worktree.path.startsWith("/workspace/"))
                return yield* failure("createWorktree")("Unexpected worker checkout location.");
              yield* register({
                ...route,
                virtualCwd: created.worktree.path,
                relativeCwd: created.worktree.path.slice("/workspace/".length),
              });
            }
            if (
              input.method === "git.removeWorktree" ||
              (input.method === "git.driver.removeWorktree" &&
                (yield* Schema.decodeUnknownEffect(GitProtocol.response(Schema.Null))(result)).ok)
            )
              yield* sql`DELETE FROM agent_runtime_workspace_paths WHERE virtual_cwd=${String(input.input.path)} AND workspace_id=${route.workspaceId}`;
            return result;
          }),
        );
      }).pipe(Effect.mapError(failure(input.method)));
    const project: WorkspaceRouting["Service"]["project"] = (projectId, sourceUrl) =>
      Effect.gen(function* () {
        if (sourceUrl) yield* Effect.try(() => validateCloneSourceUrl(sourceUrl));
        const utilityKey = `project:${projectId}`;
        const workspaceId = `t3:utility:${utilityKey}`;
        const root = yield* rootFor(workspaceId);
        const client = yield* runtime.forUtility(utilityKey);
        yield* register({
          ...root,
          workspaceId,
          threadId: null,
          utilityKey,
          sourceUrl: sourceUrl ?? null,
        });
        yield* Effect.tryPromise({
          try: () =>
            client.call("workspace.prepare", {
              cwd: root.relativeCwd,
              ...(sourceUrl ? { sourceUrl } : {}),
            }),
          catch: failure("prepare-project"),
        });
        return root.virtualCwd;
      }).pipe(Effect.mapError(failure("prepare-project")));
    const prepareThread: WorkspaceRouting["Service"]["prepareThread"] = (input) =>
      Effect.gen(function* () {
        const source = yield* lookup(input.projectCwd);
        const binding = yield* Bindings.read(input.threadId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return yield* withWorkspaceActivity(
          binding.workspaceId,
          withWorkspaceActivity(
            source.workspaceId,
            Effect.gen(function* () {
              const stage = input.onStage ?? (() => Effect.void);
              const root = yield* rootFor(binding.workspaceId);
              yield* stage("sandbox", "running");
              const client = yield* runtime.forThread(input.threadId);
              yield* stage("sandbox", "done");
              if (binding.ownerThreadId !== input.threadId) {
                yield* stage("seed", "skipped");
                yield* stage("checkout", "skipped");
                return root.virtualCwd;
              }
              yield* register({
                ...root,
                workspaceId: binding.workspaceId,
                threadId: input.threadId,
                utilityKey: null,
                sourceUrl: source.sourceUrl,
              });
              yield* stage("seed", "running");
              const prepared = yield* Effect.tryPromise(() =>
                client.call("git.isRepository", { cwd: root.relativeCwd }),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)));
              if (!prepared)
                yield* seedWorkspace({
                  source: yield* runtime.forWorkspace(source.workspaceId),
                  destination: client,
                  sourceCwd: source.relativeCwd,
                  destinationCwd: root.relativeCwd,
                  key: root.relativeCwd.slice(0, root.relativeCwd.indexOf("/")),
                });
              yield* stage("seed", prepared ? "skipped" : "done");
              yield* stage("checkout", "running");
              yield* Effect.tryPromise({
                try: () =>
                  client.call("workspace.prepare", {
                    cwd: root.relativeCwd,
                    ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
                    ...(input.branch ? { branch: input.branch } : {}),
                    ...(input.refName ? { refName: input.refName } : {}),
                    ...(input.submodules ? { submodules: input.submodules } : {}),
                  }),
                catch: failure("prepare-thread"),
              });
              yield* stage("checkout", "done");
              return root.virtualCwd;
            }),
          ),
        );
      }).pipe(Effect.mapError(failure("prepare-thread")));
    return WorkspaceRouting.of({
      enabled: true,
      describeThread: (threadId) =>
        rootFor(`t3:${threadId}`).pipe(
          Effect.map((root) => ({ ...root, workspaceId: `t3:${threadId}` })),
          Effect.mapError(failure("describe-thread")),
        ),
      describeBoundThread: (threadId) =>
        Effect.gen(function* () {
          const binding = yield* Bindings.read(threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          return { ...(yield* rootFor(binding.workspaceId)), workspaceId: binding.workspaceId };
        }).pipe(Effect.mapError(failure("describe-bound-thread"))),
      registerFork: (input) =>
        Effect.gen(function* () {
          const source = yield* lookup(input.sourceCwd);
          const binding = yield* Bindings.read(input.targetThreadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const root = yield* rootFor(binding.workspaceId);
          yield* register({
            ...root,
            workspaceId: binding.workspaceId,
            threadId: input.targetThreadId,
            utilityKey: null,
            sourceUrl: source.sourceUrl,
          });
          return { ...root, workspaceId: binding.workspaceId };
        }).pipe(Effect.mapError(failure("register-fork"))),
      describeCwd: (cwd) => lookup(cwd).pipe(Effect.mapError(failure("describe-cwd"))),
      clientForCwd: (cwd) =>
        lookup(cwd).pipe(
          Effect.flatMap(clientForRoute),
          Effect.mapError(failure("resolve-worker")),
        ),
      project,
      prepareThread,
      call,
      callThread: (threadId, method, input) =>
        Effect.gen(function* () {
          const binding = yield* Bindings.read(threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          let payload: Readonly<Record<string, unknown>> = { ...input, threadId };
          for (const field of ["cwd", "worktreePath"])
            if (typeof input[field] === "string") {
              const value = input[field];
              const route = yield* lookup(value);
              if (route.workspaceId !== binding.workspaceId)
                return yield* failure(method)("Terminal checkout belongs to another sandbox.");
              payload = {
                ...payload,
                [field]: route.relativeCwd + value.slice(route.virtualCwd.length),
              };
            }
          return yield* withWorkspaceActivity(
            binding.workspaceId,
            Effect.gen(function* () {
              const client = yield* runtime.forThread(threadId);
              return yield* Effect.tryPromise({
                try: () => client.call(method, payload),
                catch: failure(method),
              });
            }),
          );
        }).pipe(Effect.mapError(failure(method))),
      observe: (cwd, effect) =>
        Effect.gen(function* () {
          const route = yield* lookup(cwd).pipe(Effect.mapError(failure("observe")));
          const existing = yield* WorkspaceObservation;
          if (existing) {
            if (existing.workspaceId !== route.workspaceId)
              return yield* failure("observe")("Passive reads cannot access another workspace.");
            return yield* effect;
          }
          return yield* withWorkspaceObservationActivity(
            route.workspaceId,
            Effect.gen(function* () {
              const observed = yield* runtime
                .observeWorkspace(route.workspaceId)
                .pipe(Effect.mapError(failure("observe")));
              if (observed.kind === "stopped") return null;
              return yield* effect.pipe(
                Effect.provideService(WorkspaceObservation, {
                  workspaceId: route.workspaceId,
                  client: observed.client,
                }),
              );
            }),
          );
        }),
      observeCall: (input) =>
        Effect.gen(function* () {
          const route = yield* lookup(input.cwd);
          const observed = yield* runtime.observeWorkspace(route.workspaceId);
          if (observed.kind === "stopped") return null;
          return yield* Effect.tryPromise({
            try: () =>
              observed.client.call(input.method, {
                ...input.input,
                cwd: route.relativeCwd + input.cwd.slice(route.virtualCwd.length),
              }),
            catch: failure(input.method),
          });
        }).pipe(Effect.mapError(failure("observe"))),
      validate: (cwd) => lookup(cwd).pipe(Effect.as(cwd), Effect.mapError(failure("resolve"))),
    });
  }),
);
