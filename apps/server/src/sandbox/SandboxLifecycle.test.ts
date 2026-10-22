// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real SQLite, HTTP and worker protocol boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { ExecutionPoolId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { createExecutionWorker } from "../execution/ExecutionWorker.ts";
import { openWorkerJournal } from "../execution/WorkerJournal.ts";
import { listenWorker } from "../execution/WorkerHttpServer.ts";
import * as Kubernetes from "./Kubernetes.ts";
import * as Lifecycle from "./SandboxLifecycle.ts";
import type { Placement } from "./Configuration.ts";

const placement = {
  id: ExecutionPoolId.make("test"),
  label: "Test",
  namespace: "test",
  profile: "t3",
  image: `registry.example/t3@sha256:${"1".repeat(64)}`,
  providerDrivers: [],
  resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
  storage: { size: "10Gi", storageClassName: "standard" },
} satisfies Placement;
const Submitted = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.String,
    labels: Schema.Record(Schema.String, Schema.String),
    annotations: Schema.Record(Schema.String, Schema.String),
  }),
  spec: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const WorkerSpec = Schema.Struct({
  podTemplate: Schema.Struct({
    spec: Schema.Struct({
      containers: Schema.Array(
        Schema.Struct({
          env: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              value: Schema.optionalKey(Schema.String),
              valueFrom: Schema.optionalKey(
                Schema.Struct({
                  secretKeyRef: Schema.optionalKey(
                    Schema.Struct({ name: Schema.String, key: Schema.String }),
                  ),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
});
type Stored = typeof Submitted.Type & {
  metadata: (typeof Submitted.Type)["metadata"] & {
    uid: string;
    resourceVersion: string;
    generation: number;
  };
  spec: Readonly<Record<string, unknown>>;
  status?: {
    serviceFQDN: string;
    conditions: Array<{ type: string; status: string; observedGeneration: number }>;
  };
};
const Patch = Schema.Array(
  Schema.Struct({ op: Schema.String, path: Schema.String, value: Schema.Unknown }),
);
const Delete = Schema.Struct({
  preconditions: Schema.Struct({ uid: Schema.String, resourceVersion: Schema.String }),
});
const decodeWorkerSpec = Schema.decodeUnknownSync(WorkerSpec);
const decodeSubmitted = Schema.decodeUnknownSync(Submitted);
const decodePatch = Schema.decodeUnknownSync(Patch);
const decodeDelete = Schema.decodeUnknownSync(Delete);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const services = Layer.mergeAll(
  NodeServices.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const tokenFile = NodePath.join(directory, "token");
  yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, "cluster-token"));
  const objects = new Map<string, Stored>();
  const workers = new Map<string, ReturnType<typeof createExecutionWorker>>();
  const pods = new Map<
    string,
    {
      metadata: {
        name: string;
        uid: string;
        resourceVersion: string;
        ownerReferences: Array<{ kind: string; uid: string }>;
      };
      status: { conditions: Array<{ type: string; status: string }> };
    }
  >();
  const journals: Array<Awaited<ReturnType<typeof openWorkerJournal>>> = [];
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const journal of journals) await journal.close();
    }),
  );
  const calls: Array<{ method: string; path: string }> = [];
  const busy = new Set<string>();
  let loseCreate: string | null = null;
  let losePatch = false;
  let deferReadiness = false;
  let slowSuspend = false;
  let canonicalizeStorage = false;
  let apiForbidden = false;
  let beforeQuiesce: (() => Promise<void>) | undefined;
  let afterQuiesce: (() => Promise<void>) | undefined;
  const startWorker = async (sandbox: Stored) => {
    const spec = decodeWorkerSpec(sandbox.spec);
    const env = spec.podTemplate.spec.containers[0]?.env ?? [];
    const value = (name: string) => {
      const found = env.find((item) => item.name === name)?.value;
      if (!found) throw new Error(`Missing ${name}`);
      return found;
    };
    const tokenName = env.find((item) => item.name === "T3_WORKER_TOKEN")?.valueFrom?.secretKeyRef
      ?.name;
    const secret = objects.get(`/api/v1/namespaces/test/secrets/${tokenName}`);
    if (!secret?.data?.token) throw new Error("Missing worker token");
    const podUid = NodeCrypto.randomUUID();
    const identity = {
      workspaceId: value("T3_WORKSPACE_ID"),
      allocationId: value("T3_ALLOCATION_ID"),
      generation: Number(value("T3_ALLOCATION_GENERATION")),
      podUid,
      incarnation: NodeCrypto.randomUUID(),
      protocolVersion: 1 as const,
    };
    const journal = await openWorkerJournal(
      NodePath.join(directory, `${identity.incarnation}.jsonl`),
      { incarnation: identity.incarnation },
    );
    journals.push(journal);
    workers.set(
      `${sandbox.metadata.name}.test`,
      createExecutionWorker({
        identity,
        token: Buffer.from(secret.data.token, "base64").toString("utf8"),
        journal,
        execute: async () => "ok",
        activity: async () => ({
          activeOperations: busy.has(identity.workspaceId) ? 1 : 0,
          pendingCallbacks: 0,
        }),
      }),
    );
    pods.set(sandbox.metadata.uid, {
      metadata: {
        name: sandbox.metadata.name,
        uid: podUid,
        resourceVersion: "1",
        ownerReferences: [{ kind: "Sandbox", uid: sandbox.metadata.uid }],
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    sandbox.status = {
      serviceFQDN: `${sandbox.metadata.name}.test`,
      conditions: [
        { type: "Ready", status: "True", observedGeneration: sandbox.metadata.generation },
      ],
    };
  };
  const api = yield* Effect.acquireRelease(
    Effect.promise(() =>
      listenWorker({
        host: "127.0.0.1",
        port: 0,
        handle: async (request) => {
          const url = new URL(request.url);
          calls.push({ method: request.method, path: url.pathname });
          if (request.headers.get("authorization") !== "Bearer cluster-token" || apiForbidden)
            return new Response(null, { status: 403 });
          if (request.method === "GET") {
            if (url.pathname.endsWith("/pods")) return Response.json({ items: [...pods.values()] });
            if (url.pathname.endsWith("/sandboxes"))
              return Response.json({
                items: [...objects.values()].filter((value) => value.kind === "Sandbox"),
              });
            const stored = objects.get(url.pathname);
            return stored ? Response.json(stored) : new Response(null, { status: 404 });
          }
          if (request.method === "POST") {
            const body = decodeSubmitted(await request.json());
            const key = `${url.pathname}/${body.metadata.name}`;
            if (objects.has(key)) return new Response(null, { status: 409 });
            const stored: Stored = {
              ...body,
              spec: body.spec ?? {},
              metadata: {
                ...body.metadata,
                uid: NodeCrypto.randomUUID(),
                resourceVersion: "1",
                generation: 1,
              },
            };
            if (canonicalizeStorage && body.kind === "PersistentVolumeClaim")
              stored.spec = { ...stored.spec, resources: { requests: { storage: "1Gi" } } };
            objects.set(key, stored);
            if (body.kind === "Sandbox" && !deferReadiness) await startWorker(stored);
            if (loseCreate === body.kind) {
              loseCreate = null;
              return new Response(null, { status: 500 });
            }
            return Response.json(stored, { status: 201 });
          }
          const stored = objects.get(url.pathname);
          if (!stored) return new Response(null, { status: 404 });
          if (request.method === "PATCH") {
            const patch = decodePatch(await request.json());
            if (
              patch[0]?.value !== stored.metadata.uid ||
              patch[1]?.value !== stored.metadata.resourceVersion
            )
              return new Response(null, { status: 409 });
            stored.metadata.resourceVersion = String(Number(stored.metadata.resourceVersion) + 1);
            stored.metadata.generation += 1;
            stored.spec = { ...stored.spec, operatingMode: patch[2]?.value };
            if (patch[2]?.value === "Suspended") {
              if (!slowSuspend) pods.delete(stored.metadata.uid);
              else {
                const pod = pods.get(stored.metadata.uid);
                if (pod) pod.status.conditions = [{ type: "Ready", status: "False" }];
              }
              workers.delete(`${stored.metadata.name}.test`);
              stored.status = {
                serviceFQDN: `${stored.metadata.name}.test`,
                conditions: [
                  {
                    type: "Suspended",
                    status: slowSuspend ? "False" : "True",
                    observedGeneration: stored.metadata.generation,
                  },
                ],
              };
            } else await startWorker(stored);
            if (losePatch) {
              losePatch = false;
              return new Response(null, { status: 500 });
            }
            return Response.json(stored);
          }
          const body = decodeDelete(await request.json());
          if (
            body.preconditions.uid !== stored.metadata.uid ||
            body.preconditions.resourceVersion !== stored.metadata.resourceVersion
          )
            return new Response(null, { status: 409 });
          objects.delete(url.pathname);
          pods.delete(stored.metadata.uid);
          workers.delete(`${stored.metadata.name}.test`);
          return Response.json({});
        },
      }),
    ),
    (server) => Effect.promise(server.close),
  );
  const workerFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const worker = workers.get(url.hostname);
    if (!worker) throw new Error("Worker unavailable");
    if (url.pathname === "/v1/quiesce") await beforeQuiesce?.();
    const response = await worker.handle(request);
    if (url.pathname === "/v1/quiesce") await afterQuiesce?.();
    return response;
  };
  const kube = yield* Kubernetes.Kubernetes.pipe(
    Effect.provide(
      Kubernetes.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3_KUBERNETES_URL: `http://127.0.0.1:${api.port}`,
              T3_KUBERNETES_TOKEN_FILE: tokenFile,
            }),
          ),
        ),
      ),
    ),
  );
  const lifecycleLayer = Lifecycle.layer.pipe(
    Layer.provide(Layer.succeed(Kubernetes.Kubernetes, kube)),
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, workerFetch))),
    ),
  );
  const makeLifecycle = Lifecycle.SandboxLifecycle.pipe(Effect.provide(lifecycleLayer));
  const lifecycle = yield* makeLifecycle;
  return {
    lifecycle,
    makeLifecycle,
    kube,
    calls,
    objects,
    pods,
    workers,
    busy,
    startWorker,
    loseNextCreate: (kind = "PersistentVolumeClaim") => {
      loseCreate = kind;
    },
    loseNextPatch: () => {
      losePatch = true;
    },
    deferReadiness: () => {
      deferReadiness = true;
    },
    slowSuspend: () => {
      slowSuspend = true;
    },
    canonicalizeStorage: () => {
      canonicalizeStorage = true;
    },
    denyApi: () => {
      apiForbidden = true;
    },
    beforeQuiesce: (callback: () => Promise<void>) => {
      beforeQuiesce = callback;
    },
    afterQuiesce: (callback: () => Promise<void>) => {
      afterQuiesce = callback;
    },
  };
});

