import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";

const entrypoint = NodeURL.fileURLToPath(import.meta.url);

// Every child has its own process group, so shutdown includes extension hosts and shells.
export class Session {
  children = new Set();
  abort = new AbortController();
  failure;

  constructor({ cwd, env, graceMs = 3000 }) {
    this.cwd = cwd;
    this.env = env;
    this.graceMs = graceMs;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  start(binary, args = [], { env = this.env, output, essential = true, timeout } = {}) {
    if (this.abort.signal.aborted) throw new Error("Session has stopped");
    const child = NodeChildProcess.spawn(binary, args, {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ["ignore", output ? "pipe" : "inherit", output ? "pipe" : "inherit"],
    });
    this.children.add(child);
    const timer = timeout
      ? setTimeout(() => this.terminate(child).catch((error) => this.stop(error)), timeout)
      : undefined;
    child.once("close", () => clearTimeout(timer));
    if (output) {
      child.stdout.on("data", output);
      child.stderr.on("data", output);
    }
    const exited = new Promise((resolve) => {
      child.once("error", (error) => {
        if (essential) this.stop(error);
      });
      child.once("exit", (code, signal) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") this.stop(error);
          }
        }
        this.children.delete(child);
        if (essential && !this.abort.signal.aborted) {
          this.stop(new Error(`${binary} exited (${signal ?? code})`));
        }
      });
      child.once("close", (code, signal) => {
        this.children.delete(child);
        resolve({ code, signal });
      });
    });
    return { child, exited };
  }

  async terminate(child) {
    const signal = (name) => {
      if (!child.pid || !this.children.has(child)) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    await NodeTimersPromises.setTimeout(this.graceMs);
    signal("SIGKILL");
  }

  async restart(binary, args, options = {}) {
    let backoff = options.restartMs ?? 1000;
    while (!this.abort.signal.aborted) {
      const started = Date.now();
      const process = this.start(binary, args, { ...options, essential: false });
      options.onStart?.(process.child);
      await process.exited;
      if (this.abort.signal.aborted) return;
      if (Date.now() - started > 30000) backoff = options.restartMs ?? 1000;
      await NodeTimersPromises.setTimeout(backoff, undefined, { signal: this.abort.signal }).catch(
        () => {},
      );
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  async stop(error) {
    if (this.abort.signal.aborted) return this.done;
    this.failure = error;
    this.abort.abort();
    const children = [...this.children];
    const signal = (child, name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    for (const child of children) signal(child, "SIGTERM");
    // Keep the original groups until escalation: a leader can exit before its children.
    await NodeTimersPromises.setTimeout(this.graceMs);
    for (const child of children) signal(child, "SIGKILL");
    this.finish();
    return this.done;
  }
}

export function privateLog(path, limit = 1024 * 1024) {
  let warned = false;
  return (chunk) => {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        let size;
        try {
          size = NodeFS.statSync(path).size;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          size = 0;
        }
        if (size >= limit) {
          NodeFS.renameSync(path, `${path}.1`);
          size = 0;
        }
        const end = Math.min(chunk.length, offset + limit - size);
        NodeFS.appendFileSync(path, chunk.subarray(offset, end), { mode: 0o600 });
        offset = end;
      }
      warned = false;
    } catch {
      if (!warned) process.stderr.write("Sandbox IDE diagnostics unavailable\n");
      warned = true;
    }
  };
}

async function ready(session, name, probe, signal = session.abort.signal) {
  const deadline = Date.now() + 90000;
  while (!signal.aborted) {
    try {
      await probe();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`${name} did not become ready`, { cause: error });
    }
    await NodeTimersPromises.setTimeout(200, undefined, { signal });
  }
  throw new Error(`${name} startup cancelled`);
}

