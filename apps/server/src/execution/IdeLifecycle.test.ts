// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real Python pause command in a disposable directory.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeIdeLifecycle } from "./IdeLifecycle.ts";

it("pauses the editor by removing its preparation receipt and can retry", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-pause-"));
  try {
    const lifecycle = makeIdeLifecycle(directory);
    await NodeFSP.writeFile(NodePath.join(directory, "prepared"), "prepared\n");
    await lifecycle("ide.lifecycle.pause");
    await expect(NodeFSP.stat(NodePath.join(directory, "prepared"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await lifecycle("ide.lifecycle.pause");
    expect(await lifecycle("ide.lifecycle.read")).toEqual({ state: "waiting" });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
