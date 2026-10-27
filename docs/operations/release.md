# Release deployment images

The fork builds its web and execution images from `main` with `.github/workflows/sandbox-images.yml`.
Both images are built from pinned base images in `images/t3/Dockerfile`. This repository owns worker
startup, provider harnesses, and native Kubernetes sandbox lifecycle.

The workflow verifies each image before publishing `ghcr.io/jake-molnia/t3code-web` and
`ghcr.io/jake-molnia/t3code-sandbox`. Its artifacts record the source revision and immutable image digest.

Render deployment resources with [`deploy/t3/render.mjs`](../../deploy/t3/render.mjs), following the
[deployment guide](../../deploy/t3/README.md). Review rendered changes in the deployment configuration
repository before rollout. Keep central SQLite and workspace PVCs. Run one central replica with a
Recreate rollout so lifecycle transitions have one writer.

Changes to the worker protocol require compatible central and worker images. Native workspace
placements retain the image selected at first registration. Changing a pool image applies to new
workspaces; do not edit persisted placements to force an upgrade while compute is active.

For the first native rollout, stop the old central server and release its workers through the old
lifecycle service. Follow the [retained-workspace cutover](../../deploy/t3/README.md#move-an-existing-installation)
before enabling native execution. Keep the old volumes and central backup until the new installation
has passed the isolation and recovery checks. The old profile migration script is only for completing
legacy migrations before cutover; native execution does not call it.
