/** Clone credentials belong in configured credential stores, not persisted project URLs. */
export function validateCloneSourceUrl(value: string): string {
  if (/^git@[^/:\s]+:[^\s?#]+$/.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Use an HTTPS or SSH repository clone URL.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
    parsed.search ||
    parsed.hash ||
    parsed.password ||
    (parsed.protocol === "https:" && parsed.username)
  )
    throw new Error(
      "Repository URLs must not contain embedded credentials, query tokens or fragments. Configure Git credentials separately.",
    );
  return value;
}
/** Repository metadata may observe a user-edited Git config; never return credentials to clients. */
export function redactRepositoryUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.hostname || parsed.protocol === "file:") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    /* Git also accepts SCP-style remotes. */
  }
  return value
    .replace(/(\/\/)[^/]*@/, "$1")
    .replace(/^[^/]*@(?=[^/:]+:)/, "git@")
    .replace(/[?#].*$/, "");
}
