// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Tests exercise the actual on-disk journal and HTTP boundary.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, test } from "@effect/vitest";
import { openWorkerJournal } from "./WorkerJournal.ts";
import { createExecutionWorker } from "./ExecutionWorker.ts";
import { createExecutionClient } from "./ExecutionClient.ts";
import { listenWorker } from "./WorkerHttpServer.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const identity = {
  allocationId: "allocation-a",
  podUid: "pod-a",
  protocolVersion: 1 as const,
  workspaceId: "workspace-a",
  generation: 1,
  incarnation: "process-a",
};
const token = "test-token-with-more-than-thirty-two-characters";
async function fixture(
  execute: (method: string, input: unknown) => Promise<unknown>,
  limits?: Parameters<typeof openWorkerJournal>[1],
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const path = NodePath.join(directory, "worker.jsonl");
  const journal = await openWorkerJournal(path, limits);
  cleanup.push(journal.close);
  const worker = createExecutionWorker({ identity, token, journal, execute });
  const server = await listenWorker({ host: "127.0.0.1", port: 0, handle: worker.handle });
  cleanup.push(server.close);
  const endpoint = `http://127.0.0.1:${server.port}`;
  return {
    worker,
    journal,
    path,
    endpoint,
    client: createExecutionClient({ endpoint, token, identity }),
  };
}

test("concurrent retry and lost-response retry execute an operation once", async () => {
  let count = 0;
  const { client } = await fixture(async () => ++count);
  const results = await Promise.all([
    client.call("increment", {}, "same-operation"),
    client.call("increment", {}, "same-operation"),
  ]);
  expect(results).toEqual([1, 1]);
  expect(await client.call("increment", {}, "same-operation")).toBe(1);
  await expect(client.call("increment", { changed: true }, "same-operation")).rejects.toThrow(
    "operation_conflict",
  );
  expect(count).toBe(1);
});

test("rejects wrong authorization and stale worker incarnation before execution", async () => {
  let count = 0;
  const { endpoint } = await fixture(async () => ++count);
  await expect(
    createExecutionClient({ endpoint, token: "wrong", identity }).call("increment", null),
  ).rejects.toThrow("authorization");
  await expect(
    createExecutionClient({ endpoint, token, identity: { ...identity, incarnation: "old" } }).call(
      "increment",
      null,
    ),
  ).rejects.toThrow("stale_identity");
  expect(count).toBe(0);
});

test("reconnect replays only events after the acknowledged cursor", async () => {
  const { worker, client, endpoint } = await fixture(async () => null);
  await worker.publish("session-a", { text: "one" });
  await worker.publish("session-b", { text: "two" });
  const first = await client.events(0);
  expect(first.map((event) => event.sequence)).toEqual([1, 2]);
  await worker.publish("session-a", { text: "three" });
  const reconnected = createExecutionClient({ endpoint, token, identity });
  expect((await reconnected.events(2)).map((event) => event.event)).toEqual([{ text: "three" }]);
});

test("an accepted operation without a recorded outcome is never blindly rerun", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crashed-worker-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const path = NodePath.join(directory, "journal");
  const first = await openWorkerJournal(path);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([Schema.decodeUnknownSync(ExecutionIdentity)(identity), "write", null]))
    .digest("hex");
  await first.append({ kind: "accepted", id: "crashed", fingerprint });
  await first.close();
  const restored = await openWorkerJournal(path);
  cleanup.push(restored.close);
  let executions = 0;
  const worker = createExecutionWorker({
    identity,
    token,
    journal: restored,
    execute: async () => ++executions,
  });
  const response = await worker.handle(
    new Request("http://worker/v1/operations", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ identity, operationId: "crashed", method: "write", input: null }),
    }),
  );
  expect(await response.json()).toEqual({ ok: false, code: "operation_outcome_unknown" });
  expect(executions).toBe(0);
});

