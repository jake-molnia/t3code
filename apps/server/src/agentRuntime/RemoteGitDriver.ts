import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { ChildProcessSpawner } from "effect/process";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as Routing from "./WorkspaceRouting.ts";
import * as RepositoryFiles from "../git/RepositoryFiles.ts";
import * as P from "./worker/GitDriverProtocol.ts";
import { AuthoredPaths } from "./worker/Protocol.ts";

export class GitActionScope extends Context.Reference<{
  readonly id: string;
  readonly counters: Map<string, number>;
} | null>("t3/agentRuntime/GitActionScope", { defaultValue: () => null }) {}
const Envelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: P.Error }),
]);
const VcsEnvelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: C.VcsError }),
]);

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeVcsEnvelope = Schema.decodeUnknownEffect(VcsEnvelope);
const decodeProgress = Schema.decodeUnknownEffect(P.Progress);
const decodePath = Schema.decodeUnknownEffect(Schema.String);
const isGitError = Schema.is(C.GitCommandError);

export const make = Effect.gen(function* () {
  const routes = yield* Routing.WorkspaceRouting;
  const crypto = yield* Crypto.Crypto;
  const invoke = <A, I>(
    method: string,
    input: Readonly<Record<string, unknown>> & { cwd: string },
    schema: Schema.Codec<A, I>,
    onProgress?: (event: P.Progress) => Effect.Effect<void, never>,
  ) =>
    Effect.gen(function* () {
      const scope = yield* GitActionScope;
      const key = `${method}:${input.cwd}`;
      const ordinal = scope?.counters.get(key) ?? 0;
      scope?.counters.set(key, ordinal + 1);
      const operationId = scope
        ? `${scope.id}:git:${encodeURIComponent(input.cwd)}:${method}:${ordinal}`
        : yield* crypto.randomUUIDv4;
      const payload = { ...input, method, operationId };
      const drain = onProgress
        ? Effect.gen(function* () {
            const client = yield* routes.clientForCwd(input.cwd);
            let cursor = 0;
            return (waitMs: number) =>
              Effect.gen(function* () {
                const events = yield* Effect.tryPromise((signal) =>
                  client.events(cursor, signal, `git:${operationId}`, waitMs),
                );
                for (const event of events) {
                  cursor = Math.max(cursor, event.sequence);
                  if (event.sessionId === `git:${operationId}`) {
                    yield* onProgress(yield* decodeProgress(event.event));
                    yield* Effect.tryPromise(() =>
                      client.ack(`git:${operationId}`, event.sequence),
                    );
                  }
                }
              });
          })
        : Effect.succeed((_waitMs: number) => Effect.void);
      const poll = yield* drain;
      const fiber = yield* Effect.forkChild(
        poll(25_000).pipe(Effect.andThen(Effect.sleep("50 millis")), Effect.forever),
      );
      const result = yield* routes
        .call({ cwd: input.cwd, method: `git.driver.${method}`, input: payload, operationId })
        .pipe(Effect.retry(Schedule.recurs(1)), Effect.ensuring(Fiber.interrupt(fiber)));
      yield* poll(0);
      const envelope = yield* decodeEnvelope(result);
      if (!envelope.ok) return yield* new C.GitCommandError({ ...envelope.error, cwd: input.cwd });
      return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(envelope.value);
    }).pipe(
      Effect.mapError((cause) =>
        isGitError(cause)
          ? cause
          : new C.GitCommandError({
              operation: method,
              command: "git",
              cwd: input.cwd,
              detail: "Remote Git operation failed.",
              cause,
            }),
      ),
    );
  const progress =
    (callbacks: {
      execute?: GitVcsDriver.ExecuteGitProgress | undefined;
      commit?: GitVcsDriver.GitCommitProgress | undefined;
      worktree?: GitVcsDriver.CreateWorktreeProgress | undefined;
    }) =>
    (event: P.Progress): Effect.Effect<void, never> => {
      switch (event.kind) {
        case "stdout":
          return callbacks.execute?.onStdoutLine?.(event.text) ?? Effect.void;
        case "stderr":
          return callbacks.execute?.onStderrLine?.(event.text) ?? Effect.void;
        case "submodule-line":
          return callbacks.worktree?.onSubmoduleLine?.(event.text) ?? Effect.void;
        case "commit-output":
          return callbacks.commit?.onOutputLine?.(event) ?? Effect.void;
        case "hook-start":
          return (
            (callbacks.execute?.onHookStarted ?? callbacks.commit?.onHookStarted)?.(
              event.hookName,
            ) ?? Effect.void
          );
        case "hook-end":
          return (
            (callbacks.execute?.onHookFinished ?? callbacks.commit?.onHookFinished)?.(event) ??
            Effect.void
          );
        case "worktree-claimed":
          return callbacks.worktree?.onWorktreeClaimed?.(event.path) ?? Effect.void;
        case "checkout":
          return callbacks.worktree?.onCheckoutProgress?.(event) ?? Effect.void;
        case "submodules-start":
          return callbacks.worktree?.onSubmodulesStarted?.() ?? Effect.void;
        case "submodules-disabled":
          return callbacks.worktree?.onSubmodulesDisabled?.(event) ?? Effect.void;
        case "submodules-end":
          return callbacks.worktree?.onSubmodulesFinished?.(event) ?? Effect.void;
      }
    };
  const driver = GitVcsDriver.GitVcsDriver.of({
    execute: (input) =>
      invoke(
        "execute",
        { ...input, progress: !!input.progress },
        P.Git.execute.output,
        input.progress ? progress({ execute: input.progress }) : undefined,
      ).pipe(
        Effect.map((value) => ({
          ...value,
          exitCode: ChildProcessSpawner.ExitCode(value.exitCode),
        })),
      ),
    status: (input) => invoke("status", { ...input }, P.Git.status.output),
    statusDetails: (cwd) => invoke("statusDetails", { cwd }, P.Git.statusDetails.output),
    statusDetailsLocal: (cwd, options) =>
      invoke(
        "statusDetailsLocal",
        { cwd, ...(options ? { options } : {}) },
        P.Git.statusDetailsLocal.output,
      ),
    statusDetailsRemote: (cwd, options) =>
      invoke(
        "statusDetailsRemote",
        { cwd, ...(options ? { options } : {}) },
        P.Git.statusDetailsRemote.output,
      ),
    prepareCommitContext: (cwd, filePaths) =>
      invoke(
        "prepareCommitContext",
        { cwd, ...(filePaths ? { filePaths } : {}) },
        P.Git.prepareCommitContext.output,
      ),
    commit: (cwd, subject, body, options) =>
      invoke(
        "commit",
        {
          cwd,
          subject,
          body,
          ...(options
            ? {
                options: {
                  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                  ...(options.stage ? { stage: options.stage } : {}),
                },
              }
            : {}),
          progress: !!options?.progress,
        },
        P.Git.commit.output,
        options?.progress ? progress({ commit: options.progress }) : undefined,
      ),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      invoke(
        "pushCurrentBranch",
        { cwd, fallbackBranch, ...(options ? { options } : {}) },
        P.Git.pushCurrentBranch.output,
      ),
    readRangeContext: (cwd, baseRef) =>
      invoke("readRangeContext", { cwd, baseRef }, P.Git.readRangeContext.output),
    getReviewDiffPreview: (input) =>
      invoke("getReviewDiffPreview", { ...input }, P.Git.getReviewDiffPreview.output),
    getReviewDiffFileContents: (input) =>
      invoke("getReviewDiffFileContents", { ...input }, P.Git.getReviewDiffFileContents.output),
    readConfigValue: (cwd, key) =>
      invoke("readConfigValue", { cwd, key }, P.Git.readConfigValue.output),
    listRefs: (input) => invoke("listRefs", { ...input }, P.Git.listRefs.output),
    pullCurrentBranch: (cwd) =>
      invoke("pullCurrentBranch", { cwd }, P.Git.pullCurrentBranch.output),
    createWorktree: (input, options) =>
      invoke(
        "createWorktree",
        {
          ...input,
          ...(options
            ? {
                options: {
                  ...(options.detached === undefined ? {} : { detached: options.detached }),
                  ...(options.submodules === undefined ? {} : { submodules: options.submodules }),
                  ...(options.worktreesDirectory === undefined
                    ? {}
                    : { worktreesDirectory: options.worktreesDirectory }),
                },
              }
            : {}),
          progress: !!options?.progress,
        },
        P.Git.createWorktree.output,
        options?.progress ? progress({ worktree: options.progress }) : undefined,
      ),
    fetchPullRequestBranch: (input) =>
      invoke("fetchPullRequestBranch", { ...input }, P.Git.fetchPullRequestBranch.output).pipe(
        Effect.asVoid,
      ),
    fetchPullRequestHeadCommit: (input) =>
      invoke("fetchPullRequestHeadCommit", { ...input }, P.Git.fetchPullRequestHeadCommit.output),
    resolveBranchName: (cwd, refName) =>
      invoke("resolveBranchName", { cwd, refName }, P.Git.resolveBranchName.output),
    resolveCommit: (input) => invoke("resolveCommit", { ...input }, P.Git.resolveCommit.output),
    refreshCheckedOutBranch: (input) =>
      invoke("refreshCheckedOutBranch", { ...input }, P.Git.refreshCheckedOutBranch.output),
    ensureRemote: (input) => invoke("ensureRemote", { ...input }, P.Git.ensureRemote.output),
    resolvePrimaryRemoteName: (cwd) =>
      invoke("resolvePrimaryRemoteName", { cwd }, P.Git.resolvePrimaryRemoteName.output),
    resolveDefaultBranchName: (cwd, remoteName) =>
      invoke(
        "resolveDefaultBranchName",
        { cwd, remoteName },
        P.Git.resolveDefaultBranchName.output,
      ),
    fetchRemote: (input) =>
      invoke("fetchRemote", { ...input }, P.Git.fetchRemote.output).pipe(Effect.asVoid),
    remoteExists: (input) => invoke("remoteExists", { ...input }, P.Git.remoteExists.output),
    remoteBranchExists: (input) =>
      invoke("remoteBranchExists", { ...input }, P.Git.remoteBranchExists.output),
    resolveRemoteTrackingCommit: (input) =>
      invoke("resolveRemoteTrackingCommit", { ...input }, P.Git.resolveRemoteTrackingCommit.output),
    fetchRemoteBranch: (input) =>
      invoke("fetchRemoteBranch", { ...input }, P.Git.fetchRemoteBranch.output).pipe(Effect.asVoid),
    fetchRemoteTrackingBranch: (input) =>
      invoke(
        "fetchRemoteTrackingBranch",
        { ...input },
        P.Git.fetchRemoteTrackingBranch.output,
      ).pipe(Effect.asVoid),
    setBranchUpstream: (input) =>
      invoke("setBranchUpstream", { ...input }, P.Git.setBranchUpstream.output).pipe(Effect.asVoid),
    removeWorktree: (input) =>
      invoke("removeWorktree", { ...input }, P.Git.removeWorktree.output).pipe(Effect.asVoid),
    pruneWorktrees: (input) =>
      invoke("pruneWorktrees", { ...input }, P.Git.pruneWorktrees.output).pipe(Effect.asVoid),
    listWorktreePaths: (cwd) =>
      invoke("listWorktreePaths", { cwd }, P.Git.listWorktreePaths.output).pipe(
        Effect.map((paths) => [...paths]),
      ),
    deleteLocalBranch: (input) =>
      invoke("deleteLocalBranch", { ...input }, P.Git.deleteLocalBranch.output).pipe(Effect.asVoid),
    renameBranch: (input) => invoke("renameBranch", { ...input }, P.Git.renameBranch.output),
    createRef: (input) => invoke("createRef", { ...input }, P.Git.createRef.output),
    switchRef: (input) => invoke("switchRef", { ...input }, P.Git.switchRef.output),
    initRepo: (input) =>
      invoke("initRepo", { ...input }, P.Git.initRepo.output).pipe(Effect.asVoid),
    listLocalBranchNames: (cwd) =>
      invoke("listLocalBranchNames", { cwd }, P.Git.listLocalBranchNames.output).pipe(
        Effect.map((paths) => [...paths]),
      ),
  });
  return {
    driver,
    readInstructions: (cwd: string, fileName: string) =>
      invoke("readInstructions", { cwd, fileName }, P.Git.readInstructions.output),
  };
});
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const remote = yield* make;
    const routes = yield* Routing.WorkspaceRouting;
    return Layer.merge(
      Layer.succeed(GitVcsDriver.GitVcsDriver, remote.driver),
      Layer.succeed(
        RepositoryFiles.RepositoryFiles,
        RepositoryFiles.RepositoryFiles.of({
          temporaryDirectory: Effect.acquireRelease(
            Effect.gen(function* () {
              const cwd = yield* routes.project("source-control-temporary");
              const raw = yield* routes.call({ cwd, method: "vcs.temp.create", input: {} });
              return yield* decodePath(raw);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new C.GitCommandError({
                    operation: "temporaryDirectory",
                    cwd: ".",
                    command: "git",
                    detail: "Could not prepare temporary repository.",
                    cause,
                  }),
              ),
            ),
            (cwd) => routes.call({ cwd, method: "vcs.temp.remove", input: {} }).pipe(Effect.ignore),
          ),
          readInstructions: (cwd, fileName) =>
            remote.readInstructions(cwd, fileName).pipe(Effect.orElseSucceed(() => "")),
          canonicalizeExistingPath: (cwd) =>
            routes.validate(cwd).pipe(Effect.orElseSucceed(() => cwd)),
        }),
      ),
    );
  }),
);

