// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Integration boundary owns isolated worker processes and HTTP requests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { expect, test } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { ConfigureProvider } from "./WorkerProviders.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import * as Protocol from "./ProviderProtocol.ts";

const decodeIdentity = Schema.decodeUnknownSync(ExecutionIdentity);
const encodeConfigure = Schema.encodeSync(Schema.toCodecJson(ConfigureProvider));
const encodeOpenSession = Schema.encodeSync(Schema.toCodecJson(Protocol.OpenSession));
const encodeEnsureThread = Schema.encodeSync(Schema.toCodecJson(Protocol.EnsureThread));
const decodeProviderThread = Schema.decodeUnknownSync(
  Schema.toCodecJson(C.OrchestrationV2ProviderThread),
);
const decodeSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(C.ServerProvider));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
);
const decodeSession = Schema.decodeUnknownSync(Schema.Struct({ cwd: Schema.String }));

test.each([false, true])(
  "native Antigravity configures, starts, and retains credentials across replacement with gateway=%s",
  async (gatewayEnabled) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-antigravity-worker-"));
    const socket = NodeNet.createServer().listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(socket, "listening");
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("Missing worker test port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    const instanceId = C.ProviderInstanceId.make("antigravity-test-account");
    const token = "antigravity-worker-test-credential-not-a-real-token";
    const endpoint = `http://127.0.0.1:${port}`;
    const requestsPath = NodePath.join(root, "native-requests.jsonl");
    const binaryPath = NodePath.join(root, "agy_acp_server.par");
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const fixture = new URL("../../scripts/acp-mock-agent.ts", import.meta.url).pathname;
    await NodeFSP.writeFile(
      binaryPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(NodePath.join(root, "localharness_external"), "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
    await NodeFSP.writeFile(NodePath.join(root, "antigravity-version.json"), '{"version":"1.3.0"}');
    await NodeFSP.mkdir(NodePath.join(root, "tmp"));
    const gatewayConfig = NodePath.join(root, "gateway.json");
    await NodeFSP.writeFile(gatewayConfig, "{}");
    let gatewayRequests = 0;
    const gateway = NodeHttp.createServer((_request, response) => {
      gatewayRequests++;
      response.writeHead(503).end();
    }).listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(gateway, "listening");
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === "string")
      throw new Error("Missing gateway test port");
    const start = async () => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [new URL("./bin.ts", import.meta.url).pathname],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: root,
            TMPDIR: NodePath.join(root, "tmp"),
            CODEX_HOME: NodePath.join(root, "codex"),
            APERTURE_UPSTREAM: "",
            T3_HARNESS_DEFAULTS_FILE: "",
            T3_GATEWAY_HARNESS_CONFIG_FILE: gatewayEnabled ? gatewayConfig : "",
            T3_GATEWAY_URL: gatewayEnabled ? `http://127.0.0.1:${gatewayAddress.port}` : "",
            T3_GATEWAY_API_KEY: gatewayEnabled ? "fixture-gateway-key" : "",
            T3_WORKSPACE_ROOT: root,
            T3_WORKER_STATE_DIR: NodePath.join(root, ".t3-worker"),
            T3_WORKER_PORT: String(port),
            T3_WORKER_TOKEN: token,
            T3_WORKSPACE_ID: "antigravity-root",
            T3_ALLOCATION_ID: "allocation",
            T3_ALLOCATION_GENERATION: "1",
            T3_POD_UID: "test-pod",
          },
        },
      );
      let output = "";
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
      const response = await fetch(`${endpoint}/v1/identity`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const identity = decodeIdentity(await response.json());
      const client = createExecutionClient({ endpoint, token, identity });
      const configure = () =>
        client.transient(
          "configureProvider",
          encodeConfigure({
            instanceId,
            config: {
              driver: C.ProviderDriverKind.make("antigravity"),
              enabled: true,
              config: { binaryPath, authMethod: "gemini-api-key", apiKey: "mock-agent-only" },
              environment: [
                { name: "T3_ACP_ANTIGRAVITY", value: "1", sensitive: false },
                { name: "T3_ACP_REQUEST_LOG_PATH", value: requestsPath, sensitive: false },
              ],
            },
            settings: C.DEFAULT_SERVER_SETTINGS,
          }),
        );
      return { child, client, identity, configure };
    };
    const stop = async (child: NodeChildProcess.ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await NodeEvents.EventEmitter.once(child, "exit");
    };
    let worker: Awaited<ReturnType<typeof start>> | undefined;
    try {
      worker = await start();
      await worker.configure();
      await worker.client.call("provider.refreshModels", { instanceId, input: null });
      const snapshot = decodeSnapshot(
        await worker.client.call("provider.snapshot", { instanceId, input: null }),
      );
      expect(snapshot.driver).toBe("antigravity");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.setup?.canAuthenticate).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "gemini-test-low",
        "gemini-test-high",
      ]);
      expect(snapshot.setup).not.toHaveProperty("canInstall");
      const requests = (await NodeFSP.readFile(requestsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => decodeRequest(line));
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "auth/login",
        "session/new",
      ]);
      const session = decodeSession(requests[2]?.params);
      expect(session.cwd.startsWith(NodePath.join(root, "tmp"))).toBe(true);
      const reconnected = createExecutionClient({ endpoint, token, identity: worker.identity });
      expect(await reconnected.call("getCapabilities", { instanceId, input: null })).toHaveProperty(
        "tools.supportsMcpTools",
        true,
      );
      const threadId = C.ThreadId.make("native-antigravity-thread");
      const providerSessionId = C.ProviderSessionId.make("native-antigravity-session");
      const modelSelection = { instanceId, model: "gemini-test-low" };
      const runtimePolicy = {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: root,
      } as const;
      await worker.client.call("openSession", {
        instanceId,
        input: encodeOpenSession({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        }),
      });
      const providerThread = decodeProviderThread(
        await worker.client.call("ensureThread", {
          sessionId: providerSessionId,
          input: encodeEnsureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          }),
        }),
      );
      expect(providerThread.appThreadId).toBe(threadId);
      const credentials = { personal: '{"refresh_token":"fixture"}', business: null };
      await worker.client.transient("auth.importExecutionCredentials", {
        instanceId,
        input: credentials,
      });
      const firstIdentity = worker.identity;
      await stop(worker.child);
      worker = await start();
      await worker.configure();
      expect(worker.identity.incarnation).not.toBe(firstIdentity.incarnation);
      expect(
        await worker.client.transient("auth.executionCredentials", { instanceId, input: null }),
      ).toEqual(credentials);
      await worker.client.transient("auth.importExecutionCredentials", { instanceId, input: null });
      expect(
        await worker.client.transient("auth.executionCredentials", { instanceId, input: null }),
      ).toBeNull();
      const stateFiles = await NodeFSP.readdir(NodePath.join(root, ".t3-worker"), {
        recursive: true,
      });
      expect(stateFiles.some((name) => /statev?2?\.sqlite$/.test(name))).toBe(false);
      const journals = stateFiles.filter((name) => name.endsWith(".jsonl"));
      for (const file of journals)
        expect(
          await NodeFSP.readFile(NodePath.join(root, ".t3-worker", file), "utf8"),
        ).not.toContain("refresh_token");
      expect(gatewayRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve())),
      );
      if (worker) await stop(worker.child);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
