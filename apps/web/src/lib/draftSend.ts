import { type DraftId, useComposerDraftStore } from "../composerDraftStore";

type SendEvent = { preventDefault: () => void };

/** Gate every send entry point before uploads, optimistic messages, or dispatch. */
export function guardDraftSend<Args extends unknown[]>(
  draftId: DraftId | null,
  defaultsPendingAtRender: boolean,
  send: (event: SendEvent | undefined, ...args: Args) => Promise<void>,
) {
  return async (event?: SendEvent, ...args: Args): Promise<void> => {
    event?.preventDefault();
    const draft = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    // A handler from the pending render still holds provisional workspace
    // values, even if resolution has already updated the store.
    if (defaultsPendingAtRender || (draftId && (!draft || draft.pendingWorkspaceDefaults))) return;
    await send(event, ...args);
  };
}
