import * as ForkProtocol from "./ForkWorkspaceProtocol.ts";
import * as AssetProtocol from "../agentRuntime/worker/AssetProtocol.ts";
import * as WorkerProtocol from "../agentRuntime/worker/Protocol.ts";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Integration test owns a child worker and isolated filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import { expect, test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { ConfigureProvider } from "./WorkerProviders.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";

async function freePort() {
  const socket = NodeNet.createServer();
  socket.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function spawnWorker(root: string, port: number, token: string) {
  return NodeChildProcess.spawn(process.execPath, [new URL("./bin.ts", import.meta.url).pathname], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: NodePath.join(root, "codex"),
      T3_WORKSPACE_ROOT: root,
      T3_WORKER_STATE_DIR: NodePath.join(root, ".t3-worker"),
      T3_WORKER_PORT: String(port),
      T3_WORKER_TOKEN: token,
      T3_WORKSPACE_ID: `workspace-${port}`,
      T3_ALLOCATION_ID: `allocation-${port}`,
      T3_ALLOCATION_GENERATION: "1",
      T3_POD_UID: `test-pod-${port}`,
    },
  });
}

test("standalone worker boots native driver and workspace services without a conversation database", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-bootstrap-"));
  const port = await freePort();
  const token = "test-worker-bootstrap-token-thirty-two-characters";
  const child = spawnWorker(root, port, token);
  let targetChild: ReturnType<typeof spawnWorker> | undefined;
  let targetRoot: string | undefined;
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const consume = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Execution worker ready")) resolve();
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${output}`)));
    });
    const endpoint = `http://127.0.0.1:${port}`;
    const identityResponse = await fetch(`${endpoint}/v1/identity`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identityResponse.status).toBe(200);
    const identity = Schema.decodeUnknownSync(ExecutionIdentity)(await identityResponse.json());
    const client = createExecutionClient({ endpoint, token, identity });
    const instanceId = ProviderInstanceId.make("codex");
    await client.transient(
      "configureProvider",
      Schema.encodeSync(Schema.toCodecJson(ConfigureProvider))({
        instanceId,
        config: { driver: ProviderDriverKind.make("codex") },
        settings: DEFAULT_SERVER_SETTINGS,
      }),
    );
    const capabilities = await client.call("getCapabilities", { instanceId, input: null });
    expect(capabilities).toHaveProperty("sessions");
    await client.call("workspace.prepare", { cwd: "source" });
    const git = async (args: string[], cwd = "source") =>
      Schema.decodeUnknownSync(WorkerProtocol.ScriptResult)(
        await client.call("scripts.run", {
          cwd,
          command: "git",
          args,
          operationId: `${cwd}:${args.join("-")}`,
          timeoutMs: 10000,
        }),
      );
    await git(["config", "user.name", "Fork Test"]);
    await git(["config", "user.email", "fork@example.test"]);
    expect(
      await client.call("git.driver.readConfigValue", {
        operationId: "bootstrap-git-config",
        cwd: "source",
        method: "readConfigValue",
        key: "user.name",
      }),
    ).toEqual({ ok: true, value: "Fork Test" });
    await client.call("files.write", {
      cwd: "source",
      relativePath: "tracked.txt",
      contents: "base",
    });
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "base"]);
    await client.call("files.write", {
      cwd: "source",
      relativePath: "tracked.txt",
      contents: "selected checkpoint",
    });
    await client.call("files.write", {
      cwd: "source",
      relativePath: "untracked.txt",
      contents: "selected untracked file",
    });
    await client.call("git.captureCheckpoint", {
      cwd: "source",
      checkpointRef: "refs/t3/selected",
    });
    await client.call("files.write", {
      cwd: "source",
      relativePath: "tracked.txt",
      contents: "later commit",
    });
    await git(["add", "--", "tracked.txt"]);
    await git(["commit", "-m", "later"]);
    await client.call("files.write", {
      cwd: "source",
      relativePath: "tracked.txt",
      contents: "current dirty content must not leak",
    });
    const bundle = Schema.decodeUnknownSync(ForkProtocol.ForkBundle)(
      await client.call("git.bundleFork", { cwd: "source", checkpointRef: "refs/t3/selected" }),
    );
    const blob = Schema.decodeUnknownSync(AssetProtocol.Blob)(
      await client.call("asset.snapshot", { path: bundle.bundlePath }),
    );
    targetRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-fork-target-"));
    const targetPort = await freePort();
    targetChild = spawnWorker(targetRoot, targetPort, token);
    await new Promise<void>((resolve, reject) => {
      let targetOutput = "";
      const consume = (chunk: Buffer) => {
        targetOutput += chunk.toString();
        if (targetOutput.includes("Execution worker ready")) resolve();
      };
      targetChild?.stdout.on("data", consume);
      targetChild?.stderr.on("data", consume);
      targetChild?.once("error", reject);
      targetChild?.once("exit", (code) =>
        reject(new Error(`Target worker exited ${code}: ${targetOutput}`)),
      );
    });
    const targetEndpoint = `http://127.0.0.1:${targetPort}`;
    const targetIdentity = Schema.decodeUnknownSync(ExecutionIdentity)(
      await (
        await fetch(`${targetEndpoint}/v1/identity`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    const target = createExecutionClient({
      endpoint: targetEndpoint,
      token,
      identity: targetIdentity,
    });
    expect(target.identity.incarnation).not.toBe(client.identity.incarnation);
    for (let offset = 0; offset < blob.size; offset += AssetProtocol.CHUNK_BYTES) {
      const part = Schema.decodeUnknownSync(AssetProtocol.ReadResult)(
        await client.transient("asset.read", {
          blobId: blob.blobId,
          offset,
          maxBytes: AssetProtocol.CHUNK_BYTES,
          leaseId: blob.leaseId,
        }),
      );
      await target.transient("asset.stage", {
        blobId: blob.blobId,
        offset,
        size: blob.size,
        data: part.data,
      });
    }
    const imported = { ...bundle, cwd: "fork", blobId: blob.blobId };
    await target.call("git.importFork", imported);
    expect(
      await target.call("files.read", { cwd: "fork", relativePath: "tracked.txt" }),
    ).toMatchObject({ contents: "selected checkpoint" });
    expect(
      await target.call("files.read", { cwd: "fork", relativePath: "untracked.txt" }),
    ).toMatchObject({ contents: "selected untracked file" });
    await target.call("files.write", {
      cwd: "fork",
      relativePath: "tracked.txt",
      contents: "independent fork edits",
    });
    expect(
      await client.call("files.read", { cwd: "source", relativePath: "tracked.txt" }),
    ).toMatchObject({ contents: "current dirty content must not leak" });
    await client.call("git.importFork", imported);
    expect(
      await client.call("files.read", { cwd: "fork", relativePath: "tracked.txt" }),
    ).toMatchObject({ contents: "selected checkpoint" });
    expect(
      await client.call("files.read", { cwd: "fork", relativePath: "untracked.txt" }),
    ).toMatchObject({ contents: "selected untracked file" });
    expect((await git(["rev-parse", "HEAD"], "fork")).stdout.trim()).toBe(bundle.baseCommit);
    const status = await git(["status", "--porcelain"], "fork");
    expect(status.stdout).toContain(" M tracked.txt");
    expect(status.stdout).toContain("?? untracked.txt");
    await client.call("files.write", {
      cwd: "fork",
      relativePath: "tracked.txt",
      contents: "new fork edits",
    });
    await client.call("git.importFork", imported);
    expect(
      await client.call("files.read", { cwd: "fork", relativePath: "tracked.txt" }),
    ).toMatchObject({ contents: "new fork edits" });

    const stateFiles = await NodeFSP.readdir(NodePath.join(root, ".t3-worker"), {
      recursive: true,
    });
    expect(stateFiles.some((name) => name.endsWith(".sqlite"))).toBe(false);
  } finally {
    if (targetChild) {
      targetChild.kill("SIGTERM");
      if (targetChild.exitCode === null && targetChild.signalCode === null)
        await NodeEvents.EventEmitter.once(targetChild, "exit");
    }
    if (targetRoot) await NodeFSP.rm(targetRoot, { recursive: true, force: true });
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      await NodeEvents.EventEmitter.once(child, "exit");
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 30000);
