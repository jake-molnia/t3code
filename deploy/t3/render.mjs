#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const name = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const image = /^\S+@sha256:[a-f0-9]{64}$/;

export function render({
  namespace = "t3",
  webImage,
  workerImage,
  storageClass,
  workspaceSize = "20Gi",
  stateSize = "10Gi",
}) {
  if (!name.test(namespace) || namespace.length > 63)
    throw new Error("A Kubernetes namespace is required.");
  if (!image.test(webImage ?? "") || !image.test(workerImage ?? ""))
    throw new Error("Both images must be pinned by sha256 digest.");
  if (!storageClass || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(storageClass))
    throw new Error("An explicit storage class is required.");
  if (![workspaceSize, stateSize].every((value) => /^[1-9][0-9]*(?:Gi|Ti)$/.test(value)))
    throw new Error("Storage sizes must use positive Gi or Ti quantities.");
  const metadata = (resourceName) => ({ name: resourceName, namespace });
  const pool = {
    id: "default",
    label: "Sandbox",
    namespace,
    profile: "native-v1",
    image: workerImage,
    providerDrivers: [],
    resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "4", memory: "8Gi" } },
    storage: { size: workspaceSize, storageClassName: storageClass },
    workerEnvSecret: "t3-model-gateway",
    workerEnvConfigMap: "t3-worker-env",
    serviceAccountName: "t3-worker",
  };
  const items = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
    ...["t3-central", "t3-worker"].map((resourceName) => ({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: metadata(resourceName),
      automountServiceAccountToken: resourceName === "t3-central",
    })),
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: metadata("t3-sandboxes"),
      rules: [
        {
          apiGroups: ["agents.x-k8s.io"],
          resources: ["sandboxes"],
          verbs: ["get", "list", "create", "patch", "delete"],
        },
        { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "create"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "delete"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata("t3-sandboxes"),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "t3-sandboxes" },
      subjects: [{ kind: "ServiceAccount", name: "t3-central", namespace }],
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata("t3-state"),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: storageClass,
        resources: { requests: { storage: stateSize } },
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("t3-pools"),
      data: { "pools.json": JSON.stringify({ defaultPoolId: "default", pools: [pool] }, null, 2) },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("t3-worker-env"),
      data: { T3_GATEWAY_URL: `http://t3.${namespace}.svc:3773/api/model-gateway` },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata("t3"),
      spec: {
        selector: { app: "t3-central" },
        ports: [{ name: "http", port: 3773, targetPort: 3773 }],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: metadata("t3"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "t3-central" } },
        template: {
          metadata: { labels: { app: "t3-central" } },
          spec: {
            serviceAccountName: "t3-central",
            securityContext: { fsGroup: 1000 },
            terminationGracePeriodSeconds: 60,
            containers: [
              {
                name: "t3",
                image: webImage,
                ports: [{ name: "http", containerPort: 3773 }],
                env: [
                  { name: "T3_EXECUTION_POOLS_FILE", value: "/etc/t3/pools.json" },
                  { name: "T3_MCP_ADVERTISED_URL", value: `http://t3.${namespace}.svc:3773/mcp` },
                ],
                envFrom: [{ secretRef: { name: "t3-model-gateway" } }],
                volumeMounts: [
                  { name: "state", mountPath: "/data" },
                  { name: "pools", mountPath: "/etc/t3", readOnly: true },
                ],
                startupProbe: {
                  tcpSocket: { port: "http" },
                  periodSeconds: 5,
                  failureThreshold: 60,
                },
                readinessProbe: { tcpSocket: { port: "http" }, periodSeconds: 5 },
                resources: {
                  requests: { cpu: "500m", memory: "1Gi" },
                  limits: { cpu: "2", memory: "4Gi" },
                },
              },
            ],
            volumes: [
              { name: "state", persistentVolumeClaim: { claimName: "t3-state" } },
              { name: "pools", configMap: { name: "t3-pools" } },
            ],
          },
        },
      },
    },
  ];
  return { apiVersion: "v1", kind: "List", items };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = NodeUtil.parseArgs({
      options: Object.fromEntries(
        [
          "namespace",
          "web-image",
          "worker-image",
          "storage-class",
          "workspace-size",
          "state-size",
        ].map((key) => [key, { type: "string" }]),
      ),
    });
    const result = render({
      namespace: values.namespace,
      webImage: values["web-image"],
      workerImage: values["worker-image"],
      storageClass: values["storage-class"],
      workspaceSize: values["workspace-size"],
      stateSize: values["state-size"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error.message}\nUsage: node deploy/t3/render.mjs --web-image IMAGE@sha256:DIGEST --worker-image IMAGE@sha256:DIGEST --storage-class CLASS [--namespace t3]\n`,
    );
    process.exitCode = 1;
  }
}