export const registryLayer = Layer.effect(
  VcsDriverRegistry.VcsDriverRegistry,
  Effect.gen(function* () {
    const routes = yield* Routing.WorkspaceRouting;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fail = (operation: string, cwd: string) => (cause: unknown) =>
      new C.VcsRepositoryDetectionError({
        operation,
        cwd,
        detail: "Remote VCS operation failed.",
        cause,
      });
    const crypto = yield* Crypto.Crypto;
    const invoke = <A, I>(
      method: string,
      input: Readonly<Record<string, unknown>> & { cwd: string },
      schema: Schema.Codec<A, I>,
    ) =>
      Effect.gen(function* () {
        const operationId = yield* crypto.randomUUIDv4;
        const raw = yield* routes
          .call({
            cwd: input.cwd,
            method: `vcs.driver.${method}`,
            input: { ...input, method, operationId },
            operationId,
          })
          .pipe(Effect.retry(Schedule.recurs(1)));
        const envelope = yield* decodeVcsEnvelope(raw);
        if (!envelope.ok) return yield* Effect.fail(envelope.error);
        return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(envelope.value);
      }).pipe(Effect.mapError(fail(method, input.cwd)));
    const checkpoint = <A, I>(
      method: string,
      input: Readonly<Record<string, unknown>> & { cwd: string },
      schema: Schema.Codec<A, I>,
    ) =>
      routes
        .call({ cwd: input.cwd, method, input })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
          Effect.mapError(fail(method, input.cwd)),
        );
    const driver = VcsDriver.VcsDriver.of({
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: (input) =>
        git.execute({ ...input }).pipe(Effect.mapError(fail(input.operation, input.cwd))),
      detectRepository: (cwd) => invoke("detectRepository", { cwd }, P.Vcs.detectRepository.output),
      isInsideWorkTree: (cwd) => invoke("isInsideWorkTree", { cwd }, P.Vcs.isInsideWorkTree.output),
      listWorkspaceFiles: (cwd) =>
        invoke("listWorkspaceFiles", { cwd }, P.Vcs.listWorkspaceFiles.output),
      listRemotes: (cwd) => invoke("listRemotes", { cwd }, P.Vcs.listRemotes.output),
      filterIgnoredPaths: (cwd, relativePaths) =>
        invoke("filterIgnoredPaths", { cwd, relativePaths }, P.Vcs.filterIgnoredPaths.output),
      initRepository: (input) =>
        invoke("initRepository", { ...input }, P.Vcs.initRepository.output).pipe(Effect.asVoid),
      getDiffPreview: (input) =>
        invoke("getDiffPreview", { ...input }, P.Vcs.getDiffPreview.output),
      checkpoints: {
        listAuthoredPaths: (input) =>
          checkpoint("git.listAuthoredPaths", { ...input }, AuthoredPaths).pipe(
            Effect.map((paths) => (paths === null ? null : new Set(paths))),
          ),
        captureCheckpoint: (input) =>
          checkpoint("git.captureCheckpoint", { ...input }, Schema.Unknown).pipe(Effect.asVoid),
        restoreCheckpoint: (input) => checkpoint("git.restore", { ...input }, Schema.Boolean),
        diffCheckpoints: (input) => checkpoint("git.diffCheckpoints", { ...input }, Schema.String),
        hasCheckpointRef: (input) =>
          invoke("hasCheckpointRef", { ...input }, P.Vcs.hasCheckpointRef.output),
        deleteCheckpointRefs: (input) =>
          invoke("deleteCheckpointRefs", { ...input }, P.Vcs.deleteCheckpointRefs.output).pipe(
            Effect.asVoid,
          ),
      },
    });
    const get = (kind: C.VcsDriverKind) =>
      kind === "git"
        ? Effect.succeed(driver)
        : Effect.fail(
            new C.VcsUnsupportedOperationError({
              operation: "get",
              kind,
              detail: "No remote VCS driver is registered.",
            }),
          );
    const detect = (input: VcsDriverRegistry.VcsDriverResolveInput) =>
      invoke("detect", { ...input }, P.Vcs.detect.output).pipe(
        Effect.map((handle) => (handle === null ? null : { ...handle, driver })),
      );
    return VcsDriverRegistry.VcsDriverRegistry.of({
      get,
      detect,
      resolve: (input) =>
        detect(input).pipe(
          Effect.flatMap((handle) =>
            handle === null
              ? Effect.fail(
                  new C.VcsRepositoryDetectionError({
                    operation: "resolve",
                    cwd: input.cwd,
                    detail: "No supported repository was detected.",
                  }),
                )
              : Effect.succeed(handle),
          ),
        ),
    });
  }),
);