it.live(
  "isolates identical root paths, coalesces duplicate creates, and recovers a lost create response",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.loseNextCreate();
      const a = yield* f.lifecycle.ensure("root-a", placement);
      const retry = yield* f.lifecycle.ensure("root-a", placement);
      const b = yield* f.lifecycle.ensure("root-b", placement);
      expect(a.state).toBe("running");
      expect(retry.identity).toEqual(a.identity);
      expect(b.identity?.allocationId).not.toBe(a.identity?.allocationId);
      const claims = [...f.objects.values()].filter(
        (value) => value.kind === "PersistentVolumeClaim",
      );
      expect(claims).toHaveLength(2);
      const sandboxes = [...f.objects.values()].filter((value) => value.kind === "Sandbox");
      expect(sandboxes).toHaveLength(2);
      expect(
        sandboxes.every((value) => encodeJson(value.spec).includes('"mountPath":"/workspace"')),
      ).toBe(true);
    }).pipe(Effect.provide(services)),
);

it.live("central restart observes the same live worker without provisioning or resuming it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = yield* f.lifecycle.ensure("root", placement);
    const restarted = yield* f.makeLifecycle;
    f.calls.length = 0;
    const observed = yield* restarted.observe("root", placement);
    expect(observed.state).toBe("running");
    expect(observed.identity).toEqual(original.identity);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }).pipe(Effect.provide(services)),
);

