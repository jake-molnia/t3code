import { expect, it } from "vite-plus/test";
import {
  mergeIdePreferences,
  portableIdePreference,
  restoreIdePreference,
} from "./portableIdePreferences.ts";

it("retains JSONC comments, trailing commas and comments-only files", () => {
  const text = '{\n // personal theme\n "workbench.colorTheme": "Dark+",\n}\n';
  expect(portableIdePreference("settings.json", text)).toBe(text);
  expect(portableIdePreference("settings.json", "// not configured yet\n")).toBe(
    "// not configured yet\n",
  );
  expect(portableIdePreference("keybindings.json", "[// keymap\n]")).toBe("[// keymap\n]");
});

it("excludes executable paths without rewriting unrelated settings", () => {
  const local =
    '{\n // theme\n "workbench.colorTheme": "Dark+",\n "git.path": "/sandbox/bin/git"\n}';
  const portable = portableIdePreference("settings.json", local);
  expect(portable).toContain("// theme");
  expect(portable).not.toContain("/sandbox/bin/git");
  expect(restoreIdePreference("settings.json", '{"editor.fontSize":18}', local)).toContain(
    "/sandbox/bin/git",
  );
});

it("rejects invalid JSON and wrong native shapes", () => {
  expect(portableIdePreference("settings.json", '{"unfinished":')).toBeNull();
  expect(portableIdePreference("keybindings.json", "{}")).toBeNull();
  expect(portableIdePreference("snippets/test.json", "[]")).toBeNull();
});

it("merges independent files and preserves concurrent edits and invalid files", () => {
  const saved = {
    "settings.json": '{"new":true}',
    "keybindings.json": "[]",
    "snippets/a.json": "{}",
  };
  const result = mergeIdePreferences(saved, {
    baseline: { "settings.json": "{}", "keybindings.json": "[]", "snippets/a.json": "{}" },
    files: { "settings.json": '{"other":true}', "snippets/a.json": '{"snippet":{}}' },
    issues: [{ path: "keybindings.json", reason: "invalid_json" }],
  });
  expect(result.files).toEqual({ ...saved, "snippets/a.json": '{"snippet":{}}' });
  expect(result.issues).toContainEqual({ path: "settings.json", reason: "conflict" });
});

it("preserves deletions, retries and incomplete observations", () => {
  const saved = { "settings.json": "{}" };
  expect(mergeIdePreferences(saved, { baseline: saved, files: {}, issues: [] }).files).toEqual({});
  expect(mergeIdePreferences(saved, { baseline: {}, files: saved, issues: [] }).issues).toEqual([]);
  expect(
    mergeIdePreferences(saved, {
      baseline: saved,
      files: {},
      issues: [{ path: "", reason: "unavailable" }],
    }).files,
  ).toEqual(saved);
});

it("keeps deletion absent while retaining only sandbox-local settings", () => {
  expect(
    restoreIdePreference("settings.json", undefined, '{"editor.fontSize":18}'),
  ).toBeUndefined();
  const local = restoreIdePreference("settings.json", undefined, '{"git.path":"/local/git"}');
  expect(local).toContain("/local/git");
  expect(portableIdePreference("settings.json", local ?? "")).toBeUndefined();
});