async function http(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
  if (response.status !== 200 && response.status !== 302) {
    await response.body?.cancel();
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response;
}

export async function mcpReady(url, required) {
  let sessionId;
  let protocol = "2024-11-05";
  const signal = AbortSignal.timeout(3000);
  const headers = () => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocol,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  });
  async function call(id, method, params) {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`MCP HTTP ${response.status}`);
    }
    if (!id) {
      await response.body?.cancel();
      return;
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      const message = await response.json();
      if (message.id !== id || message.error || !message.result)
        throw new Error("Invalid MCP response");
      return message.result;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("MCP stream ended before response");
        buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
        if (buffer.length > 2 * 1024 * 1024) throw new Error("MCP response exceeds limit");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const message = JSON.parse(data);
          if (message.id !== id) continue;
          if (message.error || !message.result) throw new Error("MCP request failed");
          return message.result;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  try {
    const init = await call(1, "initialize", {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "t3", version: "1" },
    });
    if (!init.protocolVersion) throw new Error("MCP protocol negotiation failed");
    protocol = init.protocolVersion;
    await call(0, "notifications/initialized", {});
    const missing = new Set(required);
    const cursors = new Set();
    let cursor;
    for (let id = 2; missing.size; id++) {
      const listing = await call(id, "tools/list", cursor ? { cursor } : {});
      for (const tool of listing.tools) missing.delete(tool.name);
      if (!missing.size) break;
      cursor = listing.nextCursor;
      if (!cursor || cursors.has(cursor))
        throw new Error(`Missing MCP tools: ${[...missing].join(", ")}`);
      cursors.add(cursor);
    }
  } finally {
    if (sessionId)
      await fetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(1000) })
        .then((response) => response.body?.cancel())
        .catch(() => {});
  }
}

async function command(session, binary, args, env) {
  const result = await session.start(binary, args, {
    env,
    essential: false,
    timeout: 3000,
    output: () => {},
  }).exited;
  if (result.code !== 0) throw new Error(`${binary} failed`);
}

function signals(session) {
  process.once("SIGTERM", () => session.stop());
  process.once("SIGINT", () => session.stop());
}

async function ide(root, state) {
  const session = new Session({ cwd: root, env: process.env, graceMs: 2000 });
  signals(session);
  const log = privateLog(NodePath.join(state, "ide", "code-server.log"));
  const args = [
    "--bind-addr",
    "127.0.0.1:8085",
    "--auth",
    "none",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-proxy",
    "--disable-workspace-trust",
    "--config",
    NodePath.join(state, "ide", "config.yaml"),
    "--user-data-dir",
    NodePath.join(state, "ide", "user-data"),
    "--extensions-dir",
    NodePath.join(state, "ide", "extensions"),
    root,
  ];
  const restarting = session.restart(process.env.T3_IDE_BINARY ?? "code-server", args, {
    output: log,
    onStart(child) {
      const attempt = new AbortController();
      child.once("close", () => attempt.abort());
      ready(
        session,
        "IDE",
        async () => {
          const response = await http("http://127.0.0.1:8085/");
          await response.body?.cancel();
        },
        AbortSignal.any([attempt.signal, session.abort.signal]),
      ).catch(() => {
        if (!session.abort.signal.aborted && child.exitCode === null && child.signalCode === null)
          session.terminate(child).catch((error) => session.stop(error));
      });
    },
  });
  await session.done;
  await restarting;
}