it.live("replacement fences stale worker identity and requires explicit acquisition", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = yield* f.lifecycle.ensure("root", placement);
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    yield* Effect.promise(() => f.startWorker(sandbox));
    const observed = yield* f.lifecycle.observe("root", placement);
    expect(observed.state).toBe("starting");
    expect(observed.identity?.incarnation).not.toBe(original.identity?.incarnation);
    const stale = yield* f.lifecycle
      .setDesiredState("root", placement, "suspended", original.version)
      .pipe(Effect.flip);
    expect(stale.httpStatus).toBe(412);
    const current = yield* f.lifecycle.ensure("root", placement);
    expect(current.state).toBe("running");
    expect(current.identity).toEqual(observed.identity);
  }).pipe(Effect.provide(services)),
);

it.live("busy workers reject stop; suspension and release retain workspace storage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const running = yield* f.lifecycle.ensure("root", placement);
    f.busy.add("root");
    const busy = yield* f.lifecycle.setDesiredState(
      "root",
      placement,
      "suspended",
      running.version,
    );
    expect(busy.error?.code).toBe("worker_busy");
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    f.busy.delete("root");
    yield* f.lifecycle.observe("root", placement);
    const suspended = yield* f.lifecycle.observe("root", placement);
    expect(suspended.state).toBe("suspended");
    const pvc = [...f.objects.values()].find((value) => value.kind === "PersistentVolumeClaim");
    yield* f.lifecycle.setDesiredState("root", placement, "released", suspended.version);
    const released = yield* f.lifecycle.observe("root", placement);
    expect(released.state).toBe("released");
    expect([...f.objects.values()]).toEqual([pvc]);
    f.calls.length = 0;
    yield* f.lifecycle.observe("root", placement);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    const resumed = yield* f.lifecycle.setDesiredState(
      "root",
      placement,
      "running",
      released.version,
    );
    expect(resumed.state).toBe("running");
    expect(resumed.identity?.allocationId).not.toBe(running.identity?.allocationId);
    expect(
      [...f.objects.values()].find((value) => value.kind === "PersistentVolumeClaim")?.metadata.uid,
    ).toBe(pvc?.metadata.uid);
  }).pipe(Effect.provide(services)),
);

