#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const entrypoint = NodePath.resolve(process.argv[2] ?? "apps/server/dist/bin.mjs");
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-central-"));
try {
  for (let boot = 0; boot < 2; boot++) {
    const listener = NodeNet.createServer();
    listener.listen(0, "127.0.0.1");
    await NodeEvents.once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        entrypoint,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        directory,
        "--no-browser",
        "--log-level",
        "debug",
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, T3CODE_HOME: directory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = NodeEvents.once(child, "exit");
    let output = "";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Central startup deadline exceeded.")),
          30000,
        );
        const receive = (data) => {
          output = (output + data.toString()).slice(-262144);
          if (output.includes("Accepting commands")) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on("data", receive);
        child.stderr.on("data", receive);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Central server exited before readiness (${code}).`));
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(5000),
      });
      NodeAssert.equal(response.status, 200);
      const descriptor = await response.json();
      NodeAssert.ok(descriptor.environmentId);
    } finally {
      child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(escalation);
    }
    const sql = new NodeSqlite.DatabaseSync(
      NodePath.join(directory, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      NodeAssert.equal(sql.prepare("SELECT count(*) AS n FROM t3_sandbox_lifecycle").get().n, 0);
      NodeAssert.equal(
        sql
          .prepare("SELECT count(*) AS n FROM t3_sandbox_migrations WHERE id = 'native-cutover'")
          .get().n,
        1,
      );
    } finally {
      sql.close();
    }
  }
  process.stdout.write(
    "Bundled central server boots and restarts with native lifecycle state and no configured execution pools.\n",
  );
} finally {
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
