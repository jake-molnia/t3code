import * as Schema from "effect/Schema";

const Coordinate = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(32767),
);
const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const ScrollAmount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-100),
  Schema.isLessThanOrEqualTo(100),
);
const Dimension = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(32768));

export const SandboxComputerAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("move"), x: Coordinate, y: Coordinate }),
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: Coordinate,
    y: Coordinate,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
    clicks: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3)),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("drag"), x: Coordinate, y: Coordinate }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(65536)),
  }),
  Schema.Struct({ kind: Schema.Literal("press"), key: Key }),
  Schema.Struct({
    kind: Schema.Literal("hotkey"),
    keys: Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.Struct({ kind: Schema.Literal("scroll"), dx: ScrollAmount, dy: ScrollAmount }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
  }),
]);
export type SandboxComputerAction = typeof SandboxComputerAction.Type;

export const SandboxComputerStatus = Schema.Struct({
  available: Schema.Boolean,
  display: Schema.NullOr(Schema.String),
  resolution: Schema.Struct({ width: Schema.NullOr(Dimension), height: Schema.NullOr(Dimension) }),
  capabilities: Schema.Struct({ screenshot: Schema.Boolean, actions: Schema.Boolean }),
});
export type SandboxComputerStatus = typeof SandboxComputerStatus.Type;

export const SandboxComputerScreenshot = Schema.Struct({
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String.check(Schema.isMaxLength(32_000_000)),
    width: Dimension,
    height: Dimension,
  }),
});
export type SandboxComputerScreenshot = typeof SandboxComputerScreenshot.Type;
export const SandboxComputerActionResult = Schema.Struct({ ok: Schema.Literal(true) });
export type SandboxComputerActionResult = typeof SandboxComputerActionResult.Type;

export class SandboxComputerError extends Schema.TaggedError<SandboxComputerError>()(
  "SandboxComputerError",
  {
    operation: Schema.Literals(["status", "screenshot", "action"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sandbox computer ${this.operation} failed. Check that the thread's sandbox desktop is running.`;
  }
}
