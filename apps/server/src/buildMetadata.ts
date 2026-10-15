declare const __T3CODE_BUILD_SOURCE_REVISION__: string | undefined;

/** The revision belongs to the bundled artifact, never its launching shell. */
export function getBuildSourceRevision(): string | null {
  const revision =
    typeof __T3CODE_BUILD_SOURCE_REVISION__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_SOURCE_REVISION__;
  return revision && /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}