test("quiesce closes admission and a newer resume fences late cleanup", async () => {
  const { endpoint, client } = await fixture(async () => "ran");
  const transition = (route: string, revision: number) =>
    fetch(`${endpoint}/v1/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ identity, revision, operationId: `${route}-${revision}` }),
    });
  expect((await transition("quiesce", 1)).status).toBe(200);
  await expect(client.call("write", null)).rejects.toThrow("worker_quiescent");
  expect((await transition("resume", 2)).status).toBe(200);
  expect((await transition("quiesce", 1)).status).toBe(409);
  expect(await client.call("write", null)).toBe("ran");
});

test("a live provider callback prevents quiesce after HTTP operations finish", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-busy-worker-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const journal = await openWorkerJournal(NodePath.join(directory, "journal"));
  cleanup.push(journal.close);
  let callbacks = 1;
  const worker = createExecutionWorker({
    identity,
    token,
    journal,
    execute: async () => null,
    activity: async () => ({ activeOperations: 0, pendingCallbacks: callbacks }),
  });
  const quiesce = () =>
    worker.handle(
      new Request("http://worker/v1/quiesce", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ identity, revision: 1, operationId: "quiesce" }),
      }),
    );
  expect((await quiesce()).status).toBe(409);
  callbacks = 0;
  expect((await quiesce()).status).toBe(200);
});

test("IDE stream leases fence quiescence and exclusive mutations until released", async () => {
  const { worker, client } = await fixture(async () => null);
  const transition = (action: "quiesce" | "resume", revision: number) =>
    worker.handle(
      new Request(`http://worker/v1/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ identity, revision, operationId: `${action}-${revision}` }),
      }),
    );
  const release = await worker.acquireLease();
  expect(release).toBeTypeOf("function");
  const busy = await transition("quiesce", 1);
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ activeOperations: 1, quiescent: false });
  await expect(client.call("git.restore", {})).rejects.toThrow("worker_busy");
  release?.();
  release?.();
  expect((await transition("quiesce", 1)).status).toBe(200);
  expect(await worker.acquireLease()).toBeUndefined();
  await expect(client.call("computer.action", {})).rejects.toThrow("worker_quiescent");
  expect((await transition("resume", 2)).status).toBe(200);
  const resumed = await worker.acquireLease();
  expect(resumed).toBeTypeOf("function");
  resumed?.();
  expect((await transition("quiesce", 3)).status).toBe(200);
});

test.each(["git.restore", "workspace.discardClone"])(
  "%s holds exclusive admission until its result is durable",
  async (exclusiveMethod) => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finishing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = await fixture(async (method) => {
      if (method === exclusiveMethod) {
        entered();
        await finishing;
      }
      return null;
    });
    const restore = client.call(exclusiveMethod, { isolated: true }, "restore");
    await started;
    await expect(client.call("startTurn", {})).rejects.toThrow("worker_exclusive_operation");
    release();
    await restore;
    expect(await client.call("startTurn", {})).toBe(null);
  },
);

test("preview transport never journals frames and rejects accidental durable calls", async () => {
  const { client, journal, endpoint } = await fixture(async () => ({ frame: "image-data" }));
  expect(await client.transient("preview.viewerPoll", {})).toEqual({ frame: "image-data" });
  await expect(client.call("preview.viewerPoll", {})).rejects.toThrow("transient_required");
  expect(journal.operations.size).toBe(0);
  await fetch(`${endpoint}/v1/quiesce`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ identity, revision: 1, operationId: "quiesce" }),
  });
  await expect(client.transient("preview.viewerInput", {})).rejects.toThrow("worker_not_admitting");
  expect(await client.transient("preview.viewerPoll", {})).toEqual({ frame: "image-data" });
  expect(journal.operations.size).toBe(0);
});

test("committed acknowledgements compact replay without losing another session's events", async () => {
  const { worker, client, path } = await fixture(async () => null, { compactAfterBytes: 1 });
  await worker.publish("session-a", { text: "a" });
  await worker.publish("session-b", { text: "b" });
  await client.ack("session-a", 1);
  expect((await client.events(0)).map((event) => event.sessionId)).toEqual(["session-b"]);
  const restored = await openWorkerJournal(path);
  cleanup.push(restored.close);
  expect(restored.events.map((event) => event.sessionId)).toEqual(["session-b"]);
  await expect(client.ack("session-b", 999)).rejects.toThrow("acknowledgement");
  expect((await client.events(0)).map((event) => event.event)).toEqual([{ text: "b" }]);
});

