import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as ByteSize from "effect/ByteSize";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as P from "./GitDriverProtocol.ts";

const decodeGitRequest = Schema.decodeUnknownEffect(P.GitRequest);
const decodeVcsRequest = Schema.decodeUnknownEffect(P.VcsRequest);
const decodeProcessRequest = Schema.decodeUnknownEffect(P.ProcessRequest);
const decodeCwd = Schema.decodeUnknownEffect(Schema.Struct({ cwd: Schema.String }));
const encodeGitError = Schema.encodeEffect(P.Error);
const encodeVcsError = Schema.encodeEffect(Schema.toCodecJson(C.VcsError));
const encodeProcessResult = Schema.encodeEffect(P.ProcessResult);

export const makeGitDriverExecutor = <E>(options: {
  resolve: (cwd: string, allowMissing?: boolean) => Effect.Effect<string, E>;
  publish: (operationId: string, event: P.Progress) => Effect.Effect<void, never>;
}) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const process = yield* VcsProcess.VcsProcess;
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* options.resolve(".");
    const virtualPath = (absolute: string) => {
      const relative = path.relative(root, absolute);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error("Git returned a path outside the retained workspace");
      }
      return path.join("/workspace", relative);
    };
    const encode = <A, I>(
      schema: Schema.Codec<A, I>,
      effect: Effect.Effect<A, C.GitCommandError>,
    ) =>
      Effect.matchEffect(effect, {
        onSuccess: (value) =>
          Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
            Effect.map((value) => ({ ok: true, value })),
          ),
        onFailure: (error) =>
          encodeGitError({
            operation: error.operation,
            cwd: virtualPath(error.cwd),
            command: error.command,
            detail: error.detail,
            ...(error.reason === undefined ? {} : { reason: error.reason }),
          }).pipe(Effect.map((error) => ({ ok: false, error }))),
      });
    const executeGit = (raw: unknown) =>
      Effect.gen(function* () {
        const request = yield* decodeGitRequest(raw);
        const { progress: wantsProgress, ...input } =
          "progress" in request ? request : { ...request, progress: false };
        const cwd = yield* options.resolve(input.cwd, input.method === "initRepo");
        const emit = (event: P.Progress) => options.publish(input.operationId, event);
        const hooks = {
          onHookStarted: (hookName: string) => emit({ kind: "hook-start", hookName }),
          onHookFinished: (event: {
            hookName: string;
            exitCode: number | null;
            durationMs: number | null;
          }) => emit({ kind: "hook-end", ...event }),
        };
        switch (input.method) {
          case "execute":
            return yield* encode(
              P.Git.execute.output,
              git.execute({
                ...input,
                cwd,
                ...(wantsProgress
                  ? {
                      progress: {
                        ...hooks,
                        onStdoutLine: (line) => emit({ kind: "stdout", text: line }),
                        onStderrLine: (line) => emit({ kind: "stderr", text: line }),
                      },
                    }
                  : {}),
              }),
            );
          case "status":
            return yield* encode(P.Git.status.output, git.status({ ...input, cwd }));
          case "statusDetails":
            return yield* encode(P.Git.statusDetails.output, git.statusDetails(cwd));
          case "statusDetailsLocal":
            return yield* encode(
              P.Git.statusDetailsLocal.output,
              git.statusDetailsLocal(cwd, input.options),
            );
          case "statusDetailsRemote":
            return yield* encode(
              P.Git.statusDetailsRemote.output,
              git.statusDetailsRemote(cwd, input.options),
            );
          case "prepareCommitContext":
            return yield* encode(
              P.Git.prepareCommitContext.output,
              git.prepareCommitContext(cwd, input.filePaths),
            );
          case "commit":
            return yield* encode(
              P.Git.commit.output,
              git.commit(cwd, input.subject, input.body, {
                ...input.options,
                ...(wantsProgress
                  ? {
                      progress: {
                        ...hooks,
                        onOutputLine: (event) => emit({ kind: "commit-output", ...event }),
                      },
                    }
                  : {}),
              }),
            );
          case "pushCurrentBranch":
            return yield* encode(
              P.Git.pushCurrentBranch.output,
              git.pushCurrentBranch(cwd, input.fallbackBranch, input.options),
            );
          case "readRangeContext":
            return yield* encode(
              P.Git.readRangeContext.output,
              git.readRangeContext(cwd, input.baseRef),
            );
          case "getReviewDiffPreview":
            return yield* encode(
              P.Git.getReviewDiffPreview.output,
              git
                .getReviewDiffPreview({ ...input, cwd })
                .pipe(Effect.map((value) => ({ ...value, cwd: virtualPath(cwd) }))),
            );
          case "getReviewDiffFileContents":
            return yield* encode(
              P.Git.getReviewDiffFileContents.output,
              git.getReviewDiffFileContents({ ...input, cwd }),
            );
          case "readConfigValue":
            return yield* encode(P.Git.readConfigValue.output, git.readConfigValue(cwd, input.key));
          case "listRefs":
            return yield* encode(
              P.Git.listRefs.output,
              git.listRefs({ ...input, cwd }).pipe(
                Effect.map((value) => ({
                  ...value,
                  refs: value.refs.map((ref) => ({
                    ...ref,
                    worktreePath: ref.worktreePath === null ? null : virtualPath(ref.worktreePath),
                  })),
                })),
              ),
            );
          case "pullCurrentBranch":
            return yield* encode(P.Git.pullCurrentBranch.output, git.pullCurrentBranch(cwd));
          case "createWorktree":
            return yield* encode(
              P.Git.createWorktree.output,
              git
                .createWorktree(
                  {
                    ...input,
                    cwd,
                    path: input.path === null ? null : yield* options.resolve(input.path, true),
                  },
                  {
                    ...input.options,
                    ...(input.options?.worktreesDirectory
                      ? {
                          worktreesDirectory: yield* options.resolve(
                            input.options.worktreesDirectory,
                            true,
                          ),
                        }
                      : {}),
                    ...(wantsProgress
                      ? {
                          progress: {
                            onWorktreeClaimed: (claimed) =>
                              emit({ kind: "worktree-claimed", path: virtualPath(claimed) }),
                            onCheckoutProgress: (event) => emit({ kind: "checkout", ...event }),
                            onSubmodulesStarted: () => emit({ kind: "submodules-start" }),
                            onSubmodulesDisabled: (event) =>
                              emit({ kind: "submodules-disabled", ...event }),
                            onSubmoduleLine: (line) => emit({ kind: "submodule-line", text: line }),
                            onSubmodulesFinished: (event) =>
                              emit({ kind: "submodules-end", ...event }),
                          },
                        }
                      : {}),
                  },
                )
                .pipe(
                  Effect.map((result) => ({
                    ...result,
                    worktree: { ...result.worktree, path: virtualPath(result.worktree.path) },
                  })),
                ),
            );
          case "fetchPullRequestBranch":
            return yield* encode(
              P.Git.fetchPullRequestBranch.output,
              git.fetchPullRequestBranch({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "fetchPullRequestHeadCommit":
            return yield* encode(
              P.Git.fetchPullRequestHeadCommit.output,
              git.fetchPullRequestHeadCommit({ ...input, cwd }),
            );
          case "resolveBranchName":
            return yield* encode(
              P.Git.resolveBranchName.output,
              git.resolveBranchName(cwd, input.refName),
            );
          case "resolveCommit":
            return yield* encode(P.Git.resolveCommit.output, git.resolveCommit({ ...input, cwd }));
          case "refreshCheckedOutBranch":
            return yield* encode(
              P.Git.refreshCheckedOutBranch.output,
              git.refreshCheckedOutBranch({ ...input, cwd }),
            );
          case "ensureRemote":
            return yield* encode(P.Git.ensureRemote.output, git.ensureRemote({ ...input, cwd }));
          case "resolvePrimaryRemoteName":
            return yield* encode(
              P.Git.resolvePrimaryRemoteName.output,
              git.resolvePrimaryRemoteName(cwd),
            );
          case "resolveDefaultBranchName":
            return yield* encode(
              P.Git.resolveDefaultBranchName.output,
              git.resolveDefaultBranchName(cwd, input.remoteName),
            );
          case "fetchRemote":
            return yield* encode(
              P.Git.fetchRemote.output,
              git.fetchRemote({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "remoteExists":
            return yield* encode(P.Git.remoteExists.output, git.remoteExists({ ...input, cwd }));
          case "remoteBranchExists":
            return yield* encode(
              P.Git.remoteBranchExists.output,
              git.remoteBranchExists({ ...input, cwd }),
            );
          case "resolveRemoteTrackingCommit":
            return yield* encode(
              P.Git.resolveRemoteTrackingCommit.output,
              git.resolveRemoteTrackingCommit({ ...input, cwd }),
            );
          case "fetchRemoteBranch":
            return yield* encode(
              P.Git.fetchRemoteBranch.output,
              git.fetchRemoteBranch({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "fetchRemoteTrackingBranch":
            return yield* encode(
              P.Git.fetchRemoteTrackingBranch.output,
              git.fetchRemoteTrackingBranch({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "setBranchUpstream":
            return yield* encode(
              P.Git.setBranchUpstream.output,
              git.setBranchUpstream({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "removeWorktree":
            return yield* encode(
              P.Git.removeWorktree.output,
              git
                .removeWorktree({ ...input, cwd, path: yield* options.resolve(input.path) })
                .pipe(Effect.as(null)),
            );
          case "pruneWorktrees":
            return yield* encode(
              P.Git.pruneWorktrees.output,
              git.pruneWorktrees({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "listWorktreePaths":
            return yield* encode(
              P.Git.listWorktreePaths.output,
              git.listWorktreePaths(cwd).pipe(Effect.map((paths) => paths.map(virtualPath))),
            );
          case "deleteLocalBranch":
            return yield* encode(
              P.Git.deleteLocalBranch.output,
              git.deleteLocalBranch({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "renameBranch":
            return yield* encode(P.Git.renameBranch.output, git.renameBranch({ ...input, cwd }));
          case "createRef":
            return yield* encode(P.Git.createRef.output, git.createRef({ ...input, cwd }));
          case "switchRef":
            return yield* encode(P.Git.switchRef.output, git.switchRef({ ...input, cwd }));
          case "initRepo":
            return yield* encode(
              P.Git.initRepo.output,
              git.initRepo({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "listLocalBranchNames":
            return yield* encode(P.Git.listLocalBranchNames.output, git.listLocalBranchNames(cwd));
          case "readInstructions":
            return yield* encode(
              P.Git.readInstructions.output,
              Effect.gen(function* () {
                const realRoot = yield* fs.realPath(cwd);
                const target = yield* fs.realPath(path.join(realRoot, input.fileName));
                if (!target.startsWith(`${realRoot}${path.sep}`)) return "";
                const stat = yield* fs.stat(target);
                if (stat.type !== "File" || stat.size > ByteSize.bytes(20_000)) return "";
                return (yield* fs.readFileString(target)).trim();
              }).pipe(Effect.orElseSucceed(() => "")),
            );
        }
      });
    const executeVcs = (raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* decodeVcsRequest(raw);
        const cwd = yield* options.resolve(input.cwd, input.method === "initRepository");
        const vcs = yield* registry.get("git");
        const encodeVcs = <A, I>(
          schema: Schema.Codec<A, I>,
          effect: Effect.Effect<A, C.VcsError>,
        ) =>
          Effect.matchEffect(effect, {
            onSuccess: (value) =>
              Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
                Effect.map((value) => ({ ok: true, value })),
              ),
            onFailure: (error) =>
              encodeVcsError(error).pipe(Effect.map((error) => ({ ok: false, error }))),
          });
        const repository = (value: C.VcsRepositoryIdentity) => ({
          ...value,
          rootPath: virtualPath(value.rootPath),
          metadataPath:
            value.metadataPath === null ? null : virtualPath(path.resolve(cwd, value.metadataPath)),
        });
        switch (input.method) {
          case "detect":
            return yield* encodeVcs(
              P.Vcs.detect.output,
              registry
                .detect({ ...input, cwd })
                .pipe(
                  Effect.map((handle) =>
                    handle === null
                      ? null
                      : { kind: handle.kind, repository: repository(handle.repository) },
                  ),
                ),
            );
          case "detectRepository":
            return yield* encodeVcs(
              P.Vcs.detectRepository.output,
              vcs
                .detectRepository(cwd)
                .pipe(Effect.map((value) => (value === null ? null : repository(value)))),
            );
          case "isInsideWorkTree":
            return yield* encodeVcs(P.Vcs.isInsideWorkTree.output, vcs.isInsideWorkTree(cwd));
          case "listWorkspaceFiles":
            return yield* encodeVcs(P.Vcs.listWorkspaceFiles.output, vcs.listWorkspaceFiles(cwd));
          case "listRemotes":
            return yield* encodeVcs(P.Vcs.listRemotes.output, vcs.listRemotes(cwd));
          case "filterIgnoredPaths":
            return yield* encodeVcs(
              P.Vcs.filterIgnoredPaths.output,
              vcs.filterIgnoredPaths(cwd, input.relativePaths),
            );
          case "initRepository":
            return yield* encodeVcs(
              P.Vcs.initRepository.output,
              vcs.initRepository({ ...input, cwd }).pipe(Effect.as(null)),
            );
          case "getDiffPreview":
            return yield* encodeVcs(
              P.Vcs.getDiffPreview.output,
              vcs.getDiffPreview
                ? vcs
                    .getDiffPreview({ ...input, cwd })
                    .pipe(Effect.map((value) => ({ ...value, cwd: virtualPath(cwd) })))
                : Effect.fail(
                    new C.VcsUnsupportedOperationError({
                      kind: "git",
                      operation: input.method,
                      detail: "Review previews are unavailable.",
                    }),
                  ),
            );
          case "hasCheckpointRef":
            return yield* encodeVcs(
              P.Vcs.hasCheckpointRef.output,
              vcs.checkpoints
                ? vcs.checkpoints.hasCheckpointRef({ ...input, cwd })
                : Effect.fail(
                    new C.VcsUnsupportedOperationError({
                      operation: input.method,
                      kind: "git",
                      detail: "Checkpoints are unavailable.",
                    }),
                  ),
            );
          case "deleteCheckpointRefs":
            return yield* encodeVcs(
              P.Vcs.deleteCheckpointRefs.output,
              vcs.checkpoints
                ? vcs.checkpoints.deleteCheckpointRefs({ ...input, cwd }).pipe(Effect.as(null))
                : Effect.fail(
                    new C.VcsUnsupportedOperationError({
                      operation: input.method,
                      kind: "git",
                      detail: "Checkpoints are unavailable.",
                    }),
                  ),
            );
        }
      });
    const executeProcess = (raw: unknown, probe = false) =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* decodeProcessRequest(raw);
          if (probe && !P.isSourceControlProbe(input.command, input.args))
            return yield* new C.VcsUnsupportedOperationError({
              operation: input.operation,
              kind: "git",
              detail: "Only source-control authentication probes use this route.",
            });
          const cwd = yield* options.resolve(input.cwd);
          const args = [...input.args];
          if (input.attachments.length) {
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-" });
            for (const attachment of input.attachments) {
              const file = path.join(directory, `${attachment.argumentIndex}.txt`);
              yield* fs.writeFileString(file, attachment.contents);
              args[attachment.argumentIndex] = `${attachment.prefix}${file}`;
            }
          }
          return yield* Effect.matchEffect(process.run({ ...input, cwd, args }), {
            onSuccess: (value) =>
              encodeProcessResult(value).pipe(Effect.map((value) => ({ ok: true, value }))),
            onFailure: (error) =>
              encodeVcsError(error).pipe(Effect.map((error) => ({ ok: false, error }))),
          });
        }),
      );
    const execute = (method: string, raw: unknown) =>
      Effect.gen(function* () {
        if (method === "vcs.temp.create" || method === "vcs.temp.remove") {
          const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ cwd: Schema.String }))(
            raw,
          );
          const cwd = yield* options.resolve(input.cwd);
          if (method === "vcs.temp.create")
            return virtualPath(
              yield* fs.makeTempDirectory({ directory: cwd, prefix: "t3-source-control-" }),
            );
          if (!path.basename(cwd).startsWith("t3-source-control-"))
            return yield* new C.GitCommandError({
              operation: method,
              cwd: input.cwd,
              command: "git",
              detail: "Invalid temporary repository path.",
            });
          yield* fs.remove(cwd, { recursive: true });
          return null;
        }
        if (method === "vcs.process.probe")
          return yield* executeProcess(raw, true).pipe(Effect.map((value): unknown => value));
        if (method === "vcs.process")
          return yield* executeProcess(raw).pipe(Effect.map((value): unknown => value));
        if (method.startsWith("git.driver."))
          return yield* executeGit(raw).pipe(Effect.map((value): unknown => value));
        return yield* executeVcs(raw).pipe(Effect.map((value): unknown => value));
      });
    return { execute };
  });
