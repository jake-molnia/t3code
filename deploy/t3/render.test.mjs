import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { render } from "./render.mjs";

const options = {
  webImage: `example/web@sha256:${"1".repeat(64)}`,
  workerImage: `example/worker@sha256:${"2".repeat(64)}`,
  storageClass: "retained-rwo",
  namespace: "sandbox-test",
};
NodeTest.test(
  "deployment connects central storage, worker configuration and namespace-scoped permissions",
  () => {
    const resources = render(options).items;
    const deployment = resources.find((value) => value.kind === "Deployment");
    NodeAssert.equal(deployment.spec.replicas, 1);
    NodeAssert.equal(deployment.spec.strategy.type, "Recreate");
    const pod = deployment.spec.template.spec;
    NodeAssert.equal(pod.serviceAccountName, "t3-central");
    NodeAssert.equal(
      pod.containers[0].env.find((value) => value.name === "T3_MCP_ADVERTISED_URL").value,
      "http://t3.sandbox-test.svc:3773/mcp",
    );
    NodeAssert.equal(
      pod.volumes.find((value) => value.name === "state").persistentVolumeClaim.claimName,
      "t3-state",
    );
    const pools = JSON.parse(
      resources.find((value) => value.kind === "ConfigMap" && value.metadata.name === "t3-pools")
        .data["pools.json"],
    );
    const pool = pools.pools[0];
    NodeAssert.equal(pool.id, pools.defaultPoolId);
    NodeAssert.equal(pool.namespace, options.namespace);
    NodeAssert.equal(pool.image, options.workerImage);
    NodeAssert.equal(
      resources.find(
        (value) => value.kind === "ConfigMap" && value.metadata.name === pool.workerEnvConfigMap,
      ).data.T3_GATEWAY_URL,
      "http://t3.sandbox-test.svc:3773/api/model-gateway",
    );
    NodeAssert.equal(
      resources.find(
        (value) =>
          value.kind === "ServiceAccount" && value.metadata.name === pool.serviceAccountName,
      ).automountServiceAccountToken,
      false,
    );
    const rules = resources.find((value) => value.kind === "Role").rules;
    NodeAssert.equal(
      rules
        .find((value) => value.resources.includes("persistentvolumeclaims"))
        .verbs.includes("delete"),
      false,
    );
    NodeAssert.ok(
      resources.every(
        (value) => value.kind === "Namespace" || value.metadata.namespace === options.namespace,
      ),
    );
  },
);
NodeTest.test(
  "requires immutable images and explicit storage instead of guessing cluster defaults",
  () => {
    NodeAssert.throws(() => render({ ...options, workerImage: "example/worker:latest" }));
    NodeAssert.throws(() => render({ ...options, storageClass: undefined }));
    NodeAssert.throws(() => render({ ...options, namespace: "../default" }));
    NodeAssert.throws(() => render({ ...options, workspaceSize: "0Gi" }));
  },
);
