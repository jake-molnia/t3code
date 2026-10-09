# Open T3 Code

Open the web address provided by your deployment administrator. Use the pairing link they provide if the application asks you to authorize your browser. Each browser needs its own authorization.

## Connect a provider account

Open **Settings → Providers**, choose a provider account, and complete its available sign-in flow. Wait for account verification and model discovery before starting a thread.

Your deployment supplies the provider executables. If a provider is unavailable or incompatible, contact the deployment administrator. Installing a CLI on your own computer does not change the deployment.

For account setup, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), or [ACP providers](./providers-acp.md).

## Start a conversation

Choose a project and start a thread. Select the provider account and model in the composer. T3 Code prepares its workspace automatically.

Open the same web address from another device to continue your saved conversations. See [browser access and pairing](./remote-access.md) if you cannot connect.

## Set up a deployment

If you administer the application, follow the agent-runtime [image build guide](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/images/t3/README.md) and [deployment guide](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/deploy/t3/README.md). They cover the central service, persistent storage, execution images, and runtime credentials.
