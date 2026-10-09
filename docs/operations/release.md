# Release deployment images

Build this fork with the corresponding agent-runtime commit. The [T3 images workflow](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/.github/workflows/t3-images.yml) produces `t3-web`, `t3-worker`, and `t3-runtime` images for Linux amd64. It exports verification records and publishes commit-tagged images to GHCR after verification. Deployment remains owned by the config repository.

## Build a release

1. Commit and push the T3 source you intend to release.
2. Set `images/t3/source.lock.json` in agent-runtime to that full T3 commit SHA.
3. Commit the source pin with the matching agent-runtime changes.
4. Run the **T3 images** workflow on that agent-runtime commit.
5. Check all three build jobs and their image verification results.
6. Download the image archives, checksums, inspection output, and source records.
7. Publish the verified images to your registry and record their immutable digests.

For local builds and tool version changes, follow the [image build guide](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/images/t3/README.md). Provider executables and browser dependencies change through the worker image.

## Roll out a release

1. Follow the [deployment guide](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/deploy/t3/README.md) to prepare image references, profiles, credentials, and storage.
2. Schedule the rollout around active turns and terminal commands. Pause scheduled work during maintenance.
3. Take a consistent backup of the central T3 state directory before starting a version with database migrations.
4. Update the deployment's immutable image references through your normal deployment process.
5. Confirm runtime health and central web readiness.
6. Verify a provider turn, a repository operation, and workspace suspension and recovery in the target cluster.

Keep one central server replica with the `Recreate` strategy and its existing persistent volume. That volume holds SQLite, settings, credentials, attachments, and artifacts. Execution workspaces have separate retained volumes.

Existing workspaces record their execution profile identity. Changing a profile's image does not update those allocations in place. Verify the upgrade procedure for retained workspaces before replacing their profile configuration.

## Recover from a failed rollout

Preserve the central and workspace volumes while investigating a failed rollout. Check the central server, runtime, Hatchet, and Sandbox controller logs.

Before rolling back images, check whether the new version migrated persistent state. An older image may require restoration of the matching backup. Keep both source commits and image digests with each release so that you can reproduce the deployed versions.
