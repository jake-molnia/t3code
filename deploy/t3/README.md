# Deploy T3 with native sandboxes

T3's central server talks directly to Kubernetes Agent Sandbox. The worker image starts its own
provider, desktop, browser, and IDE services. No separate agent-runtime service or Hatchet is needed.

## Prepare the cluster

Use a cluster with the `agents.x-k8s.io/v1beta1` Sandbox CRD and controller installed. The lifecycle
implementation uses `operatingMode: Running` and `Suspended`. Verify that your controller supports
those modes. Provide a storage class with retained persistent volumes and enough capacity for one
volume per root workspace. Delegated children share their root's volume.

Build and publish the [web and worker images](../../images/t3/README.md). Record both immutable image
digests. The image workflow runs boot checks before publication.

Render the resources for your cluster:

```sh
node deploy/t3/render.mjs \
  --namespace t3 \
  --storage-class YOUR_STORAGE_CLASS \
  --web-image ghcr.io/jake-molnia/t3code-web@sha256:YOUR_WEB_DIGEST \
  --worker-image ghcr.io/jake-molnia/t3code-sandbox@sha256:YOUR_WORKER_DIGEST \
  > /tmp/t3-native.json
```

Review the output before applying it. The default requests are one CPU and 2 GiB per worker, with
limits of four CPUs and 8 GiB. Adjust the pool configuration to suit your cluster. Keep image digests
pinned. Preserve pool and profile identifiers when migrating existing workspaces.

Create the namespace and the shared model-gateway credential without printing the key:

```sh
kubectl create namespace t3
umask 077
openssl rand -hex 32 > /tmp/t3-gateway-key
kubectl -n t3 create secret generic t3-model-gateway \
  --from-file=T3_GATEWAY_API_KEY=/tmp/t3-gateway-key
rm /tmp/t3-gateway-key
kubectl apply -f /tmp/t3-native.json
kubectl -n t3 rollout status deployment/t3
```

For an existing installation, reuse its persisted gateway key. A different key prevents central
startup. Complete the cutover below before starting a central server against an existing database.

The central service account has namespace-scoped Sandbox, PVC, Secret, and Pod permissions. Workers
do not mount a Kubernetes service-account token. The central database uses its own PVC; workers mount
only their workspace PVC. Keep one central replica with the generated Recreate rollout strategy.

Expose service `t3` through your existing ingress or tunnel. Preserve same-origin WebSocket routing.
Use T3's normal pairing and provider-account flows. `T3_MCP_ADVERTISED_URL` points to the internal
central service so workers can reach it; it is not the public browser URL.

## Configure native pools

`T3_EXECUTION_POOLS_FILE` points to the JSON configuration rendered in the `t3-pools` ConfigMap.
Each pool selects a namespace, immutable worker image, resource requests and limits, storage, and
optional worker environment Secret and ConfigMap. `providerDrivers: []` permits all configured
providers. Use the existing provider settings to disable providers without supported credentials.

The central server uses its mounted service-account token and CA. For an isolated development
cluster, override `T3_KUBERNETES_URL`, `T3_KUBERNETES_TOKEN_FILE`, and `T3_KUBERNETES_CA_FILE`.
Tokens are read on each request to support rotation. T3 does not invoke local `kubectl` or use the
central filesystem as an execution fallback. With no pools configured, the server starts but
workspace execution is unavailable. `AGENT_RUNTIME_URL` and `AGENT_RUNTIME_TOKEN` are no longer used.

Pool availability checks do not start workers. Capacity estimates remain unknown until a native
scheduler-capacity implementation is available.

## Move an existing installation

This procedure requires CSI VolumeSnapshot support. Keep source volumes and the old deployment
configuration until you have verified the restored installation. The renderer never changes your
source database or cluster.

1. Stop new work, finish any pending legacy profile migrations, and release all workspace compute
   through the old lifecycle service. Wait for workers and their Pods to exit. Stop the old central
   server and lifecycle controllers so they cannot write to the workspace volumes.
2. Back up the stopped central T3 home, including `statev2.sqlite`, settings, secrets, and gateway
   state. Restore that backup under `t3/` in the new central state volume, mounted at `/data/t3`. Do not copy conversation SQLite
   into a workspace volume.
3. Create one CSI VolumeSnapshot for each retained legacy workspace PVC. Wait until each snapshot
   reports `readyToUse: true`. Export those snapshots as a Kubernetes JSON List. Use the same
   namespaces in the native pool configuration. Keep each workspace's pool and profile identifiers.
4. Render native workspace claims from the stopped database copy, your native pools JSON, and the
   ready snapshot export:

   ```sh
   python3 deploy/t3/prepare-cutover.py \
     --database /path/to/backup/userdata/statev2.sqlite \
     --pools /path/to/native-pools.json \
     --snapshots /path/to/workspace-snapshots.json \
     > /tmp/t3-restored-workspaces.json
   ```

   The command fails if any bound workspace lacks a snapshot or the configured storage is too
   small. Resolve those cases explicitly; do not bypass the check by clearing bindings or changing
   admission flags. Never replace an existing workspace with an empty claim.

5. Review and apply the restored claims, then deploy native T3 against the restored central state.
   Storage classes using delayed binding may bind claims when their first worker is scheduled.
   T3 checks claim ownership and storage configuration before it admits an old workspace.
6. Verify two root threads with identical repository paths remain independent, a delegated child
   shares its root's files, a central restart reconnects to a surviving worker, and a replaced worker
   keeps files while rejecting stale execution identities. Check browser, terminal, and IDE access.

The first native startup records old workspace bindings as requiring restored claims. An old thread
without a valid restored claim fails closed. New threads provision normally. Rollback after accepting
new writes requires a deliberate data reconciliation; do not point both deployments at the same data.

## Verify changes locally

```sh
node --test deploy/t3/render.test.mjs images/t3/session.test.mjs
python3 -m unittest discover -s deploy/t3 -p 'test_*.py'
pnpm exec vp test run apps/server/src/sandbox apps/server/src/agentRuntime/Bindings.test.ts \
  apps/server/src/agentRuntime/RuntimeClientReadiness.test.ts \
  apps/server/src/agentRuntime/LifecycleSubmission.test.ts \
  apps/server/src/execution/RemoteRecovery.integration.test.ts
```

To check the built central entrypoint without a browser or a cluster, run:

```sh
pnpm --filter t3 build:bundle
node deploy/t3/smoke-central.mjs
```

This starts and stops only its own child server, uses temporary state, and verifies native lifecycle
persistence across a restart with no execution pools configured.

Run the image build and `images/t3/smoke-image.py` checks on a Docker-capable host before deployment.
A test against a simulated Kubernetes API does not establish that the cluster's controller or storage
class supports the required lifecycle behavior.
