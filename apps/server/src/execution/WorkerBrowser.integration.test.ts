// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Integration boundary owns child workers, browsers, and HTTP fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { captureRunPromise } from "./EffectHttpBoundary.ts";
import { claimPreviewRecording } from "../mcp/toolkits/preview/handlers.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import * as RuntimeClient from "../agentRuntime/RuntimeClient.ts";
import * as RemotePreview from "../agentRuntime/RemoteWorkspacePreview.ts";
import * as Manager from "../preview/Manager.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Config from "../config.ts";
import * as C from "@t3tools/contracts";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import * as P from "../agentRuntime/worker/PreviewProtocol.ts";

const decodeIdentity = Schema.decodeUnknownSync(ExecutionIdentity);
const decodeOutcome = Schema.decodeUnknownSync(P.AutomationOutcome);
const decodeStatus = Schema.decodeUnknownSync(C.PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownSync(C.PreviewAutomationSnapshot);
const executable = process.env.T3_BROWSER_TEST_EXECUTABLE;

async function stop(child: NodeChildProcess.ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = NodeEvents.EventEmitter.once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function listen(server: NodeNet.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return address.port;
}
const close = (server: NodeNet.Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

function ready(child: NodeChildProcess.ChildProcessWithoutNullStreams, match: RegExp) {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const consume = (chunk: Buffer) => {
      output += chunk.toString();
      const found = match.exec(output);
      if (found) resolve(found[1] ?? found[0]);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Fixture exited ${code}: ${output}`)));
  });
}

// Opt in with an image-managed Chromium executable. No browser download or live runtime is used.
it.live.skipIf(!executable)(
  "real workers isolate browser storage, preserve child ownership, and survive tab closure and replacement",
  () =>
    Effect.gen(function* () {
      const run = yield* captureRunPromise;
      yield* Effect.tryPromise(async () => {
        if (!executable) throw new Error("T3_BROWSER_TEST_EXECUTABLE is required");
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-workers-"));
        const children: NodeChildProcess.ChildProcess[] = [];
        const disposers: Array<() => Promise<void>> = [];
        const site = NodeHttp.createServer((_request, response) => {
          response.setHeader("content-type", "text/html");
          response.end(
            '<title>Worker locality fixture</title><h1>Worker locality</h1><input aria-label="Value"><button>Save</button>',
          );
        });
        try {
          const url = `http://127.0.0.1:${await listen(site)}`;
          const computerCalls = new Map<string, unknown[]>();
          const start = async (name: string) => {
            const actions: unknown[] = [];
            computerCalls.set(name, actions);
            const computer = NodeHttp.createServer(async (request, response) => {
              response.setHeader("content-type", "application/json");
              if (request.url === "/v2/computer/info") {
                response.end(
                  JSON.stringify({
                    success: true,
                    data: {
                      available: true,
                      display: name,
                      screen_resolution: { width: 1440, height: 900 },
                      capabilities: { screenshot: true, actions: true },
                    },
                  }),
                );
              } else {
                let body = "";
                for await (const chunk of request) body += chunk.toString();
                actions.push(JSON.parse(body));
                response.end(JSON.stringify({ success: true }));
              }
            });
            const computerPort = await listen(computer);
            disposers.push(() => close(computer));
            const directory = NodePath.join(root, name);
            await NodeFSP.mkdir(directory, { recursive: true });
            const chrome = NodeChildProcess.spawn(
              executable,
              [
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--remote-debugging-port=0",
                `--user-data-dir=${NodePath.join(directory, "chrome")}`,
                "about:blank",
              ],
              { stdio: "pipe" },
            );
            children.push(chrome);
            const endpoint = await ready(chrome, /DevTools listening on (ws:\/\/[^\s]+)/);
            const cdp = new URL(endpoint);
            const socket = NodeNet.createServer();
            const port = await listen(socket);
            await close(socket);
            const token = NodeCrypto.randomUUID();
            const launch = async () => {
              const worker = NodeChildProcess.spawn(
                process.execPath,
                [new URL("./bin.ts", import.meta.url).pathname],
                {
                  cwd: directory,
                  stdio: "pipe",
                  env: {
                    ...process.env,
                    T3_WORKSPACE_ROOT: directory,
                    T3_WORKER_STATE_DIR: NodePath.join(directory, ".t3-worker"),
                    T3_WORKER_PORT: String(port),
                    T3_WORKER_TOKEN: token,
                    T3_WORKSPACE_ID: name,
                    T3_ALLOCATION_ID: name,
                    T3_ALLOCATION_GENERATION: "1",
                    T3_POD_UID: name,
                    T3CODE_SANDBOX_COMPUTER_URL: `http://127.0.0.1:${computerPort}`,
                    T3CODE_SANDBOX_CDP_URL: `http://${cdp.host}`,
                    T3_BROWSER_EXECUTABLE: executable,
                    T3CODE_SERVER_BROWSER_SANDBOX: "0",
                  },
                },
              );
              children.push(worker);
              await ready(worker, /Execution worker ready/);
              const endpoint = `http://127.0.0.1:${port}`;
              const response = await fetch(`${endpoint}/v1/identity`, {
                headers: { authorization: `Bearer ${token}` },
              });
              expect(response.status).toBe(200);
              const identity = decodeIdentity(await response.json());
              return { worker, client: createExecutionClient({ endpoint, token, identity }) };
            };
            return { ...(await launch()), launch, directory };
          };
          const a = await start("root-a");
          const b = await start("root-b");
          const watching = Promise.withResolvers<void>();
          let observationAborted = false;
          let currentA = {
            ...a.client,
            events: (...args: Parameters<typeof a.client.events>) => {
              args[1]?.addEventListener(
                "abort",
                () => {
                  observationAborted = true;
                },
                { once: true },
              );
              watching.resolve();
              return a.client.events(...args);
            },
          };
          const wakeRequests: string[] = [];
          const current = (thread: string) => (thread === "b" ? b.client : currentA);
          const central = async () => {
            const scope = await run(Scope.make());
            const context = await run(
              Layer.build(
                Layer.mergeAll(RemotePreview.managerLayer, RemotePreview.brokerLayer).pipe(
                  Layer.provide(
                    Layer.mock(RuntimeClient.RuntimeClient, {
                      enabled: true,
                      forThread: (thread) =>
                        Effect.sync(() => {
                          wakeRequests.push(thread);
                          return current(thread);
                        }),
                      observeThread: (thread) =>
                        Effect.succeed({ kind: "running", client: current(thread) }),
                    }),
                  ),
                  Layer.provideMerge(
                    Layer.mergeAll(
                      Sqlite.layer({ filename: ":memory:" }),
                      Config.layerTest(root, { prefix: "central-" }),
                    ).pipe(Layer.provideMerge(NodeServices.layer)),
                  ),
                ),
              ).pipe(Effect.provideService(Scope.Scope, scope)),
            );
            const runtime = {
              runPromise: <A, E>(
                effect: Effect.Effect<
                  A,
                  E,
                  | Manager.PreviewManager
                  | Broker.PreviewAutomationBroker
                  | Config.ServerConfig
                  | import("effect/FileSystem").FileSystem
                  | import("effect/Path").Path
                >,
              ) => run(effect.pipe(Effect.provide(context))),
              dispose: () => run(Scope.close(scope, Exit.void)),
            };
            disposers.push(() => runtime.dispose());
            return runtime;
          };
          for (const worker of [a, b]) {
            expect(await worker.client.call("computer.status", {})).toMatchObject({
              display: worker.client.identity.workspaceId,
            });
            await worker.client.call("computer.action", {
              kind: "type",
              text: worker.client.identity.workspaceId,
            });
          }
          expect(computerCalls.get("root-a")).toEqual([{ action_type: "TYPING", text: "root-a" }]);
          expect(computerCalls.get("root-b")).toEqual([{ action_type: "TYPING", text: "root-b" }]);
          const firstCentral = await central();
          const centralStatus = (
            runtime: Awaited<ReturnType<typeof central>>,
            thread: string,
            operation: C.PreviewAutomationOperation = "status",
            input: unknown = {},
            tabId?: string,
          ) =>
            runtime.runPromise(
              Effect.gen(function* () {
                const broker = yield* Broker.PreviewAutomationBroker;
                return yield* broker.invoke({
                  scope: {
                    environmentId: C.EnvironmentId.make("test-central"),
                    capabilities: new Set(["preview"]),
                    issuedAt: 0,
                    requestNamespace: `agent-${thread}`,
                    client: undefined,
                    thread: {
                      threadId: C.ThreadId.make(thread),
                      providerSessionId: `agent-${thread}`,
                      providerInstanceId: C.ProviderInstanceId.make("test"),
                    },
                  },
                  operation,
                  input,
                  ...(tabId ? { tabId } : {}),
                });
              }),
            );
          const automate = async (
            client: typeof a.client,
            threadId: string,
            operation: C.PreviewAutomationOperation,
            input: unknown,
            tabId?: string,
          ) => {
            const result = decodeOutcome(
              await client.call("preview.automation", {
                request: {
                  requestId: NodeCrypto.randomUUID(),
                  threadId,
                  agentSessionId: `agent-${threadId}`,
                  operation,
                  input,
                  timeoutMs: 15000,
                  ...(tabId ? { tabId } : {}),
                },
              }),
            );
            if (!result.ok) throw new Error(JSON.stringify(result.error));
            return result.result;
          };
          const open = async (client: typeof a.client, threadId: string, profileId = "default") => {
            const status = decodeStatus(
              await automate(client, threadId, "open", {
                url,
                profileId,
                show: false,
                reuseExistingTab: false,
              }),
            );
            if (!status.tabId) throw new Error("Missing tab");
            return status.tabId;
          };
          const evaluate = (
            client: typeof a.client,
            thread: string,
            tab: string,
            expression: string,
          ) => automate(client, thread, "evaluate", { expression }, tab);
          for (const worker of [a, b]) {
            await worker.client.call("workspace.prepare", { cwd: "same-path" });
            await worker.client.call("files.write", {
              cwd: "same-path",
              relativePath: "root.txt",
              contents: worker.client.identity.workspaceId,
            });
          }
          expect(
            await NodeFSP.readFile(NodePath.join(a.directory, "same-path/root.txt"), "utf8"),
          ).toBe("root-a");
          expect(
            await NodeFSP.readFile(NodePath.join(b.directory, "same-path/root.txt"), "utf8"),
          ).toBe("root-b");
          const foreign = createExecutionClient({
            ...b.client.credentialSource(),
            identity: a.client.identity,
          });
          await expect(foreign.call("preview.list", { threadId: "a" })).rejects.toMatchObject({
            code: "stale_identity",
          });
          const unauthorized = createExecutionClient({
            ...a.client.credentialSource(),
            token: b.client.credentialSource().token,
          });
          await expect(unauthorized.call("preview.list", { threadId: "a" })).rejects.toMatchObject({
            code: "authorization",
          });
          const aTab = await open(a.client, "a");
          const bTab = await open(b.client, "b");
          await evaluate(a.client, "a", aTab, "localStorage.setItem('root', 'a')");
          expect(await evaluate(b.client, "b", bTab, "localStorage.getItem('root')")).toBeNull();
          for (const [width, height] of [
            [1440, 900],
            [390, 844],
          ]) {
            await automate(a.client, "a", "resize", { mode: "freeform", width, height }, aTab);
            expect(
              await evaluate(a.client, "a", aTab, "({width: innerWidth, height: innerHeight})"),
            ).toEqual({ width, height });
            const snapshot = decodeSnapshot(await automate(a.client, "a", "snapshot", {}, aTab));
            expect(snapshot.visibleText).toContain("Worker locality");
            expect(Buffer.from(snapshot.screenshot.data, "base64").subarray(1, 4).toString()).toBe(
              "PNG",
            );
            if (process.env.T3_BROWSER_TEST_ARTIFACTS) {
              await NodeFSP.mkdir(process.env.T3_BROWSER_TEST_ARTIFACTS, { recursive: true });
              await NodeFSP.writeFile(
                NodePath.join(process.env.T3_BROWSER_TEST_ARTIFACTS, `worker-${width}.png`),
                Buffer.from(snapshot.screenshot.data, "base64"),
              );
            }
          }
          const childTab = await open(a.client, "child");
          expect(await evaluate(a.client, "child", childTab, "localStorage.getItem('root')")).toBe(
            "a",
          );
          await expect(evaluate(a.client, "child", aTab, "document.title")).rejects.toThrow();
          await expect(evaluate(b.client, "b", aTab, "document.title")).rejects.toThrow();
          await a.client.call("preview.reportProfiles", {
            profiles: [{ id: "work", name: "Work", kind: "persistent" }],
            defaultProfileId: "default",
          });
          const workTab = await open(a.client, "a", "work");
          expect(await evaluate(a.client, "a", workTab, "localStorage.getItem('root')")).toBeNull();
          await evaluate(a.client, "a", workTab, "localStorage.setItem('root', 'work')");
          const privateTab = await open(a.client, "a", "incognito");
          expect(
            await evaluate(a.client, "a", privateTab, "localStorage.getItem('root')"),
          ).toBeNull();
          expect(await centralStatus(firstCentral, "a")).toMatchObject({
            available: true,
            tabs: expect.arrayContaining([
              expect.objectContaining({ tabId: aTab }),
              expect.objectContaining({ tabId: privateTab }),
            ]),
          });
          expect(await centralStatus(firstCentral, "b")).toMatchObject({ tabId: bTab });
          expect(wakeRequests).toContain("a");
          const recordingTab = decodeStatus(
            await centralStatus(firstCentral, "recording", "open", { url, show: false }),
          );
          if (!recordingTab.tabId) throw new Error("Missing recording tab");
          await centralStatus(firstCentral, "recording", "recordingStart", {}, recordingTab.tabId);
          await centralStatus(
            firstCentral,
            "recording",
            "evaluate",
            { expression: "document.body.style.background = 'lightblue'" },
            recordingTab.tabId,
          );
          await centralStatus(firstCentral, "recording", "snapshot", {}, recordingTab.tabId);
          const video = await centralStatus(
            firstCentral,
            "recording",
            "recordingStop",
            {},
            recordingTab.tabId,
          );
          const retained = await firstCentral.runPromise(
            claimPreviewRecording(C.ThreadId.make("recording"), video),
          );
          expect(retained.path.startsWith(a.directory)).toBe(false);
          expect((await NodeFSP.stat(retained.path)).size).toBeGreaterThan(0);
          await a.client.call("preview.close", {
            threadId: "recording",
            tabId: recordingTab.tabId,
          });
          await watching.promise;
          await firstCentral.dispose();
          expect(observationAborted).toBe(true);
          const secondCentral = await central();
          const listed = await secondCentral.runPromise(
            Effect.gen(function* () {
              return yield* (yield* Manager.PreviewManager).list({
                threadId: C.ThreadId.make("a"),
              });
            }),
          );
          expect(listed.sessions.map((tab) => tab.tabId)).toContain(aTab);
          expect(await evaluate(a.client, "a", aTab, "localStorage.getItem('root')")).toBe("a");
          for (const [thread, tab] of [
            ["a", aTab],
            ["a", privateTab],
            ["a", workTab],
            ["child", childTab],
          ]) {
            await a.client.call("preview.close", { threadId: thread, tabId: tab });
          }
          expect(a.worker.exitCode).toBeNull();
          const lifecycle = async (action: string, revision: number) => {
            const access = a.client.credentialSource();
            return fetch(`${access.endpoint}/v1/${action}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${access.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                identity: access.identity,
                operationId: `${action}-${revision}`,
                revision,
              }),
            });
          };
          expect((await lifecycle("quiesce", 1)).status).toBe(200);
          await expect(
            a.client.call("preview.open", { threadId: "a", runtime: "server" }),
          ).rejects.toMatchObject({ code: "worker_quiescent" });
          expect((await lifecycle("resume", 2)).status).toBe(200);
          const reopened = await open(a.client, "a");
          expect(await evaluate(a.client, "a", reopened, "localStorage.getItem('root')")).toBe("a");
          await stop(a.worker);
          const replacement = await a.launch();
          currentA = replacement.client;
          expect(replacement.client.identity.incarnation).not.toBe(a.client.identity.incarnation);
          await expect(a.client.call("preview.list", { threadId: "a" })).rejects.toMatchObject({
            code: "stale_identity",
          });
          const replacedTab = await open(replacement.client, "a");
          expect(await centralStatus(secondCentral, "a")).toMatchObject({ tabId: replacedTab });
          expect(
            await evaluate(replacement.client, "a", replacedTab, "localStorage.getItem('root')"),
          ).toBe("a");
          expect(await evaluate(b.client, "b", bTab, "localStorage.getItem('root')")).toBeNull();
          for (const directory of [a.directory, b.directory]) {
            expect(
              (await NodeFSP.readdir(NodePath.join(directory, ".t3-worker", "userdata"))).filter(
                (name) => name.endsWith(".sqlite"),
              ),
            ).toEqual([]);
          }
        } finally {
          for (const dispose of disposers) await dispose();
          for (const child of children.toReversed()) await stop(child);
          await close(site);
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      });
    }),
  120000,
);
