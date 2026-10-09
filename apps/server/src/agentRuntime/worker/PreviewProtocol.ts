import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const positive = Schema.Int.check(Schema.isGreaterThan(0));
export const ViewerOpen = Schema.Struct({
  threadId: C.ThreadId,
  tabId: C.PreviewTabId,
  maxWidth: positive,
  maxHeight: positive,
  quality: positive.check(Schema.isLessThanOrEqualTo(100)),
  canOperate: Schema.Boolean,
});
export const ViewerRef = Schema.Struct({ viewerId: Schema.NonEmptyString });
export const ViewerInput = Schema.Struct({ ...ViewerRef.fields, message: Schema.Unknown });
export const ViewerAck = Schema.Struct({ ...ViewerRef.fields, ackId: Schema.Int });
export const ViewerOutput = Schema.Union([
  Schema.TaggedStruct("frame", { data: Schema.String, ackId: Schema.Int }),
  Schema.TaggedStruct("viewport", { width: Schema.Number, height: Schema.Number }),
  Schema.TaggedStruct("control", {
    canOperate: Schema.Boolean,
    controller: Schema.Literals(["agent", "you", "another-viewer", "unclaimed"]),
    generation: Schema.Number,
    dialog: Schema.NullOr(
      Schema.Struct({ type: Schema.String, message: Schema.String, defaultValue: Schema.String }),
    ),
  }),
  Schema.TaggedStruct("probe", { x: Schema.Number, y: Schema.Number, editable: Schema.Boolean }),
  Schema.TaggedStruct("clipboard", { text: Schema.String }),
  Schema.TaggedStruct("pointer", {
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Number,
    y: Schema.Number,
    sequence: Schema.Number,
  }),
  Schema.TaggedStruct("fileChooser", {
    id: Schema.String,
    multiple: Schema.Boolean,
    accept: Schema.String,
  }),
  Schema.TaggedStruct("fileChooserClosed", { id: Schema.String }),
  Schema.TaggedStruct("download", {
    id: Schema.String,
    fileName: Schema.String,
    sizeBytes: Schema.Number,
  }),
  Schema.TaggedStruct("gone", {}),
  Schema.TaggedStruct("reconnect", {}),
]);
export const ViewerBatch = Schema.Array(ViewerOutput);
export const Automation = Schema.Struct({ request: C.PreviewAutomationRequest });
export const AutomationOutcome = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ _tag: Schema.String, message: Schema.String })),
});
export const FileChooser = Schema.Struct({
  threadId: C.ThreadId,
  tabId: C.PreviewTabId,
  chooserId: Schema.String,
  files: Schema.Array(
    Schema.Struct({ name: Schema.String, mimeType: Schema.String, data: Schema.String }),
  ),
});
export const Download = Schema.Struct({
  threadId: C.ThreadId,
  tabId: C.PreviewTabId,
  downloadId: Schema.String,
});
export const DownloadResult = Schema.NullOr(
  Schema.Struct({ fileName: Schema.String, data: Schema.String }),
);

export const HtmlPreviewInput = Schema.Struct({
  html: Schema.String,
  width: Schema.optional(Schema.Number),
  appearance: Schema.optional(Schema.Literals(["light", "dark"])),
});
export const HtmlPreviewResult = Schema.Struct({
  png: Schema.String,
  width: Schema.Number,
  contentHeight: Schema.Number,
  capturedHeight: Schema.Number,
  consoleMessages: Schema.Array(
    Schema.Struct({
      level: Schema.Literals(["log", "info", "warning", "error"]),
      text: Schema.String,
    }),
  ),
  missingImages: Schema.optionalKey(Schema.Array(Schema.String)),
});
