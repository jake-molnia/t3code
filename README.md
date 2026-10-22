# T3 Code sandbox fork

This fork runs the T3 Code web client and one central server, with conversation state in SQLite on persistent storage. Provider processes, repository operations, terminals, and browser previews run in Kubernetes Agent Sandbox. T3 manages execution lifecycle directly through the Kubernetes API.

New top-level threads receive independent workspaces. Delegated subagents share their parent's workspace while keeping separate conversations. Allocation and recovery happen behind the normal thread controls.

Provider executables and versions belong to the execution image. **Settings → Providers** retains account authentication and model selection. This fork ships the web application; desktop and native mobile applications are removed.

## Deploy

Build the web and worker images using the [image build guide](./images/t3/README.md), then follow the
[native sandbox deployment guide](./deploy/t3/README.md). The deployment requires a Kubernetes cluster
with the Agent Sandbox controller. It does not require a separate runtime service or Hatchet.

Run one central server replica with SQLite on its own persistent volume. Each root workspace uses a
separate retained volume; delegated children share their parent's workspace.

For source changes, install the repository's pinned dependencies with `pnpm install --frozen-lockfile`. See [development](./docs/operations/development.md) and [releasing deployment images](./docs/operations/release.md) for the build workflow.

## Use T3 Code

- [Open the application and start a conversation](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Browser access and pairing](./docs/user/remote-access.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [Updates](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Provider accounts: [Codex](./docs/user/providers-codex.md), [Claude](./docs/user/providers-claude.md)

This fork is based on [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Read [CONTRIBUTING.md](./CONTRIBUTING.md) before contributing.
