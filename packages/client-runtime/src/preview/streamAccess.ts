/** Credentials for media requests that cannot set bearer or DPoP headers. */
export interface PreviewStreamAccess {
  /** Absolute environment URL ending in `/api/preview-stream`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Empty for cookie sessions; includes a short-lived ticket for bearer and DPoP sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withPreviewStreamQuery = (url: string, access: PreviewStreamAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