it.live("rechecks durable intent after worker quiescence before mutating compute", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const running = yield* f.lifecycle.ensure("root", placement);
    // This models recovery superseding an accepted stop between the worker and Kubernetes boundaries.
    const { captureRunPromise } = yield* Effect.promise(
      () => import("../execution/EffectHttpBoundary.ts"),
    );
    const run = yield* captureRunPromise;
    f.afterQuiesce(() =>
      run(
        sql`UPDATE t3_sandbox_lifecycle SET desired_state='running', version=version+1 WHERE workspace_id='root'`,
      ).then(() => undefined),
    );
    const error = yield* f.lifecycle
      .setDesiredState("root", placement, "suspended", running.version)
      .pipe(Effect.flip);
    expect(error.httpStatus).toBe(412);
    expect(
      f.calls.filter((call) => call.method === "PATCH" || call.method === "DELETE"),
    ).toHaveLength(0);
    const resumed = yield* f.lifecycle.ensure("root", placement);
    expect(resumed.state).toBe("running");
  }).pipe(Effect.provide(services)),
);

it.live("does not adopt foreign resources or hide Kubernetes authorization failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.lifecycle.ensure("root", placement);
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    sandbox.metadata = {
      ...sandbox.metadata,
      annotations: { "t3.codes/workspace": "another-root" },
    };
    const error = yield* f.lifecycle.observe("root", placement).pipe(Effect.flip);
    expect(error.operation).toBe("ownership");
    f.denyApi();
    expect(yield* f.kube.available(placement)).toBe(false);
    const denied = yield* f.lifecycle.observe("root", placement).pipe(Effect.flip);
    expect(denied.httpStatus).toBe(403);
  }).pipe(Effect.provide(services)),
);

