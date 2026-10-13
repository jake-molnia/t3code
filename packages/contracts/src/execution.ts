import * as Schema from "effect/Schema";

export const ExecutionIdentity = Schema.Struct({
  workspaceId: Schema.String,
  allocationId: Schema.String,
  podUid: Schema.String,
  protocolVersion: Schema.Literal(1),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  incarnation: Schema.String,
});
export type ExecutionIdentity = typeof ExecutionIdentity.Type;

export const ExecutionOperation = Schema.Struct({
  identity: ExecutionIdentity,
  operationId: Schema.String,
  method: Schema.String,
  input: Schema.Unknown,
});
export type ExecutionOperation = typeof ExecutionOperation.Type;

export const ExecutionEvent = Schema.Struct({
  identity: ExecutionIdentity,
  sequence: Schema.Number,
  sessionId: Schema.String,
  event: Schema.Unknown,
});
export type ExecutionEvent = typeof ExecutionEvent.Type;

export const ExecutionResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.String }),
]);
export type ExecutionResult = typeof ExecutionResult.Type;
