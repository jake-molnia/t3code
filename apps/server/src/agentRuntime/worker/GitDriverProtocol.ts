import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
const S = Schema.String;
const N = Schema.Number;
const B = Schema.Boolean;
const Strings = Schema.Array(S);
const Cwd = { cwd: S };
const Commit = Schema.Struct({ commitSha: S });
const Push = Schema.Struct({
  status: Schema.Literals(["pushed", "skipped_up_to_date"]),
  branch: S,
  upstreamBranch: Schema.optionalKey(S),
  setUpstream: Schema.optionalKey(B),
});
const ExecuteResult = Schema.Struct({
  exitCode: N,
  stdout: S,
  stderr: S,
  stdoutTruncated: B,
  stderrTruncated: B,
});
const StatusDetails = Schema.Struct({
  isRepo: B,
  sourceControlProvider: C.VcsStatusResult.fields.sourceControlProvider,
  hasOriginRemote: B,
  isDefaultBranch: B,
  branch: Schema.NullOr(S),
  upstreamRef: Schema.NullOr(S),
  hasWorkingTreeChanges: B,
  workingTree: C.VcsStatusResult.fields.workingTree,
  branchChanges: C.VcsStatusResult.fields.branchChanges,
  hasUpstream: B,
  aheadCount: N,
  behindCount: N,
  aheadOfDefaultCount: N,
});
const RemoteStatus = Schema.Struct({
  isRepo: B,
  defaultBranch: Schema.NullOr(S),
  isDefaultBranch: B,
  branch: Schema.NullOr(S),
  upstreamRef: Schema.NullOr(S),
  hasUpstream: B,
  aheadCount: N,
  behindCount: N,
  aheadOfDefaultCount: N,
});
export const Error = Schema.Struct({
  operation: S,
  cwd: S,
  detail: S,
  command: S,
  reason: Schema.optionalKey(C.GitCommandFailureReason),
});
export const response = <T extends Schema.Top>(value: T) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), error: Error }),
  ]);

export const vcsResponse = <T extends Schema.Top>(value: T) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), error: C.VcsError }),
  ]);

