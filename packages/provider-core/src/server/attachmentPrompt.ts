import {
  type ChatAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
export function isProviderNativeImageAttachment(attachment: ChatAttachment): boolean {
  return (
    attachment.type === "image" && isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
  );
}

export function providerMessageTextWithAttachmentPaths(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Absolute path of a stored attachment, such as `ProviderHost.resolveAttachmentPath`. */
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): string {
  let text = input.text;
  const appendContext = (context: string | undefined) => {
    if (context === undefined) return;
    const candidate = text ? `${text}\n\n${context}` : context;
    if (candidate.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) text = candidate;
  };

  for (const attachment of input.attachments) {
    const path = input.resolveAttachmentPath(attachment);
    appendContext(
      path === null
        ? undefined
        : `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`,
    );
  }

  return text;
}