export async function main(mode = process.argv[2]) {
  process.umask(0o077);
  const root = process.env.T3_WORKSPACE_ROOT ?? "/workspace";
  const state = process.env.T3_WORKER_STATE_DIR ?? NodePath.join(root, ".t3-worker");
  if (!NodePath.isAbsolute(root) || !NodePath.isAbsolute(state))
    throw new Error("Workspace and worker state paths must be absolute");
  for (const path of [
    root,
    state,
    NodePath.join(state, "ide", "user-data"),
    NodePath.join(state, "ide", "extensions"),
  ]) {
    await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  }
  if (mode === "ide") return ide(root, state);
  const sandbox = process.env.SANDBOX_CHROMIUM_SANDBOX ?? "enabled";
  if (!["enabled", "disabled"].includes(sandbox))
    throw new Error("Invalid SANDBOX_CHROMIUM_SANDBOX");
  const desktop = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-"));
  const home = NodePath.join(desktop, "home");
  const profile = NodePath.join(home, ".config", "chromium");
  const xauth = NodePath.join(desktop, "Xauthority");
  await NodeFSP.mkdir(NodePath.join(desktop, "runtime"), { mode: 0o700 });
  const session = new Session({ cwd: root, env: process.env });
  signals(session);
  try {
    await NodeFSP.cp(process.env.SANDBOX_DESKTOP_CONFIG ?? "/opt/t3/desktop/config", home, {
      recursive: true,
    });
    await NodeFSP.mkdir(NodePath.join(profile, "Default"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(profile, "Default", "Preferences"),
      JSON.stringify({
        download: {
          default_directory: NodePath.join(root, "downloads"),
          prompt_for_download: false,
        },
      }),
    );
    NodeFS.closeSync(NodeFS.openSync(xauth, "w", 0o600));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USER: process.env.USER ?? "node",
      LOGNAME: process.env.LOGNAME ?? "node",
      LANG: "C.UTF-8",
      DISPLAY: ":99",
      XAUTHORITY: xauth,
      XDG_RUNTIME_DIR: NodePath.join(desktop, "runtime"),
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_CACHE_HOME: NodePath.join(home, ".cache"),
      XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
      XDG_CURRENT_DESKTOP: "XFCE",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${NodePath.join(desktop, "bus")}`,
      NO_AT_BRIDGE: "0",
      SANDBOX_ROOT: root,
      GIT_TERMINAL_PROMPT: "0",
      AIO_COMPUTER_USE_LISTEN: "127.0.0.1:18100",
      AIO_COMPUTER_USE_URL: "http://127.0.0.1:18100",
      BROWSER_REMOTE_DEBUGGING_HOST: "127.0.0.1",
      BROWSER_REMOTE_DEBUGGING_PORT: "9222",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/playwright-browsers",
      AIO_SKILLS_PATH: "/opt/t3/desktop/skills",
      EXTRA_MCP_SERVERS: JSON.stringify({
        documents: { url: "http://127.0.0.1:8932/mcp", prefix: "documents" },
      }),
    };
    await command(
      session,
      "xauth",
      ["-f", xauth, "add", ":99", ".", NodeCrypto.randomBytes(16).toString("hex")],
      env,
    );
    const start = (binary, args = []) => session.start(binary, args, { env });
    start("dbus-daemon", [
      "--session",
      "--nofork",
      "--nopidfile",
      `--address=unix:path=${NodePath.join(desktop, "bus")}`,
    ]);
    start("Xtigervnc", [
      ":99",
      "-geometry",
      "1440x900",
      "-depth",
      "24",
      "-rfbport",
      "5900",
      "-localhost",
      "-SecurityTypes",
      "None",
      "-auth",
      xauth,
      "-nolisten",
      "tcp",
      "-AlwaysShared",
    ]);
    await ready(session, "display", () => command(session, "xdpyinfo", ["-display", ":99"], env));
    await ready(session, "session bus", () =>
      command(
        session,
        "dbus-send",
        [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.DBus",
          "/",
          "org.freedesktop.DBus.ListNames",
        ],
        env,
      ),
    );
    const workerEnv = { ...process.env };
    for (const key of [
      "DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
      "XDG_CURRENT_DESKTOP",
    ])
      workerEnv[key] = env[key];
    const ideEnv = { ...env };
    for (const key of [
      "HOME",
      "USER",
      "LOGNAME",
      "T3_GIT_CREDENTIALS_FILE",
      "AZURE_EXTENSION_DIR",
      "AZURE_EXTENSION_USE_DYNAMIC_INSTALL",
      "AZURE_CORE_COLLECT_TELEMETRY",
    ]) {
      if (process.env[key] !== undefined) ideEnv[key] = process.env[key];
    }
    ideEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? NodePath.join(ideEnv.HOME, ".config");
    ideEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME ?? NodePath.join(ideEnv.HOME, ".cache");
    ideEnv.XDG_DATA_HOME =
      process.env.XDG_DATA_HOME ?? NodePath.join(ideEnv.HOME, ".local", "share");
    Object.assign(ideEnv, {
      T3_WORKSPACE_ROOT: root,
      T3_WORKER_STATE_DIR: state,
      T3_IDE_BINARY: process.env.T3_IDE_BINARY ?? "code-server",
    });
    const editor = session.start(process.execPath, [entrypoint, "ide"], { env: ideEnv });
    Object.assign(workerEnv, {
      T3_IDE_PID: String(editor.child.pid),
      T3CODE_SANDBOX_IDE_URL: "http://127.0.0.1:8085",
      T3CODE_SANDBOX_CDP_URL: "http://127.0.0.1:9222",
      T3CODE_SANDBOX_COMPUTER_URL: "http://127.0.0.1:18091",
    });
    session.start(
      process.env.T3_WORKER_NODE ?? process.execPath,
      [process.env.T3_WORKER_ENTRYPOINT ?? "/opt/t3/dist/execution-worker.mjs"],
      { env: workerEnv },
    );
    start("xfce4-session");
    await ready(session, "window manager", () => command(session, "wmctrl", ["-m"], env));
    const browserArgs = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--force-renderer-accessibility",
      "--password-store=basic",
      "--window-size=1280,800",
    ];
    if (sandbox === "disabled") browserArgs.push("--no-sandbox");
    session
      .restart("chromium", [...browserArgs, "about:blank"], { env })
      .catch((error) => session.stop(error));
    start("computer-use");
    start("markitdown-mcp", ["--http", "--host", "127.0.0.1", "--port", "8932"]);
    start("aiod", [
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      "18091",
      "--runtime-dir",
      NodePath.join(desktop, "aio"),
    ]);
    start("websockify", [
      `--web=${process.env.SANDBOX_NOVNC_WEB ?? "/usr/share/novnc"}`,
      "127.0.0.1:6080",
      "127.0.0.1:5900",
    ]);
    await ready(session, "Chromium", async () => {
      const response = await http("http://127.0.0.1:9222/json/version");
      if (!(await response.json()).webSocketDebuggerUrl)
        throw new Error("CDP websocket unavailable");
    });
    start("playwright-mcp", [
      "--host",
      "127.0.0.1",
      "--allowed-hosts",
      "127.0.0.1:8931",
      "--port",
      "8931",
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
      "--shared-browser-context",
      "--caps",
      "vision,pdf,devtools",
      "--no-webmcp",
      "--image-responses",
      "allow",
      "--output-dir",
      NodePath.join(desktop, "browser-output"),
    ]);
    await ready(session, "computer", async () => {
      const response = await http("http://127.0.0.1:18091/v2/computer/info");
      if (!(await response.json()).data?.available) throw new Error("Computer has no display");
    });
    await ready(session, "AIO MCP", () =>
      mcpReady("http://127.0.0.1:18091/mcp", [
        "sandbox_execute_bash",
        "sandbox_execute_code",
        "sandbox_file_operations",
        "browser_gui_screenshot",
        "browser_gui_execute_action",
        "documents_convert_to_markdown",
      ]),
    );
    await ready(session, "browser MCP", () =>
      mcpReady("http://127.0.0.1:8931/mcp", [
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_take_screenshot",
      ]),
    );
    await ready(session, "desktop viewer", async () => {
      const response = await http("http://127.0.0.1:6080/vnc.html");
      await response.body?.cancel();
    });
    await session.done;
  } catch (error) {
    await session.stop(error);
  } finally {
    await session.stop();
    await NodeFSP.rm(desktop, { recursive: true, force: true });
  }
  if (session.failure) throw session.failure;
}

if (process.argv[1] === entrypoint)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