export const Git = {
  execute: {
    input: Schema.Struct({
      ...Cwd,
      operation: S,
      args: Strings,
      stdin: Schema.optionalKey(S),
      env: Schema.optionalKey(Schema.Record(S, Schema.Union([S, Schema.Undefined]))),
      allowNonZeroExit: Schema.optionalKey(B),
      timeoutMs: Schema.optionalKey(Schema.NullOr(N)),
      maxOutputBytes: Schema.optionalKey(N),
      appendTruncationMarker: Schema.optionalKey(B),
      keepLineCallbacksAfterTruncation: Schema.optionalKey(B),
      progress: Schema.optionalKey(B),
    }),
    output: ExecuteResult,
  },
  status: { input: C.VcsStatusInput, output: C.VcsStatusResult },
  statusDetails: { input: Schema.Struct(Cwd), output: StatusDetails },
  statusDetailsLocal: {
    input: Schema.Struct({
      ...Cwd,
      options: Schema.optionalKey(
        Schema.Struct({
          includeDivergence: Schema.optionalKey(B),
          includeBranchChanges: Schema.optionalKey(B),
        }),
      ),
    }),
    output: StatusDetails,
  },
  statusDetailsRemote: {
    input: Schema.Struct({
      ...Cwd,
      options: Schema.optionalKey(Schema.Struct({ refreshUpstream: Schema.optionalKey(B) })),
    }),
    output: RemoteStatus,
  },
  prepareCommitContext: {
    input: Schema.Struct({ ...Cwd, filePaths: Schema.optionalKey(Strings) }),
    output: Schema.NullOr(Schema.Struct({ stagedSummary: S, stagedPatch: S })),
  },
  commit: {
    input: Schema.Struct({
      ...Cwd,
      subject: S,
      body: S,
      options: Schema.optionalKey(
        Schema.Struct({
          timeoutMs: Schema.optionalKey(N),
          stage: Schema.optionalKey(Schema.Struct({ filePaths: Schema.optionalKey(Strings) })),
        }),
      ),
      progress: Schema.optionalKey(B),
    }),
    output: Commit,
  },
  pushCurrentBranch: {
    input: Schema.Struct({
      ...Cwd,
      fallbackBranch: Schema.NullOr(S),
      options: Schema.optionalKey(
        Schema.Struct({ remoteName: Schema.optionalKey(Schema.NullOr(S)) }),
      ),
    }),
    output: Push,
  },
  readRangeContext: {
    input: Schema.Struct({ ...Cwd, baseRef: S }),
    output: Schema.Struct({ commitSummary: S, diffSummary: S, diffPatch: S }),
  },
  getReviewDiffPreview: { input: C.ReviewDiffPreviewInput, output: C.ReviewDiffPreviewResult },
  getReviewDiffFileContents: {
    input: C.ReviewDiffFileContentsInput,
    output: C.ReviewDiffFileContentsResult,
  },
  readConfigValue: { input: Schema.Struct({ ...Cwd, key: S }), output: Schema.NullOr(S) },
  listRefs: { input: C.VcsListRefsInput, output: C.VcsListRefsResult },
  pullCurrentBranch: { input: Schema.Struct(Cwd), output: C.VcsPullResult },
  createWorktree: {
    input: Schema.Struct({
      ...C.VcsCreateWorktreeInput.fields,
      options: Schema.optionalKey(
        Schema.Struct({
          submodules: Schema.optionalKey(Schema.NullOr(C.WorktreeSubmodules)),
          worktreesDirectory: Schema.optionalKey(S),
        }),
      ),
      progress: Schema.optionalKey(B),
    }),
    output: C.VcsCreateWorktreeResult,
  },
  fetchPullRequestBranch: {
    input: Schema.Struct({ ...Cwd, prNumber: N, branch: S }),
    output: Schema.Null,
  },
  fetchPullRequestHeadCommit: { input: Schema.Struct({ ...Cwd, prNumber: N }), output: Commit },
  resolveCommit: { input: Schema.Struct({ ...Cwd, revision: S }), output: Commit },
  refreshCheckedOutBranch: {
    input: Schema.Struct({
      ...Cwd,
      targetCommit: S,
      resetWhenHeadCommit: Schema.optionalKey(Schema.NullOr(S)),
    }),
    output: Schema.Struct({ headCommit: S, moved: B, onTarget: B }),
  },
  ensureRemote: { input: Schema.Struct({ ...Cwd, preferredName: S, url: S }), output: S },
  resolvePrimaryRemoteName: { input: Schema.Struct(Cwd), output: S },
  resolveDefaultBranchName: {
    input: Schema.Struct({ ...Cwd, remoteName: S }),
    output: Schema.NullOr(S),
  },
  fetchRemote: {
    input: Schema.Struct({ ...Cwd, remoteName: S, refName: Schema.optionalKey(S) }),
    output: Schema.Null,
  },
  remoteExists: { input: Schema.Struct({ ...Cwd, remoteName: S }), output: B },
  remoteBranchExists: { input: Schema.Struct({ ...Cwd, remoteName: S, refName: S }), output: B },
  resolveRemoteTrackingCommit: {
    input: Schema.Struct({ ...Cwd, refName: S, fallbackRemoteName: S }),
    output: Schema.Struct({ commitSha: S, remoteRefName: S }),
  },
  fetchRemoteBranch: {
    input: Schema.Struct({ ...Cwd, remoteName: S, remoteBranch: S, localBranch: S }),
    output: Schema.Null,
  },
  fetchRemoteTrackingBranch: {
    input: Schema.Struct({ ...Cwd, remoteName: S, remoteBranch: S }),
    output: Schema.Null,
  },
  setBranchUpstream: {
    input: Schema.Struct({ ...Cwd, branch: S, remoteName: S, remoteBranch: S }),
    output: Schema.Null,
  },
  removeWorktree: { input: C.VcsRemoveWorktreeInput, output: Schema.Null },
  pruneWorktrees: { input: Schema.Struct(Cwd), output: Schema.Null },
  listWorktreePaths: { input: Schema.Struct(Cwd), output: Strings },
  deleteLocalBranch: {
    input: Schema.Struct({ ...Cwd, refName: S, force: Schema.optionalKey(B) }),
    output: Schema.Null,
  },
  renameBranch: {
    input: Schema.Struct({ ...Cwd, oldBranch: S, newBranch: S, exactName: Schema.optionalKey(B) }),
    output: Schema.Struct({ branch: S }),
  },
  createRef: { input: C.VcsCreateRefInput, output: C.VcsCreateRefResult },
  switchRef: { input: C.VcsSwitchRefInput, output: C.VcsSwitchRefResult },
  initRepo: { input: C.VcsInitInput, output: Schema.Null },
  listLocalBranchNames: { input: Schema.Struct(Cwd), output: Strings },
  readInstructions: {
    input: Schema.Struct({
      ...Cwd,
      fileName: Schema.Literals(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]),
    }),
    output: S,
  },
} as const;
export const Vcs = {
  detect: {
    input: Schema.Struct({
      ...Cwd,
      requestedKind: Schema.optionalKey(Schema.Union([C.VcsDriverKind, Schema.Literal("auto")])),
    }),
    output: Schema.NullOr(
      Schema.Struct({ kind: C.VcsDriverKind, repository: C.VcsRepositoryIdentity }),
    ),
  },
  detectRepository: { input: Schema.Struct(Cwd), output: Schema.NullOr(C.VcsRepositoryIdentity) },
  isInsideWorkTree: { input: Schema.Struct(Cwd), output: B },
  listWorkspaceFiles: { input: Schema.Struct(Cwd), output: C.VcsListWorkspaceFilesResult },
  listRemotes: { input: Schema.Struct(Cwd), output: C.VcsListRemotesResult },
  filterIgnoredPaths: { input: Schema.Struct({ ...Cwd, relativePaths: Strings }), output: Strings },
  initRepository: { input: C.VcsInitInput, output: Schema.Null },
  getDiffPreview: { input: C.ReviewDiffPreviewInput, output: C.ReviewDiffPreviewResult },
  hasCheckpointRef: { input: Schema.Struct({ ...Cwd, checkpointRef: C.CheckpointRef }), output: B },
  deleteCheckpointRefs: {
    input: Schema.Struct({ ...Cwd, checkpointRefs: Schema.Array(C.CheckpointRef) }),
    output: Schema.Null,
  },
} as const;
export const GitRequest = Schema.Union([
  Schema.Struct({ method: Schema.Literal("execute"), operationId: S, ...Git.execute.input.fields }),
  Schema.Struct({ method: Schema.Literal("status"), operationId: S, ...Git.status.input.fields }),
  Schema.Struct({
    method: Schema.Literal("statusDetails"),
    operationId: S,
    ...Git.statusDetails.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("statusDetailsLocal"),
    operationId: S,
    ...Git.statusDetailsLocal.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("statusDetailsRemote"),
    operationId: S,
    ...Git.statusDetailsRemote.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("prepareCommitContext"),
    operationId: S,
    ...Git.prepareCommitContext.input.fields,
  }),
  Schema.Struct({ method: Schema.Literal("commit"), operationId: S, ...Git.commit.input.fields }),
  Schema.Struct({
    method: Schema.Literal("pushCurrentBranch"),
    operationId: S,
    ...Git.pushCurrentBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("readRangeContext"),
    operationId: S,
    ...Git.readRangeContext.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("getReviewDiffPreview"),
    operationId: S,
    ...Git.getReviewDiffPreview.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("getReviewDiffFileContents"),
    operationId: S,
    ...Git.getReviewDiffFileContents.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("readConfigValue"),
    operationId: S,
    ...Git.readConfigValue.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("listRefs"),
    operationId: S,
    ...Git.listRefs.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("pullCurrentBranch"),
    operationId: S,
    ...Git.pullCurrentBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("createWorktree"),
    operationId: S,
    ...Git.createWorktree.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("fetchPullRequestBranch"),
    operationId: S,
    ...Git.fetchPullRequestBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("fetchPullRequestHeadCommit"),
    operationId: S,
    ...Git.fetchPullRequestHeadCommit.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("resolveCommit"),
    operationId: S,
    ...Git.resolveCommit.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("refreshCheckedOutBranch"),
    operationId: S,
    ...Git.refreshCheckedOutBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("ensureRemote"),
    operationId: S,
    ...Git.ensureRemote.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("resolvePrimaryRemoteName"),
    operationId: S,
    ...Git.resolvePrimaryRemoteName.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("resolveDefaultBranchName"),
    operationId: S,
    ...Git.resolveDefaultBranchName.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("fetchRemote"),
    operationId: S,
    ...Git.fetchRemote.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("remoteExists"),
    operationId: S,
    ...Git.remoteExists.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("remoteBranchExists"),
    operationId: S,
    ...Git.remoteBranchExists.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("resolveRemoteTrackingCommit"),
    operationId: S,
    ...Git.resolveRemoteTrackingCommit.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("fetchRemoteBranch"),
    operationId: S,
    ...Git.fetchRemoteBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("fetchRemoteTrackingBranch"),
    operationId: S,
    ...Git.fetchRemoteTrackingBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("setBranchUpstream"),
    operationId: S,
    ...Git.setBranchUpstream.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("removeWorktree"),
    operationId: S,
    ...Git.removeWorktree.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("pruneWorktrees"),
    operationId: S,
    ...Git.pruneWorktrees.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("listWorktreePaths"),
    operationId: S,
    ...Git.listWorktreePaths.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("deleteLocalBranch"),
    operationId: S,
    ...Git.deleteLocalBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("renameBranch"),
    operationId: S,
    ...Git.renameBranch.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("createRef"),
    operationId: S,
    ...Git.createRef.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("switchRef"),
    operationId: S,
    ...Git.switchRef.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("initRepo"),
    operationId: S,
    ...Git.initRepo.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("listLocalBranchNames"),
    operationId: S,
    ...Git.listLocalBranchNames.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("readInstructions"),
    operationId: S,
    ...Git.readInstructions.input.fields,
  }),
]);
export const VcsRequest = Schema.Union([
  Schema.Struct({ method: Schema.Literal("detect"), operationId: S, ...Vcs.detect.input.fields }),
  Schema.Struct({
    method: Schema.Literal("detectRepository"),
    operationId: S,
    ...Vcs.detectRepository.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("isInsideWorkTree"),
    operationId: S,
    ...Vcs.isInsideWorkTree.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("listWorkspaceFiles"),
    operationId: S,
    ...Vcs.listWorkspaceFiles.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("listRemotes"),
    operationId: S,
    ...Vcs.listRemotes.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("filterIgnoredPaths"),
    operationId: S,
    ...Vcs.filterIgnoredPaths.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("initRepository"),
    operationId: S,
    ...Vcs.initRepository.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("getDiffPreview"),
    operationId: S,
    ...Vcs.getDiffPreview.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("hasCheckpointRef"),
    operationId: S,
    ...Vcs.hasCheckpointRef.input.fields,
  }),
  Schema.Struct({
    method: Schema.Literal("deleteCheckpointRefs"),
    operationId: S,
    ...Vcs.deleteCheckpointRefs.input.fields,
  }),
]);
export const Progress = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["stdout", "stderr", "submodule-line"]), text: S }),
  Schema.Struct({
    kind: Schema.Literal("commit-output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: S,
  }),
  Schema.Struct({ kind: Schema.Literal("hook-start"), hookName: S }),
  Schema.Struct({
    kind: Schema.Literal("hook-end"),
    hookName: S,
    exitCode: Schema.NullOr(N),
    durationMs: Schema.NullOr(N),
  }),
  Schema.Struct({ kind: Schema.Literal("worktree-claimed"), path: S }),
  Schema.Struct({ kind: Schema.Literal("checkout"), percent: N, completed: N, total: N }),
  Schema.Struct({ kind: Schema.Literal("submodules-start") }),
  Schema.Struct({
    kind: Schema.Literal("submodules-disabled"),
    source: Schema.Literals(["settings", "t3.json"]),
  }),
  Schema.Struct({ kind: Schema.Literal("submodules-end"), ok: B, detail: Schema.NullOr(S) }),
]);
export type Progress = typeof Progress.Type;

