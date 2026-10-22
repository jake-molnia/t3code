// @effect-diagnostics nodeBuiltinImport:off -- Native preference files in temporary directories.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { SandboxIdePreferenceRead } from "@t3tools/contracts";
import { defaultIdePreferences } from "../agentRuntime/portableIdePreferences.ts";
import { openIdePreferences } from "./IdePreferences.ts";

const decode = Schema.decodeUnknownSync(SandboxIdePreferenceRead);

it("restores native files, isolates roots, rejects stale acknowledgements and retains state across replacement", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-preferences-"));
  let first = await openIdePreferences(NodePath.join(root, "one/ide"));
  const second = await openIdePreferences(NodePath.join(root, "two/ide"));
  const files = { "settings.json": '{// comment\n"editor.fontSize":14}', "snippets/a.json": "{}" };
  try {
    await first.execute("ide.preferences.initialize", { files });
    await second.execute("ide.preferences.initialize", { files });
    expect(
      await NodeFSP.readFile(NodePath.join(root, "one/ide/user-data/User/settings.json"), "utf8"),
    ).toBe(files["settings.json"]);
    const changed = '{"editor.fontSize":18}';
    await NodeFSP.writeFile(NodePath.join(root, "one/ide/user-data/User/settings.json"), changed);
    const refused = decode(
      await first.execute("ide.preferences.acknowledge", { baseline: files, files, issues: [] }),
    );
    expect(refused.snapshot?.baseline).toEqual(files);
    expect(refused.snapshot?.files["settings.json"]).toBe(changed);
    expect(
      decode(await second.execute("ide.preferences.read", { force: true })).snapshot?.files,
    ).toEqual(files);
    await first.close();
    first = await openIdePreferences(NodePath.join(root, "one/ide"));
    expect(decode(await first.execute("ide.preferences.read", {})).snapshot?.baseline).toEqual(
      files,
    );
    const next = decode(await first.execute("ide.preferences.read", {}));
    const acknowledged = decode(
      await first.execute("ide.preferences.acknowledge", {
        baseline: files,
        files: next.snapshot?.files,
        issues: [],
      }),
    );
    expect(
      decode(await first.execute("ide.preferences.read", { after: acknowledged.revision }))
        .snapshot,
    ).toBeNull();
  } finally {
    await first.close();
    await second.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("preserves invalid local edits and backs up conflicts before choosing saved settings", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-preferences-"));
  const preferences = await openIdePreferences(root);
  const file = NodePath.join(root, "user-data/User/settings.json");
  const files = { "settings.json": '{"editor.fontSize":14}' };
  try {
    await preferences.execute("ide.preferences.initialize", { files });
    await NodeFSP.writeFile(file, '{"broken":');
    const invalid = decode(await preferences.execute("ide.preferences.read", { force: true }));
    expect(invalid.snapshot?.issues).toContainEqual({
      path: "settings.json",
      reason: "invalid_json",
    });
    expect(invalid.snapshot?.baseline).toEqual(files);
    await expect(
      preferences.execute("ide.preferences.resolve", {
        path: "settings.json",
        choice: "saved",
        files,
      }),
    ).rejects.toThrow();
    const local = '{"editor.fontSize":18,"git.path":"/local/git"}';
    await NodeFSP.writeFile(file, local);
    await preferences.execute("ide.preferences.resolve", {
      path: "settings.json",
      choice: "saved",
      files,
    });
    expect(await NodeFSP.readFile(file, "utf8")).toContain('"/local/git"');
    const backups = await NodeFSP.readdir(NodePath.join(root, "preference-backups"));
    expect(backups).toHaveLength(1);
    expect(
      await NodeFSP.readFile(NodePath.join(root, "preference-backups", backups[0]!), "utf8"),
    ).toBe(local);
  } finally {
    await preferences.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps an undo made during upload pending against the newly saved baseline", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-upload-"));
  const preferences = await openIdePreferences(root);
  const original = { "settings.json": '{"editor.fontSize":14}' };
  const uploaded = { "settings.json": '{"editor.fontSize":18}' };
  const file = NodePath.join(root, "user-data/User/settings.json");
  try {
    await preferences.execute("ide.preferences.initialize", { files: original });
    await NodeFSP.writeFile(file, uploaded["settings.json"]);
    await preferences.execute("ide.preferences.read", { force: true });
    await NodeFSP.writeFile(file, original["settings.json"]);
    const result = decode(
      await preferences.execute("ide.preferences.acknowledge", {
        baseline: original,
        files: uploaded,
        issues: [],
      }),
    );
    expect(result.snapshot?.baseline).toEqual(uploaded);
    expect(result.snapshot?.files).toEqual(original);
    const stale = decode(
      await preferences.execute("ide.preferences.acknowledge", {
        baseline: original,
        files: original,
        issues: [],
      }),
    );
    expect(stale.snapshot?.baseline).toEqual(uploaded);
  } finally {
    await preferences.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("requires explicit import of existing native files, including after worker replacement", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-existing-"));
  await NodeFSP.mkdir(NodePath.join(root, "user-data/User/snippets"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "user-data/User/snippets/old.json"), "{}");
  let preferences = await openIdePreferences(root);
  try {
    const initial = decode(await preferences.execute("ide.preferences.initialize", { files: {} }));
    expect(initial.snapshot?.issues).toContainEqual({
      path: "snippets/old.json",
      reason: "import_required",
    });
    await preferences.close();
    preferences = await openIdePreferences(root);
    expect(
      decode(await preferences.execute("ide.preferences.read", {})).snapshot?.issues,
    ).toContainEqual({ path: "snippets/old.json", reason: "import_required" });
    const resolved = decode(
      await preferences.execute("ide.preferences.resolve", {
        path: "snippets/old.json",
        choice: "workspace",
        files: {},
      }),
    );
    expect(resolved.snapshot?.issues).toEqual([]);
  } finally {
    await preferences.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("seeds startup defaults without creating an import conflict and restores saved choices in a new root", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-defaults-"));
  const first = await openIdePreferences(NodePath.join(root, "one"));
  const second = await openIdePreferences(NodePath.join(root, "two"));
  try {
    const initial = decode(
      await first.execute("ide.preferences.initialize", { files: defaultIdePreferences }),
    );
    expect(initial.snapshot?.issues).toEqual([]);
    const settings = await NodeFSP.readFile(
      NodePath.join(root, "one/user-data/User/settings.json"),
      "utf8",
    );
    expect(settings).toContain('"workbench.secondarySideBar.defaultVisibility": "hidden"');
    expect(settings).toContain('"chat.tips.enabled": false');
    expect(settings).not.toContain('"workbench.colorTheme"');
    expect(settings).not.toContain('"chat.disableAIFeatures"');
    const saved = {
      "settings.json":
        '{// chosen in VS Code\n"workbench.colorTheme":"Light Modern","chat.tips.enabled":true}',
    };
    const restored = decode(await second.execute("ide.preferences.initialize", { files: saved }));
    expect(restored.snapshot?.issues).toEqual([]);
    expect(restored.snapshot?.files).toEqual(saved);
    expect(
      await NodeFSP.readFile(NodePath.join(root, "two/user-data/User/settings.json"), "utf8"),
    ).toBe(saved["settings.json"]);
  } finally {
    await first.close();
    await second.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
