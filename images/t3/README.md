# Build the T3 sandbox images

The fork owns its web and execution images. Build from the fork checkout; CI uses
the current main commit, frozen pnpm dependencies, and the pinned generic
agent-runtime sandbox base in `Dockerfile`. That base supplies the Go supervisor,
sandboxd, desktop tools, and shared skills. This directory adds T3, its provider
harnesses, credential helpers, and code-server.

## Build on GitHub Actions

The **Sandbox images** workflow builds `t3-web` and `t3-worker` for `linux/amd64`
on main changes or manual dispatch. It runs the existing image boot and protocol
checks before publishing `ghcr.io/jake-molnia/t3code-web` and
`ghcr.io/jake-molnia/t3code-sandbox`. Artifacts record the fork commit, runtime base,
image inspection, and immutable published digest. Deployment remains in the
config repository; the workflow does not apply Kubernetes resources.

## Build locally

```sh
docker buildx build --platform linux/amd64 \
  --file images/t3/Dockerfile --target t3-worker \
  --tag t3-worker:local --load .
python3 images/t3/smoke-image.py t3-worker t3-worker:local
```

Repeat for `t3-web`. The build checks the server types, creates a portable server
package with `pnpm deploy`, and builds the web client. Worker checks exercise the
real entrypoint, authenticated worker protocol, desktop services and IDE; web
checks exercise its bundled HTML and retained-state startup. These checks do not
replace live provider authentication and UI acceptance.

## Update a tool pin

1. Change the exact version in [providers.lock.json](providers.lock.json).
2. For npm harnesses, update the matching package manifest and regenerate that
   directory's `package-lock.json`.
3. For native downloads, verify the release source and record the downloaded
   artifact's SHA-256. Set the exact archive member for tar archives.
4. Build the worker target and inspect the version report and boot result.

The worker includes Codex, Claude Code, Grok, Pi, OpenCode, OpenCode 2, Muse, and
the Cursor SDK. OpenCode 2 comes from the pinned runtime image; T3 adds an
absolute `opencode2` alias and its session configuration. Generic ACP extensions
remain an explicit allowlist in the manifest. Source-control tools are `gh`,
`glab`, `tea`, `fj`, and Azure CLI with the Azure DevOps extension. Go and pnpm support work on these repositories.
Azure CLI uses Microsoft's checksum-pinned Debian package with its bundled
Python. The Azure DevOps wheel is pinned separately, and dynamic extension
installation is disabled.

The T3 worker also includes code-server `4.141.0`, AIO `0.9.2`, and the shared
desktop tools inherited from the pinned agent-runtime sandbox image. Code-server release
archives are checked against fixed SHA-256 hashes by `install-code-server.sh`.
The Go `t3-session` supervisor starts these services on loopback, then launches
the TypeScript execution worker with their addresses and desktop environment.
The real-entrypoint image smoke checks verify the IDE HTML, computer API, and
browser CDP endpoint before accepting the worker as ready. Jupyter is excluded.

## Check the Git credential helper

```sh
python3 images/t3/test_git_credential.py
```

This runs the helper through its stdin protocol and through native
`git credential fill` with a disposable home. It checks exact host and protocol
matching, non-mutating store/erase requests, malformed input, and token output.
Credentials come from the deployment profile, never from the image build.

## Deployment ownership

Kubernetes resources, pool profiles, secrets, and image pins live only in the
config repository. The controller uses the ordinary agent-runtime worker image
with its T3 controller command. There is no separate T3 controller image here.
The profile migration script is bundled in the web image because it migrates
T3's SQLite bindings; config retains its migration ledgers and controls when it runs.
