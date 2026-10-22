import type { SandboxIdePreferenceFiles, SandboxIdePreferenceSnapshot } from "@t3tools/contracts";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export const defaultIdePreferences: SandboxIdePreferenceFiles = {
  "settings.json":
    '{\n  "security.workspace.trust.enabled": false,\n  "workbench.startupEditor": "none",\n  "workbench.secondarySideBar.defaultVisibility": "hidden",\n  "chat.tips.enabled": false,\n  "extensions.autoUpdate": false,\n  "extensions.autoCheckUpdates": false\n}\n',
};

const localSettings =
  /^(terminal\.integrated\.(env|profiles)\.|git\.path$|python\.(pythonPath|defaultInterpreterPath)$|typescript\.tsdk$|eslint\.nodePath$|java\.jdt\.ls\.java\.home$|rust-analyzer\.server\.path$)/;

/** Keep native JSONC text intact, except for settings tied to one machine. */
export function portableIdePreference(path: string, text: string): string | null {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) return null;
  if (value === undefined) return text;
  if (path === "keybindings.json") return Array.isArray(value) ? text : null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (path !== "settings.json") return text;
  let portable = text;
  for (const key of Object.keys(value)) {
    if (localSettings.test(key))
      portable = applyEdits(portable, modify(portable, [key], undefined, {}));
  }
  return portable;
}

export function mergeIdePreferences(
  saved: SandboxIdePreferenceFiles,
  snapshot: SandboxIdePreferenceSnapshot,
) {
  const files = { ...saved };
  const issues = snapshot.issues.filter((issue) => issue.reason !== "conflict");
  const baseline = snapshot.baseline ?? {};
  if (issues.some((issue) => issue.path === "")) return { files, issues };
  const invalid = new Set(issues.map((issue) => issue.path));
  for (const path of new Set([...Object.keys(baseline), ...Object.keys(snapshot.files)])) {
    if (invalid.has(path)) continue;
    const before = baseline[path];
    const next = snapshot.files[path];
    if (before === next) continue;
    if (saved[path] !== before && saved[path] !== next) {
      issues.push({ path, reason: "conflict" });
      continue;
    }
    if (next === undefined) delete files[path];
    else files[path] = next;
  }
  return { files, issues };
}

/** Restore portable settings while retaining this sandbox's executable paths and terminal environment. */
export function restoreIdePreference(
  path: string,
  saved: string | undefined,
  local: string,
): string | undefined {
  if (path !== "settings.json") return saved;
  const value: unknown = parse(local);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return saved;
  let result = saved ?? "{}";
  for (const [key, valueAtKey] of Object.entries(value)) {
    if (localSettings.test(key)) result = applyEdits(result, modify(result, [key], valueAtKey, {}));
  }
  return result;
}
