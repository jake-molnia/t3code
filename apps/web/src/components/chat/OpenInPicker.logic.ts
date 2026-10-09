import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  return Boolean(input.activeProjectName);
}
