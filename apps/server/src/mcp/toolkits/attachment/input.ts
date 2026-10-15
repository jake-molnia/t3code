import { ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const McpAttachmentInput = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
