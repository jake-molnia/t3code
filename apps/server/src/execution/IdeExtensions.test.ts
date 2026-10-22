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
