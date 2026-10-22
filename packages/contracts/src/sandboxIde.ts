import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const SandboxIdeTarget = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ projectId: ProjectId }),
]);
export type SandboxIdeTarget = typeof SandboxIdeTarget.Type;

export const SandboxIdeOpenInput = Schema.Struct({
  target: SandboxIdeTarget,
  cwd: Schema.String.check(Schema.isPattern(/^\//)),
  file: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\//))),
});
export type SandboxIdeOpenInput = typeof SandboxIdeOpenInput.Type;
export const SandboxIdeOpenResult = Schema.Struct({ url: Schema.String });
export type SandboxIdeOpenResult = typeof SandboxIdeOpenResult.Type;

export const SandboxIdePreferencePath = Schema.String.check(
  Schema.isPattern(/^(settings\.json|keybindings\.json|snippets\/[\w .-]+\.(json|code-snippets))$/),
  Schema.isMaxLength(200),
);
export const SandboxIdePreferenceFiles = Schema.Record(
  SandboxIdePreferencePath,
  Schema.String.check(Schema.isMaxLength(262144)),
);
export type SandboxIdePreferenceFiles = typeof SandboxIdePreferenceFiles.Type;
export const SandboxIdePreferenceIssue = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals([
    "invalid_json",
    "conflict",
    "import_required",
    "unavailable",
    "too_large",
  ]),
});
export const SandboxIdePreferenceStatus = Schema.Struct({
  state: Schema.Literals(["not_opened", "saved", "pending", "needs_attention", "offline"]),
  issues: Schema.Array(SandboxIdePreferenceIssue),
});
export type SandboxIdePreferenceStatus = typeof SandboxIdePreferenceStatus.Type;

export const SandboxIdePreferenceSnapshot = Schema.Struct({
  baseline: Schema.NullOr(SandboxIdePreferenceFiles),
  files: SandboxIdePreferenceFiles,
  issues: Schema.Array(SandboxIdePreferenceIssue),
});
export type SandboxIdePreferenceSnapshot = typeof SandboxIdePreferenceSnapshot.Type;

export const SandboxIdePreferenceRead = Schema.Struct({
  revision: Schema.String,
  snapshot: Schema.NullOr(SandboxIdePreferenceSnapshot),
});
export const SandboxIdePreferenceResolveInput = Schema.Struct({
  target: SandboxIdeTarget,
  path: SandboxIdePreferencePath,
  choice: Schema.Literals(["workspace", "saved"]),
});
export type SandboxIdePreferenceResolveInput = typeof SandboxIdePreferenceResolveInput.Type;

export const IdeExtensionId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/),
  Schema.isMaxLength(200),
);
export const IdeExtensionVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+[a-zA-Z0-9.+-]*$/),
  Schema.isMaxLength(100),
);
export const IdeExtensionInventory = Schema.Record(IdeExtensionId, IdeExtensionVersion);
export type IdeExtensionInventory = typeof IdeExtensionInventory.Type;
export const IdeDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const IdeExtensionSource = Schema.Struct({
  id: IdeExtensionId,
  version: IdeExtensionVersion,
  archive: Schema.NullOr(IdeDigest),
});
export const IdeExtensionSources = Schema.Array(IdeExtensionSource).check(Schema.isMaxLength(256));
export const IdeExtensionSnapshot = Schema.Struct({
  provisioning: Schema.Boolean,
  baseline: Schema.NullOr(IdeExtensionInventory),
  installed: IdeExtensionInventory,
  privateIds: Schema.Array(IdeExtensionId),
  applied: Schema.NullOr(IdeDigest),
});
export const IdeExtensionAcknowledgement = Schema.Struct({
  baseline: IdeExtensionInventory,
  applied: Schema.NullOr(IdeDigest),
});
export const IdeExtensionBuildInput = Schema.Struct({
  previous: Schema.NullOr(Schema.Struct({ path: Schema.String, digest: IdeDigest })),
  revision: IdeDigest,
  sources: IdeExtensionSources,
  archives: Schema.Array(Schema.Struct({ digest: IdeDigest, path: Schema.String })),
});
export const IdeExtensionBuildResult = Schema.Struct({
  sources: IdeExtensionSources,
  path: Schema.String,
  flake: Schema.String,
  lock: Schema.String,
});
export const IdeExtensionInstallInput = Schema.Struct({
  replace: Schema.Boolean,
  revision: IdeDigest,
  digest: IdeDigest,
  path: Schema.String,
});
export const IdeExtensionExportInput = Schema.Struct({
  files: SandboxIdePreferenceFiles,
  bundle: Schema.NullOr(Schema.Struct({ path: Schema.String, digest: IdeDigest })),
});

export const IdeSetupBuild = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("building"), revision: IdeDigest }),
  Schema.Struct({ state: Schema.Literal("ready"), revision: IdeDigest }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    revision: IdeDigest,
    reason: Schema.Literals(["build_failed", "archive_missing", "conflict", "incompatible"]),
  }),
]);
export const IdeSetupStage = Schema.Literals([
  "not_opened",
  "waking",
  "applying_settings",
  "restoring_extensions",
  "starting",
  "ready",
  "ready_with_errors",
  "unavailable",
]);
export type IdeSetupStage = typeof IdeSetupStage.Type;
export const IdeSetupState = Schema.Struct({
  stage: IdeSetupStage,
  remembering: Schema.Boolean,
  settingsRevision: Schema.String,
  settingsMatch: Schema.NullOr(Schema.Boolean),
  previousSettingsRevision: Schema.NullOr(Schema.String),
  extensions: IdeExtensionSources,
  build: IdeSetupBuild,
  publishedRevision: Schema.NullOr(IdeDigest),
  previousPublishedRevision: Schema.NullOr(IdeDigest),
  appliedRevision: Schema.NullOr(IdeDigest),
  preferences: SandboxIdePreferenceStatus,
});
export type IdeSetupState = typeof IdeSetupState.Type;
export const IdeSetupCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("remember"), enabled: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literals([
      "apply",
      "import",
      "retry",
      "reset_settings",
      "reset_extensions",
      "rollback_settings",
      "rollback_extensions",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("import_vsix"),
    path: Schema.String.check(Schema.isPattern(/^\//)),
  }),
]);
export const IdeSetupCommandInput = Schema.Struct({
  target: Schema.optionalKey(SandboxIdeTarget),
  command: IdeSetupCommand,
});
export type IdeSetupCommandInput = typeof IdeSetupCommandInput.Type;
export const IdeSetupExport = Schema.Struct({
  attachmentId: Schema.String,
  files: SandboxIdePreferenceFiles,
  extensions: IdeExtensionSources,
  flake: Schema.String,
  lock: Schema.String,
  bundlePath: Schema.NullOr(Schema.String),
});

export class SandboxIdeError extends Schema.TaggedError<SandboxIdeError>()("SandboxIdeError", {
  reason: Schema.Literals(["unavailable", "expired", "identity_changed", "forbidden"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return this.reason === "identity_changed"
      ? "The sandbox changed. Open VS Code again from the thread."
      : this.reason === "expired"
        ? "This IDE session expired. Open VS Code again from the thread."
        : "The sandbox IDE is unavailable.";
  }
}
