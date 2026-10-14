import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import { createExecutionClient } from "../execution/ExecutionClient.ts";
import * as Assets from "./worker/AssetProtocol.ts";
import * as Recording from "./PreviewRecording.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import { claimPreviewRecording } from "../mcp/toolkits/preview/handlers.ts";

const decodeRead = Schema.decodeUnknownSync(Assets.Read);
const layer = Config.layerTest(process.cwd(), { prefix: "recording-transfer-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("worker recording retention", (it) => {
  it.effect.each(["valid", "truncated", "corrupted", "oversized"] as const)(
    "retains only verified complete worker bytes: %s",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* Config.ServerConfig;
        const before = yield* fs
          .readDirectory(config.attachmentsDir)
          .pipe(Effect.orElseSucceed(() => []));
        const bytes = new TextEncoder().encode("worker recording bytes");
        const crypto = yield* Crypto.Crypto;
        const blobId = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
        let released = false;
        let snapshots = 0;
        const client = {
          ...createExecutionClient({
            endpoint: "http://unused",
            token: "test",
            identity: {
              workspaceId: "a",
              allocationId: "a",
              generation: 1,
              podUid: "a",
              incarnation: "a",
              protocolVersion: 1,
            },
          }),
          call: async (method: string, input: unknown) => {
            snapshots++;
            expect(method).toBe("asset.snapshot");
            expect(input).toEqual({ path: "/worker-only/recording.webm" });
            return { blobId, size: bytes.length, name: "recording.webm", leaseId: "lease" };
          },
          transient: async (method: string, raw: unknown) => {
            expect(method).toBe("asset.read");
            const input = decodeRead(raw);
            expect(input.leaseId).toBe("lease");
            if (input.offset === bytes.length) {
              released = true;
              return { offset: bytes.length, size: bytes.length, data: "" };
            }
            const data =
              mode === "truncated"
                ? bytes.subarray(0, 0)
                : mode === "corrupted"
                  ? bytes.map((value) => value ^ 1)
                  : bytes;
            return {
              offset: input.offset,
              size: bytes.length,
              data: Buffer.from(data).toString("base64"),
            };
          },
        };
        const artifact = {
          id: createPendingAttachmentId(".webm"),
          tabId: "tab",
          path: "/worker-only/recording.webm",
          mimeType: "video/webm",
          sizeBytes: mode === "oversized" ? C.PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 : bytes.length,
          createdAt: "2026-10-14T00:00:00.000Z",
        };
        const transfer = Recording.retain(client, C.ThreadId.make("root"), artifact);
        if (mode === "valid") {
          const retained = yield* transfer;
          const claimed = yield* claimPreviewRecording(C.ThreadId.make("root"), retained);
          expect(yield* fs.readFileString(claimed.path)).toBe("worker recording bytes");
          expect(claimed.path.startsWith(config.attachmentsDir)).toBe(true);
          const repeated = yield* transfer;
          expect(yield* claimPreviewRecording(C.ThreadId.make("root"), repeated)).toEqual(claimed);
        } else {
          expect(yield* transfer.pipe(Effect.flip)).toMatchObject({
            _tag: "PreviewAutomationRecordingTransferError",
          });
          const files = yield* fs
            .readDirectory(config.attachmentsDir)
            .pipe(Effect.orElseSucceed(() => []));
          expect(files).toEqual(before);
        }
        expect(snapshots).toBe(mode === "oversized" ? 0 : mode === "valid" ? 2 : 1);
        expect(released).toBe(mode !== "oversized");
      }),
  );
});
