// @effect-diagnostics nodeBuiltinImport:off -- Names and credentials for Kubernetes resources.
import * as NodeCrypto from "node:crypto";
import { ExecutionIdentity } from "../../../../packages/contracts/src/execution.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Configuration from "./Configuration.ts";
import * as Kubernetes from "./Kubernetes.ts";
import { sameQuantity } from "./Quantity.ts";

const DesiredState = Schema.Literals(["running", "suspended", "released"]);
const Failure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export const WorkspaceResource = Schema.Struct({
  id: Schema.String,
  pool: Schema.String,
  profile: Schema.String,
  desiredState: DesiredState,
  state: Schema.Literals([
    "running",
    "suspended",
    "released",
    "starting",
    "suspending",
    "releasing",
    "failed",
    "unavailable",
  ]),
  version: Schema.NonEmptyString,
  progress: Schema.NullOr(Schema.Struct({ step: Schema.String, startedAt: Schema.String })),
  error: Schema.NullOr(Failure),
  identity: Schema.NullOr(ExecutionIdentity),
  execution: Schema.NullOr(
    Schema.Struct({ identity: ExecutionIdentity, endpoint: Schema.String, token: Schema.String }),
  ),
});
export type WorkspaceResource = typeof WorkspaceResource.Type;
export class SandboxLifecycleError extends Schema.TaggedError<SandboxLifecycleError>()(
  "SandboxLifecycleError",
  {
    operation: Schema.String,
    httpStatus: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Sandbox ${this.operation} failed.`;
  }
}

export class SandboxLifecycle extends Context.Service<
  SandboxLifecycle,
  {
    readonly ensure: (
      workspaceId: string,
      placement: Configuration.Placement,
    ) => Effect.Effect<WorkspaceResource, SandboxLifecycleError>;
    readonly observe: (
      workspaceId: string,
      placement: Configuration.Placement,
    ) => Effect.Effect<WorkspaceResource, SandboxLifecycleError>;
    readonly setDesiredState: (
      workspaceId: string,
      placement: Configuration.Placement,
      state: typeof DesiredState.Type,
      expectedVersion: string,
    ) => Effect.Effect<WorkspaceResource, SandboxLifecycleError>;
  }
>()("t3/sandbox/SandboxLifecycle") {}

const Metadata = Schema.Struct({
  name: Schema.String,
  uid: Schema.String,
  resourceVersion: Schema.String,
  generation: Schema.optionalKey(Schema.Number),
  deletionTimestamp: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ownerReferences: Schema.optionalKey(
    Schema.Array(Schema.Struct({ uid: Schema.String, kind: Schema.String })),
  ),
});
const Resource = Schema.Struct({
  metadata: Metadata,
  spec: Schema.optionalKey(Schema.Unknown),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  status: Schema.optionalKey(
    Schema.Struct({
      serviceFQDN: Schema.optionalKey(Schema.String),
      conditions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            status: Schema.String,
            observedGeneration: Schema.optionalKey(Schema.Number),
          }),
        ),
      ),
    }),
  ),
});
type Resource = typeof Resource.Type;
const PodList = Schema.Struct({ items: Schema.Array(Resource) });
const Row = Schema.Struct({
  workspace_id: Schema.String,
  placement_json: Schema.String,
  desired_state: DesiredState,
  version: Schema.Number,
  allocation_id: Schema.String,
  generation: Schema.Number,
  token: Schema.String,
  identity_json: Schema.NullOr(Schema.String),
  sandbox_uid: Schema.NullOr(Schema.String),
  pvc_uid: Schema.NullOr(Schema.String),
  quiesced_identity_json: Schema.NullOr(Schema.String),
  resumed_version: Schema.Number,
});
type Row = typeof Row.Type;
const decodeRow = Schema.decodeUnknownEffect(Row);
const encodePlacement = Schema.encodeEffect(Schema.fromJsonString(Configuration.Placement));
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(ExecutionIdentity));
const isLifecycleError = Schema.is(SandboxLifecycleError);
const isKubernetesError = Schema.is(Kubernetes.KubernetesError);
const decodePlacement = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration.Placement));
const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionIdentity));
const decodeResource = Schema.decodeUnknownEffect(Resource);
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const names = (row: Row) => ({
  pvc: `t3-ws-${digest(row.workspace_id).slice(0, 32)}`,
  sandbox: `t3-ex-${digest(`${row.workspace_id}:${row.allocation_id}`).slice(0, 32)}`,
  secret: `t3-auth-${digest(`${row.workspace_id}:${row.allocation_id}`).slice(0, 32)}`,
});

/** API defaults may add fields, but every field T3 requested must remain unchanged. */
function requestedMatches(
  expected: unknown,
  actual: unknown,
  path: ReadonlyArray<string> = [],
): boolean {
  if (expected === actual) return true;
  if (
    typeof expected === "string" &&
    typeof actual === "string" &&
    ["cpu", "memory", "storage"].includes(path.at(-1) ?? "") &&
    ["requests", "limits"].includes(path.at(-2) ?? "")
  )
    return sameQuantity(expected, actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) =>
        requestedMatches(value, actual[index], [...path, String(index)]),
      )
    );
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  )
    return false;
  const entries = new Map(Object.entries(actual));
  return Object.entries(expected).every(
    ([key, value]) => entries.has(key) && requestedMatches(value, entries.get(key), [...path, key]),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const kube = yield* Kubernetes.Kubernetes;
  const http = yield* HttpClient.HttpClient;
  yield* sql`CREATE TABLE IF NOT EXISTS t3_sandbox_lifecycle (
    workspace_id TEXT PRIMARY KEY,
    placement_json TEXT NOT NULL,
    desired_state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    allocation_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    token TEXT NOT NULL,
    identity_json TEXT,
    sandbox_uid TEXT,
    pvc_uid TEXT,
    quiesced_identity_json TEXT,
    resumed_version INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS t3_sandbox_legacy_workspaces (workspace_id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE IF NOT EXISTS t3_sandbox_migrations (id TEXT PRIMARY KEY)`;
      const initialized =
        yield* sql`SELECT id FROM t3_sandbox_migrations WHERE id='native-cutover'`;
      if (initialized.length > 0) return;
      const legacy =
        yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runtime_workspaces'`;
      if (legacy.length > 0)
        yield* sql`INSERT OR IGNORE INTO t3_sandbox_legacy_workspaces(workspace_id)
        SELECT workspace_id FROM agent_runtime_workspaces`;
      yield* sql`INSERT INTO t3_sandbox_migrations(id) VALUES ('native-cutover')`;
    }),
  );
  // One central writer owns lifecycle. Different workspaces never share a lock.
  const locks = new Map<string, Semaphore.Semaphore>();
  const locked = <A, E, R>(workspaceId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let lock = locks.get(workspaceId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(workspaceId, lock);
      }
      return yield* lock.withPermit(effect);
    });
  const read = Effect.fn("SandboxLifecycle.read")(function* (
    workspaceId: string,
    placement: Configuration.Placement,
  ) {
    const rows = yield* sql`SELECT * FROM t3_sandbox_lifecycle WHERE workspace_id=${workspaceId}`;
    if (!rows[0])
      return yield* new SandboxLifecycleError({
        operation: "observe",
        httpStatus: 404,
        cause: "Unknown workspace",
      });
    const row = yield* decodeRow(rows[0]);
    const pinned = yield* decodePlacement(row.placement_json);
    if (
      pinned.id !== placement.id ||
      pinned.namespace !== placement.namespace ||
      pinned.profile !== placement.profile
    )
      return yield* new SandboxLifecycleError({
        operation: "placement",
        cause: "Workspace placement changed",
      });
    return { row, placement: pinned };
  });
  const get = Effect.fn("SandboxLifecycle.getResource")(function* (path: string) {
    return yield* kube.request("GET", path).pipe(
      Effect.flatMap(decodeResource),
      Effect.catchTags({
        KubernetesError: (error) =>
          error.httpStatus === 404 ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  });
  const metadata = (row: Row, name: string, placement: Configuration.Placement) => ({
    name,
    namespace: placement.namespace,
    labels: {
      "app.kubernetes.io/managed-by": "t3-code",
      "t3.codes/workspace": digest(row.workspace_id).slice(0, 32),
    },
    annotations: { "t3.codes/workspace": row.workspace_id },
  });
  const owned = Effect.fn("SandboxLifecycle.validateOwner")(function* (
    resource: Resource,
    row: Row,
    name: string,
  ) {
    if (
      resource.metadata.name !== name ||
      resource.metadata.labels?.["app.kubernetes.io/managed-by"] !== "t3-code" ||
      resource.metadata.annotations?.["t3.codes/workspace"] !== row.workspace_id ||
      (resource.metadata.ownerReferences?.length ?? 0) !== 0
    )
      return yield* new SandboxLifecycleError({
        operation: "ownership",
        cause: "Resource ownership mismatch",
      });
    return resource;
  });
  const create = Effect.fn("SandboxLifecycle.createResource")(function* (
    path: string,
    body: unknown,
    name: string,
  ) {
    const existing = yield* get(`${path}/${name}`);
    if (existing) return existing;
    return yield* kube.request("POST", path, body).pipe(
      Effect.flatMap(decodeResource),
      Effect.catchTags({
        KubernetesError: (error) =>
          Effect.gen(function* () {
            // An interrupted response can hide a successful create. The caller still verifies ownership.
            const recovered = yield* get(`${path}/${name}`);
            if (recovered) return recovered;
            return yield* error;
          }),
      }),
    );
  });
  const result = Effect.fn("SandboxLifecycle.result")(function* (
    row: Row,
    placement: Configuration.Placement,
    state: WorkspaceResource["state"],
    execution: WorkspaceResource["execution"] = null,
    error: WorkspaceResource["error"] = null,
  ) {
    return {
      id: row.workspace_id,
      pool: placement.id,
      profile: placement.profile,
      desiredState: row.desired_state,
      version: String(row.version),
      state,
      error,
      progress: null,
      identity: row.identity_json ? yield* decodeIdentity(row.identity_json) : null,
      execution,
    } satisfies WorkspaceResource;
  });
  const podSpec = (row: Row, placement: Configuration.Placement) => {
    const resourceNames = names(row);
    return {
      service: true,
      podTemplate: {
        metadata: { labels: { "t3.codes/workspace": digest(row.workspace_id).slice(0, 32) } },
        spec: {
          automountServiceAccountToken: false,
          ...(placement.serviceAccountName
            ? { serviceAccountName: placement.serviceAccountName }
            : {}),
          containers: [
            {
              name: "worker",
              image: placement.image,
              resources: placement.resources,
              ...(placement.workerEnvSecret || placement.workerEnvConfigMap
                ? {
                    envFrom: [
                      ...(placement.workerEnvConfigMap
                        ? [{ configMapRef: { name: placement.workerEnvConfigMap } }]
                        : []),
                      ...(placement.workerEnvSecret
                        ? [{ secretRef: { name: placement.workerEnvSecret } }]
                        : []),
                    ],
                  }
                : {}),
              env: [
                { name: "T3_WORKSPACE_ID", value: row.workspace_id },
                { name: "T3_ALLOCATION_ID", value: row.allocation_id },
                { name: "T3_ALLOCATION_GENERATION", value: String(row.generation) },
                { name: "T3_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
                {
                  name: "T3_WORKER_TOKEN",
                  valueFrom: { secretKeyRef: { name: resourceNames.secret, key: "token" } },
                },
                { name: "T3_WORKER_PORT", value: "8083" },
                { name: "T3_WORKSPACE_ROOT", value: "/workspace" },
                { name: "T3_WORKER_STATE_DIR", value: "/workspace/.t3-worker" },
              ],
              ports: [{ name: "worker", containerPort: 8083 }],
              readinessProbe: { tcpSocket: { port: "worker" }, periodSeconds: 2 },
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
          ],
          volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: resourceNames.pvc } }],
        },
      },
    };
  };
  const checkSandbox = Effect.fn("SandboxLifecycle.validateSandbox")(function* (
    resource: Resource,
    row: Row,
    placement: Configuration.Placement,
  ) {
    yield* owned(resource, row, names(row).sandbox);
    if (
      (row.sandbox_uid !== null && row.sandbox_uid !== resource.metadata.uid) ||
      !requestedMatches(podSpec(row, placement), resource.spec) ||
      (resource.spec !== null &&
        typeof resource.spec === "object" &&
        ("shutdownTime" in resource.spec || "volumeClaimTemplates" in resource.spec)) ||
      resource.metadata.annotations?.["t3.codes/pvc-uid"] !== row.pvc_uid
    )
      return yield* new SandboxLifecycleError({
        operation: "identity",
        cause: "Sandbox allocation or pod specification changed",
      });
    return resource;
  });
  const persistSandbox = Effect.fn("SandboxLifecycle.persistSandbox")(function* (
    row: Row,
    resource: Resource,
  ) {
    if (row.sandbox_uid === resource.metadata.uid) return row;
    yield* sql`UPDATE t3_sandbox_lifecycle SET sandbox_uid=${resource.metadata.uid} WHERE workspace_id=${row.workspace_id} AND version=${row.version}`;
    return { ...row, sandbox_uid: resource.metadata.uid };
  });
  const provision = Effect.fn("SandboxLifecycle.provision")(function* (
    row: Row,
    placement: Configuration.Placement,
  ) {
    const resourceNames = names(row);
    const paths = Kubernetes.paths(placement.namespace);
    const storageSpec = {
      accessModes: ["ReadWriteOnce"],
      ...(placement.storage.storageClassName
        ? { storageClassName: placement.storage.storageClassName }
        : {}),
      resources: { requests: { storage: placement.storage.size } },
    };
    const existingPvc =
      row.pvc_uid !== null ? yield* get(`${paths.pvcs}/${resourceNames.pvc}`) : null;
    if (row.pvc_uid !== null && !existingPvc)
      return yield* new SandboxLifecycleError({
        operation: "storage",
        cause: "Retained workspace storage is missing",
      });
    const pvc =
      existingPvc ??
      (yield* create(
        paths.pvcs,
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: metadata(row, resourceNames.pvc, placement),
          spec: storageSpec,
        },
        resourceNames.pvc,
      ));
    yield* owned(pvc, row, resourceNames.pvc);
    if (
      pvc.metadata.deletionTimestamp ||
      (row.pvc_uid !== null && row.pvc_uid !== pvc.metadata.uid) ||
      !requestedMatches(storageSpec, pvc.spec)
    )
      return yield* new SandboxLifecycleError({
        operation: "storage",
        cause: "Workspace storage changed",
      });
    yield* sql`UPDATE t3_sandbox_lifecycle SET pvc_uid=${pvc.metadata.uid} WHERE workspace_id=${row.workspace_id} AND version=${row.version}`;
    row = { ...row, pvc_uid: pvc.metadata.uid };
    const secret = yield* create(
      paths.secrets,
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: metadata(row, resourceNames.secret, placement),
        immutable: true,
        data: { token: Buffer.from(row.token).toString("base64") },
      },
      resourceNames.secret,
    );
    yield* owned(secret, row, resourceNames.secret);
    if (
      secret.metadata.deletionTimestamp ||
      secret.data?.token !== Buffer.from(row.token).toString("base64")
    )
      return yield* new SandboxLifecycleError({
        operation: "credential",
        cause: "Worker credential changed",
      });
    const sandbox = yield* create(
      paths.sandboxes,
      {
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        metadata: {
          ...metadata(row, resourceNames.sandbox, placement),
          annotations: {
            "t3.codes/workspace": row.workspace_id,
            "t3.codes/pvc-uid": pvc.metadata.uid,
          },
        },
        spec: { ...podSpec(row, placement), operatingMode: "Running" },
      },
      resourceNames.sandbox,
    );
    yield* checkSandbox(sandbox, row, placement);
    row = yield* persistSandbox(row, sandbox);
    return { row, sandbox };
  });
  const podsFor = Effect.fn("SandboxLifecycle.pods")(function* (
    row: Row,
    placement: Configuration.Placement,
  ) {
    const response = yield* kube
      .request(
        "GET",
        `${Kubernetes.paths(placement.namespace).pods}?labelSelector=${encodeURIComponent(`t3.codes/workspace=${digest(row.workspace_id).slice(0, 32)}`)}`,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PodList)));
    return response.items.filter((pod) =>
      pod.metadata.ownerReferences?.some(
        (owner) => owner.kind === "Sandbox" && owner.uid === row.sandbox_uid,
      ),
    );
  });
  const workerRequest = Effect.fn("SandboxLifecycle.workerRequest")(function* (
    row: Row,
    endpoint: string,
    path: string,
    body?: unknown,
  ) {
    let request = (
      body === undefined
        ? HttpClientRequest.get(`${endpoint}${path}`)
        : HttpClientRequest.post(`${endpoint}${path}`)
    ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${row.token}`));
    if (body !== undefined) request = yield* HttpClientRequest.bodyJson(request, body);
    const response = yield* http.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) => new SandboxLifecycleError({ operation: path, httpStatus: 503, cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new SandboxLifecycleError({
        operation: path,
        httpStatus: response.status,
        cause: "Worker lifecycle request rejected",
      });
    return yield* response.json.pipe(
      Effect.mapError((cause) => new SandboxLifecycleError({ operation: path, cause })),
    );
  });
  const workerTransition = Effect.fn("SandboxLifecycle.workerTransition")(function* (
    row: Row,
    endpoint: string,
    identity: ExecutionIdentity,
    action: "resume" | "quiesce",
  ) {
    const reply = yield* workerRequest(row, endpoint, `/v1/${action}`, {
      identity,
      revision: row.version,
      operationId: `${row.desired_state}:${row.version}`,
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            ...ExecutionIdentity.fields,
            revision: Schema.Number,
            quiescent: Schema.Boolean,
            activeOperations: Schema.Number,
            pendingCallbacks: Schema.Number,
          }),
        ),
      ),
    );
    if (
      reply.workspaceId !== identity.workspaceId ||
      reply.allocationId !== identity.allocationId ||
      reply.generation !== identity.generation ||
      reply.podUid !== identity.podUid ||
      reply.incarnation !== identity.incarnation ||
      reply.revision !== row.version ||
      reply.quiescent !== (action === "quiesce") ||
      reply.activeOperations !== 0 ||
      reply.pendingCallbacks !== 0
    )
      return yield* new SandboxLifecycleError({
        operation: "worker-transition",
        cause: "Worker lifecycle acknowledgement did not match intent",
      });
  });
  const identify = Effect.fn("SandboxLifecycle.identify")(function* (
    row: Row,
    sandbox: Resource,
    pods: ReadonlyArray<Resource>,
  ) {
    const hostname = sandbox.status?.serviceFQDN;
    const ready = pods.filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
    );
    if (
      sandbox.metadata.deletionTimestamp ||
      ready.length !== 1 ||
      pods.length !== 1 ||
      !hostname ||
      !sandbox.status?.conditions?.some(
        (condition) =>
          condition.type === "Ready" &&
          condition.status === "True" &&
          condition.observedGeneration === sandbox.metadata.generation,
      )
    )
      return null;
    // Kubernetes service status is a hostname, never an arbitrary URL with credentials or paths.
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname))
      return yield* new SandboxLifecycleError({
        operation: "endpoint",
        cause: "Invalid sandbox service hostname",
      });
    const endpoint = `http://${hostname}:8083`;
    const identity = yield* workerRequest(row, endpoint, "/v1/identity").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExecutionIdentity)),
    );
    if (
      identity.workspaceId !== row.workspace_id ||
      identity.allocationId !== row.allocation_id ||
      identity.generation !== row.generation ||
      identity.podUid !== ready[0]?.metadata.uid
    )
      return yield* new SandboxLifecycleError({
        operation: "identity",
        cause: "Worker identity does not match allocation",
      });
    const encoded = yield* encodeIdentity(identity);
    if (row.identity_json !== encoded) {
      // A new incarnation fences stop receipts and provider calls from the previous process.
      const version = row.identity_json === null ? row.version : row.version + 1;
      const desiredState = row.identity_json === null ? row.desired_state : "running";
      yield* sql`UPDATE t3_sandbox_lifecycle SET identity_json=${encoded}, version=${version}, desired_state=${desiredState}, quiesced_identity_json=NULL, resumed_version=0 WHERE workspace_id=${row.workspace_id} AND version=${row.version}`;
      row = {
        ...row,
        identity_json: encoded,
        version,
        desired_state: desiredState,
        quiesced_identity_json: null,
        resumed_version: 0,
      };
    }
    return { row, identity, endpoint, token: row.token };
  });
  const patchMode = Effect.fn("SandboxLifecycle.patchMode")(function* (
    row: Row,
    placement: Configuration.Placement,
    sandbox: Resource,
    mode: "Running" | "Suspended",
  ) {
    const patch = [
      { op: "test", path: "/metadata/uid", value: sandbox.metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: sandbox.metadata.resourceVersion },
      { op: "add", path: "/spec/operatingMode", value: mode },
    ];
    return yield* kube
      .request(
        "PATCH",
        `${Kubernetes.paths(placement.namespace).sandboxes}/${names(row).sandbox}`,
        patch,
      )
      .pipe(Effect.flatMap(decodeResource));
  });
  const remove = Effect.fn("SandboxLifecycle.removeResource")(function* (
    path: string,
    resource: Resource,
  ) {
    yield* kube
      .request("DELETE", path, {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Foreground",
        preconditions: {
          uid: resource.metadata.uid,
          resourceVersion: resource.metadata.resourceVersion,
        },
      })
      .pipe(
        Effect.catchTags({
          KubernetesError: (error) => (error.httpStatus === 404 ? Effect.void : Effect.fail(error)),
        }),
      );
  });
  const freshVersion = Effect.fn("SandboxLifecycle.fence")(function* (
    row: Row,
    placement: Configuration.Placement,
  ) {
    const current = yield* read(row.workspace_id, placement);
    if (current.row.version !== row.version || current.row.desired_state !== row.desired_state)
      return yield* new SandboxLifecycleError({
        operation: "transition",
        httpStatus: 412,
        cause: "Lifecycle intent superseded",
      });
  });
  const reconcile = Effect.fn("SandboxLifecycle.reconcile")(function* (
    initial: Row,
    placement: Configuration.Placement,
    allowWake: boolean,
  ) {
    let row = initial;
    const paths = Kubernetes.paths(placement.namespace);
    const resourceNames = names(row);
    let sandbox = yield* get(`${paths.sandboxes}/${resourceNames.sandbox}`);
    if (sandbox) {
      const pvc = yield* get(`${paths.pvcs}/${resourceNames.pvc}`);
      if (!pvc || pvc.metadata.deletionTimestamp || pvc.metadata.uid !== row.pvc_uid)
        return yield* new SandboxLifecycleError({
          operation: "storage",
          cause: "Retained workspace storage is missing or replaced",
        });
      yield* owned(pvc, row, resourceNames.pvc);
      yield* checkSandbox(sandbox, row, placement);
      row = yield* persistSandbox(row, sandbox);
    }
    if (row.desired_state === "running") {
      if (!sandbox) {
        if (!allowWake) return yield* result(row, placement, "unavailable");
        if (row.sandbox_uid !== null) {
          const oldPods = yield* podsFor(row, placement);
          if (oldPods.length > 0) return yield* result(row, placement, "starting");
          const oldSecret = yield* get(`${paths.secrets}/${resourceNames.secret}`);
          if (oldSecret) {
            yield* owned(oldSecret, row, resourceNames.secret);
            yield* remove(`${paths.secrets}/${resourceNames.secret}`, oldSecret);
          }
          row = {
            ...row,
            version: row.version + 1,
            allocation_id: NodeCrypto.randomUUID(),
            generation: row.generation + 1,
            token: NodeCrypto.randomBytes(32).toString("hex"),
            sandbox_uid: null,
            identity_json: null,
            quiesced_identity_json: null,
            resumed_version: 0,
          };
          yield* sql`UPDATE t3_sandbox_lifecycle SET version=${row.version}, allocation_id=${row.allocation_id}, generation=${row.generation}, token=${row.token}, sandbox_uid=NULL, identity_json=NULL, quiesced_identity_json=NULL, resumed_version=0 WHERE workspace_id=${row.workspace_id} AND version=${initial.version}`;
        }
        const provisioned = yield* provision(row, placement);
        row = provisioned.row;
        sandbox = provisioned.sandbox;
      }
      if (sandbox.metadata.deletionTimestamp) return yield* result(row, placement, "starting");
      if (allowWake && !requestedMatches({ operatingMode: "Running" }, sandbox.spec))
        sandbox = yield* patchMode(row, placement, sandbox, "Running");
      if (!requestedMatches({ operatingMode: "Running" }, sandbox.spec))
        return yield* result(row, placement, "starting");
      const pods = yield* podsFor(row, placement);
      const access = yield* identify(row, sandbox, pods);
      if (!access) return yield* result(row, placement, "starting");
      row = access.row;
      if (allowWake && row.resumed_version !== row.version) {
        yield* workerTransition(row, access.endpoint, access.identity, "resume");
        yield* freshVersion(row, placement);
        yield* sql`UPDATE t3_sandbox_lifecycle SET resumed_version=${row.version} WHERE workspace_id=${row.workspace_id} AND version=${row.version}`;
        row = { ...row, resumed_version: row.version };
      }
      if (row.resumed_version !== row.version) return yield* result(row, placement, "starting");
      return yield* result(row, placement, "running", {
        identity: access.identity,
        endpoint: access.endpoint,
        token: row.token,
      });
    }
    const pods = yield* podsFor(row, placement);
    // A workload never admitted to execution has no user operations to drain.
    const stopping =
      sandbox &&
      requestedMatches({ operatingMode: "Suspended" }, sandbox.spec) &&
      row.identity_json !== null &&
      row.quiesced_identity_json === row.identity_json;
    if (
      sandbox &&
      pods.length > 0 &&
      !sandbox.metadata.deletionTimestamp &&
      row.identity_json !== null &&
      !stopping
    ) {
      const access = yield* identify(row, sandbox, pods);
      if (!access) return yield* result(row, placement, "unavailable");
      if (access.row.version !== row.version)
        return yield* result(access.row, placement, "failed", null, {
          code: "lifecycle_failed",
          message: "Worker changed before stop; retry lifecycle admission.",
          retryable: false,
        });
      row = access.row;
      if (row.quiesced_identity_json !== row.identity_json) {
        const quiesced = yield* workerTransition(
          row,
          access.endpoint,
          access.identity,
          "quiesce",
        ).pipe(
          Effect.as(true),
          Effect.catchTags({
            SandboxLifecycleError: (error) =>
              error.httpStatus === 409 ? Effect.succeed(false) : Effect.fail(error),
          }),
        );
        if (!quiesced)
          return yield* result(row, placement, "failed", null, {
            code: "worker_busy",
            message: "Worker still has active operations.",
            retryable: true,
          });
        yield* sql`UPDATE t3_sandbox_lifecycle SET quiesced_identity_json=${row.identity_json} WHERE workspace_id=${row.workspace_id} AND version=${row.version}`;
        row = { ...row, quiesced_identity_json: row.identity_json };
      }
    }
    yield* freshVersion(row, placement);
    if (row.desired_state === "suspended") {
      if (!sandbox) return yield* result(row, placement, "suspended");
      if (sandbox.metadata.deletionTimestamp) return yield* result(row, placement, "suspending");
      if (!requestedMatches({ operatingMode: "Suspended" }, sandbox.spec))
        sandbox = yield* patchMode(row, placement, sandbox, "Suspended");
      const generation = sandbox.metadata.generation;
      const confirmed =
        pods.length === 0 &&
        sandbox.status?.conditions?.some(
          (condition) =>
            condition.type === "Suspended" &&
            condition.status === "True" &&
            condition.observedGeneration === generation,
        );
      return yield* result(row, placement, confirmed ? "suspended" : "suspending");
    }
    if (sandbox) {
      if (!sandbox.metadata.deletionTimestamp)
        yield* remove(`${paths.sandboxes}/${resourceNames.sandbox}`, sandbox);
      return yield* result(row, placement, "releasing");
    }
    if (pods.length > 0) return yield* result(row, placement, "releasing");
    const secret = yield* get(`${paths.secrets}/${resourceNames.secret}`);
    if (secret) {
      yield* owned(secret, row, resourceNames.secret);
      yield* remove(`${paths.secrets}/${resourceNames.secret}`, secret);
    }
    return yield* result(row, placement, "released");
  });
  const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => {
        if (isLifecycleError(cause)) return cause;
        return new SandboxLifecycleError({
          operation,
          ...(isKubernetesError(cause) && cause.httpStatus !== undefined
            ? { httpStatus: cause.httpStatus }
            : {}),
          cause,
        });
      }),
    );
  const ensure: SandboxLifecycle["Service"]["ensure"] = (workspaceId, placement) =>
    locked(
      workspaceId,
      wrap(
        "ensure",
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT workspace_id FROM t3_sandbox_lifecycle WHERE workspace_id=${workspaceId}`;
          const legacy =
            yield* sql`SELECT workspace_id FROM t3_sandbox_legacy_workspaces WHERE workspace_id=${workspaceId}`;
          let restoredPvcUid: string | null = null;
          if (existing.length === 0 && legacy.length > 0) {
            const pvcName = `t3-ws-${digest(workspaceId).slice(0, 32)}`;
            const pvc = yield* get(`${Kubernetes.paths(placement.namespace).pvcs}/${pvcName}`);
            const expectedStorage = {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: placement.storage.size } },
              ...(placement.storage.storageClassName
                ? { storageClassName: placement.storage.storageClassName }
                : {}),
            };
            if (
              !pvc ||
              pvc.metadata.deletionTimestamp ||
              pvc.metadata.name !== pvcName ||
              pvc.metadata.labels?.["app.kubernetes.io/managed-by"] !== "t3-code" ||
              pvc.metadata.annotations?.["t3.codes/workspace"] !== workspaceId ||
              (pvc.metadata.ownerReferences?.length ?? 0) !== 0 ||
              !requestedMatches(expectedStorage, pvc.spec)
            )
              return yield* new SandboxLifecycleError({
                operation: "cutover",
                cause: {
                  code: "workspace_cutover_required",
                  message:
                    "Restore the existing workspace into its retained native PVC before starting native execution.",
                  retryable: false,
                },
              });
            restoredPvcUid = pvc.metadata.uid;
          }
          yield* sql`INSERT INTO t3_sandbox_lifecycle(workspace_id, placement_json, desired_state, allocation_id, token, pvc_uid)
      VALUES (${workspaceId}, ${yield* encodePlacement(placement)}, 'running', ${NodeCrypto.randomUUID()}, ${NodeCrypto.randomBytes(32).toString("hex")}, ${restoredPvcUid}) ON CONFLICT(workspace_id) DO NOTHING`;
          const current = yield* read(workspaceId, placement);
          return yield* reconcile(
            current.row,
            current.placement,
            current.row.desired_state === "running",
          );
        }),
      ),
    );
  const observe: SandboxLifecycle["Service"]["observe"] = (workspaceId, placement) =>
    locked(
      workspaceId,
      wrap(
        "observe",
        Effect.gen(function* () {
          const current = yield* read(workspaceId, placement);
          return yield* reconcile(current.row, current.placement, false);
        }),
      ),
    );
  const setDesiredState: SandboxLifecycle["Service"]["setDesiredState"] = (
    workspaceId,
    placement,
    state,
    expectedVersion,
  ) =>
    locked(
      workspaceId,
      wrap(
        "set-state",
        Effect.gen(function* () {
          const current = yield* read(workspaceId, placement);
          let row = current.row;
          if (String(row.version) !== expectedVersion)
            return yield* new SandboxLifecycleError({
              operation: "set-state",
              httpStatus: 412,
              cause: "Lifecycle version changed",
            });
          if (row.desired_state !== state) {
            // A released allocation must be gone before a new allocation can use its retained PVC.
            if (row.desired_state === "released" && state === "running") {
              const stopped = yield* reconcile(row, current.placement, false);
              if (stopped.state !== "released")
                return yield* new SandboxLifecycleError({
                  operation: "set-state",
                  httpStatus: 503,
                  cause: "Previous allocation is still releasing",
                });
              row = {
                ...row,
                allocation_id: NodeCrypto.randomUUID(),
                generation: row.generation + 1,
                token: NodeCrypto.randomBytes(32).toString("hex"),
                sandbox_uid: null,
                identity_json: null,
              };
            }
            row = {
              ...row,
              desired_state: state,
              version: row.version + 1,
              quiesced_identity_json: null,
            };
            yield* sql`UPDATE t3_sandbox_lifecycle SET desired_state=${state}, version=${row.version}, allocation_id=${row.allocation_id}, generation=${row.generation}, token=${row.token}, sandbox_uid=${row.sandbox_uid}, identity_json=${row.identity_json}, quiesced_identity_json=NULL WHERE workspace_id=${workspaceId} AND version=${Number(expectedVersion)}`;
          }
          return yield* reconcile(row, current.placement, state === "running");
        }),
      ),
    );
  return SandboxLifecycle.of({ ensure, observe, setDesiredState });
});

export const layer = Layer.effect(SandboxLifecycle, make);
