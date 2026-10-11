// @effect-diagnostics nodeBuiltinImport:off -- Linux sandbox process ownership boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { deriveSubprocessInspectResult, parsePosixProcessTable } from "../terminal/Manager.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const shells = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "nu", "xonsh"]);
const disappeared = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const processStart = async (pid: number) => {
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
  // comm can contain spaces and parentheses; starttime is field 22.
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("IDE process identity unavailable");
  return start;
};

/** Accounts for code-server PTYs independently of browser connection leases. */
export async function makeIdeActivity(pid: number, onUncertain: (cause: unknown) => Promise<void>) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned IDE PID");
  const started = await processStart(pid);
  const ps = await NodeFSP.access("/bin/ps").then(
    () => "/bin/ps",
    () => "ps",
  );
  let warned = false;
  return async () => {
    try {
      if ((await processStart(pid)) !== started) throw new Error("IDE process identity changed");
      const { stdout } = await execute(ps, ["-eo", "pid=,ppid=,comm="], {
        timeout: 1000,
        maxBuffer: 524288,
      });
      const snapshot = parsePosixProcessTable(stdout);
      if (!snapshot.commandById.has(pid))
        throw new Error("Owned IDE missing from process snapshot");
      let activeOperations = 0;
      const pending = [...(snapshot.childrenByParent.get(pid) ?? [])];
      const visited = new Set<number>();
      while (pending.length > 0) {
        const current = pending.shift();
        if (current === undefined) break;
        if (visited.has(current)) continue;
        visited.add(current);
        const tty = await NodeFSP.readlink(`/proc/${current}/fd/0`).catch((error: unknown) => {
          if (disappeared(error)) return null;
          throw error;
        });
        if (tty?.startsWith("/dev/pts/")) {
          const command = snapshot.commandById.get(current)?.replace(/^-/, "");
          if (
            !command ||
            !shells.has(command) ||
            deriveSubprocessInspectResult(snapshot, current, "linux").hasRunningSubprocess
          )
            activeOperations++;
          // Descendants share this terminal. Count it once, not once per process.
          continue;
        }
        pending.push(...(snapshot.childrenByParent.get(current) ?? []));
      }
      if ((await processStart(pid)) !== started) throw new Error("IDE process identity changed");
      warned = false;
      return { activeOperations, pendingCallbacks: 0 };
    } catch (cause) {
      if (!warned) {
        warned = true;
        await onUncertain(cause);
      }
      return { activeOperations: 1, pendingCallbacks: 0 };
    }
  };
}