test("capacity refuses more data without discarding unacked events and recovers after ack", async () => {
  const { worker, client, journal } = await fixture(async () => null, {
    maxBytes: 1500,
    compactAfterBytes: 1,
  });
  await worker.publish("session", { text: "x".repeat(700) });
  await expect(worker.publish("session", { text: "y".repeat(700) })).rejects.toThrow(
    "journal is full",
  );
  expect(journal.events).toHaveLength(1);
  expect((await client.events(0))[0]?.event).toEqual({ text: "x".repeat(700) });
  await client.ack("session", 1);
  await worker.publish("session", { text: "z" });
  expect((await client.events(0)).map((event) => event.event)).toEqual([{ text: "z" }]);
});

test("read-only probes create no receipts and cannot exhaust mutation receipt capacity", async () => {
  const { client, journal } = await fixture(async () => null, { maxReceipts: 1 });
  await client.call("getCapabilities", null);
  await client.call("provider.snapshot", null);
  await client.call("git.driver.status", { cwd: "/workspace" });
  expect(journal.operations.size).toBe(0);
  await client.call("startTurn", null);
  await expect(client.call("startTurn", null)).rejects.toThrow("journal_capacity");
  expect(await client.call("getCapabilities", null)).toBe(null);
  expect(journal.operations.size).toBe(1);
});

test("credential transport does not persist secret inputs or outputs", async () => {
  const secret = "credential-value-that-must-stay-off-disk";
  const { client, journal, path } = await fixture(async () => ({ secret }));
  expect(await client.transient("auth.executionCredentials", { secret })).toEqual({ secret });
  expect(await client.transient("configureProvider", { secret })).toEqual({ secret });
  await expect(client.call("auth.executionCredentials", { secret })).rejects.toThrow(
    "transient_required",
  );
  await expect(client.call("configureProvider", { secret })).rejects.toThrow("transient_required");
  expect(journal.operations.size).toBe(0);
  expect(await NodeFSP.readFile(path, "utf8")).not.toContain(secret);
});

test("credential refresh blocks utility suspension until access completes", async () => {
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { client, endpoint } = await fixture(async () => {
    entered();
    await completed;
    return null;
  });
  const access = client.transient("auth.executionCredentials", {});
  await started;
  const quiesce = () =>
    fetch(`${endpoint}/v1/quiesce`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ identity, revision: 1, operationId: "credential-idle" }),
    });
  expect((await quiesce()).status).toBe(409);
  release();
  await access;
  expect((await quiesce()).status).toBe(200);
});

test.each(["", "/"])(
  "preserves the gateway workspace prefix across every worker RPC (%s)",
  async (suffix) => {
    const { worker } = await fixture(async (method, input) => ({ method, input }));
    const prefix = "/workspaces/workspace-a/worker";
    const paths: string[] = [];
    const gateway = await listenWorker({
      host: "127.0.0.1",
      port: 0,
      handle: async (request) => {
        const url = new URL(request.url);
        paths.push(url.pathname);
        if (!url.pathname.startsWith(`${prefix}/`)) return new Response(null, { status: 404 });
        url.pathname = url.pathname.slice(prefix.length);
        return worker.handle(
          new Request(url, {
            method: request.method,
            headers: request.headers,
            ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
          }),
        );
      },
    });
    cleanup.push(gateway.close);
    const client = createExecutionClient({
      endpoint: `http://127.0.0.1:${gateway.port}${prefix}${suffix}`,
      token,
      identity,
    });
    expect(await client.inspectIdentity()).toEqual(identity);
    expect(await client.call("write", { value: 1 }, "prefixed-operation")).toEqual({
      method: "write",
      input: { value: 1 },
    });
    expect((await client.operationStatus("prefixed-operation")).state).toBe("completed");
    expect(await client.transient("auth.probe", {})).toEqual({ method: "auth.probe", input: {} });
    await worker.publish("session / a", { text: "streamed through gateway" });
    const events = await client.events(0, undefined, "session / a", 0);
    expect(events.map((event) => event.event)).toEqual([{ text: "streamed through gateway" }]);
    await client.ack("session / a", events[0]!.sequence);
    expect(await client.events(events[0]!.sequence, undefined, "session / a", 0)).toEqual([]);
    expect(paths).toEqual([
      `${prefix}/v1/identity`,
      `${prefix}/v1/operations`,
      `${prefix}/v1/operations/prefixed-operation`,
      `${prefix}/v1/transient`,
      `${prefix}/v1/events`,
      `${prefix}/v1/events/ack`,
      `${prefix}/v1/events`,
    ]);
  },
);
