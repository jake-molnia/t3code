# Release deployment images

The fork builds its web and execution images from `main` with `.github/workflows/sandbox-images.yml`. The execution image extends the pinned generic agent-runtime sandbox image in `images/t3/Dockerfile`. Application source, harness configuration, credential helpers, and state migrations are built in this repository.

The workflow verifies each image before publishing `ghcr.io/jake-molnia/t3code-web` and `ghcr.io/jake-molnia/t3code-sandbox`. Its artifacts record the source revision and immutable image digest.

Deployment manifests, pool profiles, secrets references, and rollout ordering belong to `jake-molnia/config`. Deploy through a reviewed config PR with passing checks, then verify Flux revisions, mounted pool profiles, migrations, and application behavior. Preserve existing workspace volumes and migration ledgers.

Changes to the worker protocol require compatible head and worker images. Publish and verify pool profiles before changing the head's selected profiles. A head-only change can retain the existing worker profile when its protocol and configuration remain compatible.
