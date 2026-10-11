// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Real owned PTYs and process lifetime proof.
import { it, expect } from "vite-plus/test";
import * as pty from "node-pty";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { makeIdeActivity } from "./IdeActivity.ts";

it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
  "counts real IDE terminal jobs after disconnection without pinning idle shells",
  async () => {
    const terminal = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
      env: { ...process.env, PS1: "IDE_TEST_READY> ", TERM: "xterm" },
    });
    let output = "";
    let changed = () => {};
    const subscription = terminal.onData((data) => {
      output += data;
      changed();
    });
    const marker = (text: string, from = 0) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Missing terminal marker ${text}`)),
          5000,
        );
        changed = () => {
          if (output.slice(from).includes(text)) {
            clearTimeout(timeout);
            changed = () => {};
            resolve();
          }
        };
        changed();
      });
    let warnings = 0;
    const activity = await makeIdeActivity(process.pid, async (cause) => {
      warnings++;
      throw cause;
    });
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ide-activity-"));
    const journal = await openWorkerJournal(NodePath.join(directory, "journal"));
    const identity = {
      workspaceId: "ide-test",
      allocationId: "one",
      generation: 1,
      incarnation: "one",
      podUid: "one",
      protocolVersion: 1 as const,
    };
    const token = "ide-activity-test-worker-token-long-enough";
    const worker = createExecutionWorker({
      identity,
      token,
      journal,
      activity,
      execute: async () => null,
    });
    const transition = (action: "quiesce" | "resume", revision: number) =>
      worker.handle(
        new Request(`http://worker/v1/${action}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ identity, revision, operationId: `${action}:${revision}` }),
        }),
      );
    try {
      await marker("IDE_TEST_READY> ");
      expect((await activity()).activeOperations).toBe(0);
      let offset = output.length;
      terminal.write("sleep 30 &\n");
      await marker("IDE_TEST_READY> ", offset);
      expect((await activity()).activeOperations).toBe(1);
      expect((await transition("quiesce", 1)).status).toBe(409);
      offset = output.length;
      terminal.write("kill %1; wait %1; printf 'CHILD_%s_DONE\\n' IDE\n");
      await marker("CHILD_IDE_DONE", offset);
      expect((await activity()).activeOperations).toBe(0);
      expect((await transition("quiesce", 1)).status).toBe(200);
      expect((await transition("resume", 2)).status).toBe(200);
      offset = output.length;
      terminal.write(
        'exec python3 -c \'import time; print("EXEC_"+"READY", flush=True); time.sleep(30)\'\n',
      );
      await marker("EXEC_READY", offset);
      expect((await activity()).activeOperations).toBe(1);
      expect((await transition("quiesce", 3)).status).toBe(409);
      expect(warnings).toBe(0);
    } finally {
      subscription.dispose();
      terminal.kill();
      await journal.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
  "rejects an unowned or missing IDE process at startup",
  async () => {
    await expect(makeIdeActivity(-1, async () => {})).rejects.toThrow("Invalid owned IDE PID");
    await expect(makeIdeActivity(2147483647, async () => {})).rejects.toThrow();
  },
);

it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
  "retains compute on lost owned-process identity and reports uncertainty once",
  async () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      if (!child.stdout) throw new Error("Missing child output pipe");
      await NodeEvents.EventEmitter.once(child.stdout, "data");
      if (!child.pid) throw new Error("Missing spawned PID");
      let warnings = 0;
      const activity = await makeIdeActivity(child.pid, async () => {
        warnings++;
      });
      expect((await activity()).activeOperations).toBe(0);
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
      expect((await activity()).activeOperations).toBe(1);
      expect((await activity()).activeOperations).toBe(1);
      expect(warnings).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  },
);