it.live("legacy workspaces require an explicitly restored retained PVC", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE agent_runtime_workspaces(workspace_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO agent_runtime_workspaces VALUES ('legacy-root')`;
    const f = yield* fixture;
    const error = yield* f.lifecycle.ensure("legacy-root", placement).pipe(Effect.flip);
    expect(error.operation).toBe("cutover");
    expect([...f.objects.values()]).toHaveLength(0);
    const hash = NodeCrypto.createHash("sha256").update("legacy-root").digest("hex").slice(0, 32);
    const name = `t3-ws-${hash}`;
    f.objects.set(`/api/v1/namespaces/test/persistentvolumeclaims/${name}`, {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace: "test",
        uid: "restored-volume",
        resourceVersion: "1",
        generation: 1,
        labels: { "app.kubernetes.io/managed-by": "t3-code", "t3.codes/workspace": hash },
        annotations: { "t3.codes/workspace": "legacy-root" },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "standard",
        resources: { requests: { storage: "10Gi" } },
        dataSource: {
          name: "old-workspace-snapshot",
          kind: "VolumeSnapshot",
          apiGroup: "snapshot.storage.k8s.io",
        },
      },
    });
    const admitted = yield* f.lifecycle.ensure("legacy-root", placement);
    expect(admitted.state).toBe("running");
    expect(
      [...f.objects.values()].find((value) => value.kind === "PersistentVolumeClaim")?.metadata.uid,
    ).toBe("restored-volume");
    yield* sql`INSERT INTO agent_runtime_workspaces VALUES ('new-root')`;
    const restarted = yield* f.makeLifecycle;
    const fresh = yield* restarted.ensure("new-root", placement);
    expect(fresh.state).toBe("running");
  }).pipe(Effect.provide(services)),
);

it.live("explicit acquisition completes delayed readiness; passive observation never resumes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.deferReadiness();
    const pending = yield* f.lifecycle.ensure("root", placement);
    expect(pending.state).toBe("starting");
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    yield* Effect.promise(() => f.startWorker(sandbox));
    const observed = yield* f.lifecycle.observe("root", placement);
    expect(observed.state).toBe("starting");
    const ready = yield* f.lifecycle.setDesiredState(
      "root",
      placement,
      "running",
      observed.version,
    );
    expect(ready.state).toBe("running");
  }).pipe(Effect.provide(services)),
);

it.live("restart completes an accepted stop whose Kubernetes response was lost", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.loseNextCreate("Sandbox");
    const running = yield* f.lifecycle.ensure("root", placement);
    f.loseNextPatch();
    const interrupted = yield* f.lifecycle
      .setDesiredState("root", placement, "suspended", running.version)
      .pipe(Effect.flip);
    expect(interrupted.httpStatus).toBe(500);
    const restarted = yield* f.makeLifecycle;
    const suspended = yield* restarted.observe("root", placement);
    expect(suspended.state).toBe("suspended");
    expect(suspended.identity).toEqual(running.identity);
    const restored = yield* restarted.setDesiredState(
      "root",
      placement,
      "running",
      suspended.version,
    );
    expect(restored.state).toBe("running");
    expect(restored.identity?.incarnation).not.toBe(running.identity?.incarnation);
  }).pipe(Effect.provide(services)),
);

it.live("replacement during a stop fences the stop instead of deleting new compute", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const running = yield* f.lifecycle.ensure("root", placement);
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    yield* Effect.promise(() => f.startWorker(sandbox));
    f.calls.length = 0;
    const interrupted = yield* f.lifecycle.setDesiredState(
      "root",
      placement,
      "released",
      running.version,
    );
    expect(interrupted.state).toBe("failed");
    expect(interrupted.desiredState).toBe("running");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    const ready = yield* f.lifecycle.ensure("root", placement);
    expect(ready.state).toBe("running");
  }).pipe(Effect.provide(services)),
);

it.live("missing or replaced retained storage never provisions an empty replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.lifecycle.ensure("root", placement);
    const pvcEntry = [...f.objects.entries()].find(
      ([, value]) => value.kind === "PersistentVolumeClaim",
    );
    if (!pvcEntry) throw new Error("Missing PVC");
    f.objects.delete(pvcEntry[0]);
    f.calls.length = 0;
    const missing = yield* f.lifecycle.ensure("root", placement).pipe(Effect.flip);
    expect(missing.operation).toBe("storage");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    pvcEntry[1].metadata.uid = "replacement-pvc";
    f.objects.set(pvcEntry[0], pvcEntry[1]);
    const replaced = yield* f.lifecycle.ensure("root", placement).pipe(Effect.flip);
    expect(replaced.operation).toBe("storage");
  }).pipe(Effect.provide(services)),
);

it.live("never-admitted pending workloads can release without a ready worker", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.deferReadiness();
    const starting = yield* f.lifecycle.ensure("root", placement);
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    f.pods.set(sandbox.metadata.uid, {
      metadata: {
        name: "unschedulable",
        uid: "pending-pod",
        resourceVersion: "1",
        ownerReferences: [{ kind: "Sandbox", uid: sandbox.metadata.uid }],
      },
      status: { conditions: [{ type: "Ready", status: "False" }] },
    });
    const stopping = yield* f.lifecycle.setDesiredState(
      "root",
      placement,
      "released",
      starting.version,
    );
    expect(stopping.state).toBe("releasing");
    const released = yield* f.lifecycle.observe("root", placement);
    expect(released.state).toBe("released");
  }).pipe(Effect.provide(services)),
);

it.live("accepted suspension stays suspending while the quiesced pod terminates", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const running = yield* f.lifecycle.ensure("root", placement);
    f.slowSuspend();
    yield* f.lifecycle.setDesiredState("root", placement, "suspended", running.version);
    const observed = yield* f.lifecycle.observe("root", placement);
    expect(observed.state).toBe("suspending");
  }).pipe(Effect.provide(services)),
);

it.live("accepts Kubernetes-normalized retained storage quantities", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.canonicalizeStorage();
    const running = yield* f.lifecycle.ensure("root", {
      ...placement,
      storage: { ...placement.storage, size: "1024Mi" },
    });
    expect(running.state).toBe("running");
  }).pipe(Effect.provide(services)),
);

it.live.each(["shutdownTime", "volumeClaimTemplates"])("rejects unmanaged %s on compute", (field) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.lifecycle.ensure("root", placement);
    const sandbox = [...f.objects.values()].find((value) => value.kind === "Sandbox");
    if (!sandbox) throw new Error("Missing sandbox");
    sandbox.spec = {
      ...sandbox.spec,
      [field]: field === "shutdownTime" ? "2027-01-01T00:00:00Z" : [],
    };
    const error = yield* f.lifecycle.observe("root", placement).pipe(Effect.flip);
    expect(error.operation).toBe("identity");
  }).pipe(Effect.provide(services)),
);
