// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The runtime owns the editor process; this adapter controls its preparation receipt.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { writeIdeFile } from "./IdePreferences.ts";

export function makeIdeLifecycle(directory: string) {
  const receipt = NodePath.join(directory, "prepared");
  const status = NodePath.join(directory, "running");
  const read = async () => {
    try {
      return await NodeFSP.readFile(status, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "waiting";
      throw error;
    }
  };
  const waitFor = async (predicate: (state: string) => boolean) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (predicate(await read())) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("IDE supervisor did not reach the requested state");
  };
  return async (method: string) => {
    if (method === "ide.lifecycle.read") return { state: await read() };
    if (method === "ide.lifecycle.pause") {
      await NodeUtil.promisify(NodeChildProcess.execFile)("python3", [
        "-c",
        [
          "import fcntl, pathlib, sys",
          "root = pathlib.NodePath(sys.argv[1])",
          "root.mkdir(parents=True, exist_ok=True)",
          "with (root / 'control.lock').open('a') as lock:",
          "    fcntl.flock(lock, fcntl.LOCK_EX)",
          "    (root / 'prepared').unlink(missing_ok=True)",
        ].join("\n"),
        directory,
      ]);
      await waitFor((state) => state === "waiting");
      return null;
    }
    if (method === "ide.lifecycle.resume") {
      await writeIdeFile(receipt, "prepared\n");
      await waitFor((state) => state === "ready");
      return null;
    }
    throw new Error("Unknown IDE lifecycle operation");
  };
}
