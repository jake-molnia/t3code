import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

/** Accept legacy provider links without replacing an explicit settings scope. */
export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/**
 * Category links keep the target, while an explicit target replaces the entire
 * previous selection. `environmentId` is the legacy provider deep-link target.
 */
export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};

/** Account sign-in must finish even if its original project was deleted. */
export function isMcpAuthCallback(pathname: string, searchStr: string): boolean {
  if (pathname !== "/settings/mcp") return false;
  const params = new URLSearchParams(searchStr);
  return params.get("state") !== null && (params.has("code") || params.has("error"));
}
