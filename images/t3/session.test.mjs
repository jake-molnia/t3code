import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Session, privateLog, mcpReady, claimPreparedIde, superviseIde } from "./session.mjs";

async function fixture(t) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-session-test-"));
  const session = new Session({ cwd: directory, env: process.env, graceMs: 20 });
  t.after(async () => {
    await session.stop();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  return { directory, session };
}

NodeTest.test(
  "an essential process exit stops the worker process group",
  { timeout: 10000 },
  async (t) => {
    const { session } = await fixture(t);
    const worker = session.start(
      process.execPath,
      ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      { output: () => {} },
    );
    await NodeEvents.once(worker.child.stdout, "data");
    session.start(process.execPath, ["-e", "process.exit(17)"]);
    await session.done;
    const exit = await worker.exited;
    NodeAssert.equal(exit.signal, "SIGTERM");
    NodeAssert.match(session.failure.message, /17/);
  },
);

NodeTest.test(
  "a restartable browser exits and restarts without stopping the worker",
  { timeout: 10000 },
  async (t) => {
    const { directory, session } = await fixture(t);
    const program = NodePath.join(directory, "browser.mjs");
    await NodeFSP.writeFile(
      program,
      `import { existsSync, writeFileSync } from 'node:fs';
    if (!existsSync('profile')) { writeFileSync('profile', 'saved'); process.exit(0); }
    process.stdout.write('restarted'); setInterval(() => {}, 1000);`,
    );
    let notify;
    const restarted = new Promise((resolve) => {
      notify = resolve;
    });
    const loop = session.restart(process.execPath, [program], {
      restartMs: 1,
      output: (data) => notify(data.toString()),
    });
    NodeAssert.equal(await restarted, "restarted");
    NodeAssert.equal(await NodeFSP.readFile(NodePath.join(directory, "profile"), "utf8"), "saved");
    NodeAssert.equal(session.abort.signal.aborted, false);
    await session.stop();
    await loop;
  },
);

NodeTest.test(
  "shutdown escalates for a child which ignores SIGTERM",
  { timeout: 10000 },
  async (t) => {
    const { session } = await fixture(t);
    const child = session.start(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ],
      { output: () => {} },
    );
    await NodeEvents.once(child.child.stdout, "data");
    await session.stop();
    NodeAssert.equal((await child.exited).signal, "SIGKILL");
    NodeAssert.equal(session.failure, undefined);
  },
);

NodeTest.test(
  "private IDE diagnostics rotate without leaking or growing unbounded",
  { timeout: 10000 },
  async (t) => {
    const { directory } = await fixture(t);
    const path = NodePath.join(directory, "ide.log");
    const log = privateLog(path, 8);
    log(Buffer.from("abcdefghijklmnopqrst"));
    NodeAssert.equal(await NodeFSP.readFile(path, "utf8"), "qrst");
    NodeAssert.equal(await NodeFSP.readFile(`${path}.1`, "utf8"), "ijklmnop");
    NodeAssert.equal((await NodeFSP.stat(path)).mode & 0o777, 0o600);
  },
);

NodeTest.test("a missing essential executable fails the session", { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t);
  session.start("/does-not-exist-t3-session-test");
  await session.done;
  NodeAssert.equal(session.failure.code, "ENOENT");
  NodeAssert.equal(session.children.size, 0);
});

NodeTest.test(
  "MCP readiness negotiates protocol, reads paginated SSE tools, and closes its session",
  { timeout: 10000 },
  async (t) => {
    const methods = [];
    const server = NodeHttp.createServer(async (request, response) => {
      if (request.method === "DELETE") {
        methods.push("DELETE");
        NodeAssert.equal(request.headers["mcp-session-id"], "test-session");
        response.writeHead(204).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(message.method);
      if (message.method !== "initialize") {
        NodeAssert.equal(request.headers["mcp-session-id"], "test-session");
        NodeAssert.equal(request.headers["mcp-protocol-version"], "2025-03-26");
      }
      if (!message.id) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : message.params.cursor
            ? { tools: [{ name: "second" }] }
            : { tools: [{ name: "first" }], nextCursor: "page2" };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "test-session",
      });
      response.write('data: {"jsonrpc":"2.0","method":"notifications/ignored"}\r\n\r\n');
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\r\n\r\n`);
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    await mcpReady(`http://127.0.0.1:${server.address().port}/mcp`, ["first", "second"]);
    NodeAssert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "DELETE",
    ]);
  },
);

