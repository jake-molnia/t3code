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