export const ProcessRequest = Schema.Struct({
  operation: S,
  command: S,
  args: Strings,
  cwd: S,
  stdin: Schema.optionalKey(S),
  env: Schema.optionalKey(Schema.Record(S, Schema.Union([S, Schema.Undefined]))),
  allowNonZeroExit: Schema.optionalKey(B),
  timeoutMs: Schema.optionalKey(N),
  maxOutputBytes: Schema.optionalKey(N),
  outputMode: Schema.optionalKey(Schema.Literals(["truncate", "error"])),
  appendTruncationMarker: Schema.optionalKey(B),
  attachments: Schema.Array(Schema.Struct({ argumentIndex: N, prefix: S, contents: S })),
});
export const ProcessResult = Schema.Struct({
  ...ExecuteResult.fields,
  stdoutInvalidUtf8: Schema.optionalKey(B),
  stderrInvalidUtf8: Schema.optionalKey(B),
});

export const isSourceControlProbe = (command: string, args: readonly string[]) =>
  ["gh", "glab", "tea", "fj", "az"].includes(command) &&
  (args[0] === "--version" ||
    (args[0] === "auth" && ["token", "status", "list"].includes(args[1] ?? "")) ||
    (args[0] === "login" && args[1] === "list") ||
    args[0] === "whoami");
