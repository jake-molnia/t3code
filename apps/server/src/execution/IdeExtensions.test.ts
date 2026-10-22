// @effect-diagnostics nodeBuiltinImport:off -- Real native export lifecycle in disposable directories.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { openIdeExtensions } from "./IdeExtensions.ts";

it("releases only the requested export and can retry after worker replacement", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-exports-"));
  const first = await openIdeExtensions(NodePath.join(root, "one"), root);
  const second = await openIdeExtensions(NodePath.join(root, "two"), root);
  try {
    for (const workspace of ["one", "two"]) {
      await NodeFSP.mkdir(NodePath.join(root, workspace, "exports"));
      await NodeFSP.writeFile(
        NodePath.join(root, workspace, "exports", "vscode-setup-example.tar"),
        "private archive",
      );
    }
    const path = NodePath.join(root, "one", "exports", "vscode-setup-example.tar");
    await expect(second.execute("ide.extensions.releaseExport", { path })).rejects.toThrow(
      "Invalid IDE export path",
    );
    await first.execute("ide.extensions.releaseExport", { path });
    await expect(NodeFSP.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await NodeFSP.readFile(
        NodePath.join(root, "two", "exports", "vscode-setup-example.tar"),
        "utf8",
      ),
    ).toBe("private archive");
    const replacement = await openIdeExtensions(NodePath.join(root, "one"), root);
    try {
      await replacement.execute("ide.extensions.releaseExport", { path });
    } finally {
      await replacement.close();
    }
  } finally {
    await first.close();
    await second.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("distinguishes retained native installs from later sideloads of the same public identity", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-provenance-"));
  await NodeFSP.mkdir(NodePath.join(root, "extensions"));
  await NodeFSP.writeFile(
    NodePath.join(root, "managed-extensions.json"),
    JSON.stringify({
      installations: { "public.extension": { version: "1.0.0", timestamp: 100 } },
    }),
  );
  const index = (timestamp: number) =>
    NodeFSP.writeFile(
      NodePath.join(root, "extensions/extensions.json"),
      JSON.stringify([
        {
          identifier: { id: "public.extension" },
          metadata: { source: "vsix", installedTimestamp: timestamp },
        },
      ]),
    );
  const native = async () => "public.extension@1.0.0\n";
  try {
    await index(100);
    const restored = await openIdeExtensions(root, root, native);
    try {
      expect(await restored.execute("ide.extensions.read", {})).toMatchObject({ privateIds: [] });
    } finally {
      await restored.close();
    }
    await index(101);
    const sideloaded = await openIdeExtensions(root, root, native);
    try {
      expect(await sideloaded.execute("ide.extensions.read", {})).toMatchObject({
        privateIds: ["public.extension"],
      });
    } finally {
      await sideloaded.close();
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
