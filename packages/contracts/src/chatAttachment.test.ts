import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ChatImageAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  UploadChatAttachment,
} from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

// The tolerant member must not catch malformed known attachments: a file over
// the size cap or an image with a bad mime has to fail its own schema, not
// slide through the open one with those constraints unchecked.
it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

it("preserves ordinary and historical images while discarding obsolete capture metadata", () => {
  const image = {
    type: "image",
    id: "historical-image",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 12,
  } satisfies ChatImageAttachment;
  const sources = [
    undefined,
    {
      kind: "snap-shot",
      capturedAt: "2026-08-24T11:00:00.000Z",
      appName: "Editor",
      windowTitle: "main.ts",
      accessibleText: "Old captured text",
      accessibility: { format: "flat-text", text: "Old text", truncated: false },
    },
    { kind: "snap-shot", accessibility: { format: "obsolete" } },
  ];
  for (const source of sources) {
    assert.deepEqual(Schema.decodeUnknownSync(ChatAttachment)({ ...image, source }), image);
    const upload = { ...image, dataUrl: "data:image/png;base64,AQID" };
    assert.deepEqual(Schema.decodeUnknownSync(UploadChatAttachment)({ ...upload, source }), upload);
  }
});