NodeTest.test(
  "an unresponsive IDE attempt is killed and restarted without stopping the session",
  { timeout: 10000 },
  async (t) => {
    const { directory, session } = await fixture(t);
    const program = NodePath.join(directory, "ide.mjs");
    await NodeFSP.writeFile(
      program,
      `import { existsSync, writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const first = !existsSync('attempt'); writeFileSync('attempt', 'saved');
    process.stdout.write(first ? 'unresponsive' : 'ready'); setInterval(() => {}, 1000);`,
    );
    let active;
    let notify;
    const restarted = new Promise((resolve) => {
      notify = resolve;
    });
    const loop = session.restart(process.execPath, [program], {
      restartMs: 1,
      onStart(child) {
        active = child;
      },
      output(data) {
        if (data.toString() === "unresponsive") session.terminate(active);
        else notify(data.toString());
      },
    });
    NodeAssert.equal(await restarted, "ready");
    NodeAssert.equal(session.abort.signal.aborted, false);
    await session.stop();
    await loop;
  },
);

async function waitForFile(t, path, expected) {
  return new Promise((resolve, reject) => {
    const watcher = NodeFS.watch(NodePath.dirname(path), check);
    t.after(() => watcher.close());
    async function check() {
      try {
        const value = await NodeFSP.readFile(path, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (value === expected) {
          watcher.close();
          resolve();
        }
      } catch (error) {
        watcher.close();
        reject(error);
      }
    }
    check();
  });
}

NodeTest.test(
  "IDE launch claims require preparation and publish starting before spawn",
  async (t) => {
    const { directory } = await fixture(t);
    NodeAssert.equal(await claimPreparedIde(directory), false);
    await NodeAssert.rejects(NodeFSP.readFile(NodePath.join(directory, "running")), {
      code: "ENOENT",
    });
    await NodeFSP.writeFile(NodePath.join(directory, "prepared"), "prepared");
    NodeAssert.equal(await claimPreparedIde(directory), true);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(directory, "running"), "utf8"),
      "starting",
    );
  },
);

NodeTest.test(
  "IDE preparation, pause and resume leave the worker session alive",
  { timeout: 10000 },
  async (t) => {
    const { directory, session } = await fixture(t);
    const receipt = NodePath.join(directory, "prepared");
    const status = NodePath.join(directory, "running");
    let launches = 0;
    const supervisor = superviseIde(session, {
      directory,
      binary: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      output: () => {},
      probe: async () => {
        launches++;
      },
      restartMs: 1,
    });
    t.after(async () => {
      await session.stop();
      await supervisor;
    });
    NodeAssert.equal(launches, 0);
    const firstReady = waitForFile(t, status, "ready");
    await NodeFSP.writeFile(receipt, "prepared");
    await firstReady;
    NodeAssert.equal(launches, 1);
    const paused = waitForFile(t, status, null);
    await NodeFSP.rm(receipt);
    await paused;
    NodeAssert.equal(session.abort.signal.aborted, false);
    NodeAssert.equal(session.children.size, 0);
    const resumed = waitForFile(t, status, "ready");
    await NodeFSP.writeFile(receipt, "prepared");
    await resumed;
    NodeAssert.equal(launches, 2);
    await session.stop();
    await supervisor;
    await NodeAssert.rejects(NodeFSP.readFile(status), { code: "ENOENT" });
  },
);
