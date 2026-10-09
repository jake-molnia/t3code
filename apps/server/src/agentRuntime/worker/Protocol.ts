import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";

export class WorkspaceExecutionError extends Schema.TaggedError<WorkspaceExecutionError>()(
  "WorkspaceExecutionError",
  { code: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
export const Checkpoint = Schema.Struct({
  cwd: Schema.NonEmptyString,
  checkpointRef: C.CheckpointRef,
});
export const CheckpointDiff = Schema.Struct({
  cwd: Schema.NonEmptyString,
  fromCheckpointRef: C.CheckpointRef,
  toCheckpointRef: C.CheckpointRef,
  ignoreWhitespace: Schema.Boolean,
});
export const Script = Schema.Struct({
  cwd: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000)),
});
export const ScriptResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  stdoutInvalidUtf8: Schema.Boolean,
  stderrInvalidUtf8: Schema.Boolean,
});
export const ScriptReceipt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("started"),
    fingerprint: Schema.String,
    incarnation: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("completed"),
    fingerprint: Schema.String,
    result: ScriptResult,
  }),
]);

export const PrepareWorkspace = Schema.Struct({
  cwd: Schema.NonEmptyString,
  sourceUrl: Schema.optional(Schema.NonEmptyString),
  refName: Schema.optional(Schema.NonEmptyString),
  branch: Schema.optional(Schema.NonEmptyString),
  submodules: Schema.optional(C.WorktreeSubmodules),
});

export const RestoreCheckpoint = Schema.Struct({ ...Checkpoint.fields, isolated: Schema.Boolean });
