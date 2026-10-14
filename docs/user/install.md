# Open T3 Code

Open the web address provided by your deployment administrator. Use the pairing link they provide if the application asks you to authorize your browser. Each browser needs its own authorization.

## Connect a provider account

Open **Settings → Providers → Accounts** and connect an account. T3 chooses the
sign-in flow for that service. When a device code appears, open the sign-in page
and enter the code. If the service requires a browser callback, paste the final
redirect URL into T3, even if the localhost page cannot load.

To use an OpenAI-compatible service, choose **API endpoint** and enter its base
URL, API key, and model names. Connected accounts and endpoints supply models to
compatible harnesses. You can disable an account temporarily, enable it again,
or remove it from **Accounts**.

Use **Harnesses** on the same page to choose which coding agents are available.
The harness runs your tools and conversation. The connected account supplies the
model. Available combinations depend on the harness and model protocols.

Your deployment supplies the provider executables. If a provider is unavailable or incompatible, contact the deployment administrator. Installing a CLI on your own computer does not change the deployment.

For account setup, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), or [ACP providers](./providers-acp.md).

## Start a conversation

Choose a project and start a thread. Select a harness and model in the composer. T3 Code prepares its workspace automatically.

Open the same web address from another device to continue your saved conversations. See [browser access and pairing](./remote-access.md) if you cannot connect.

## Set up a deployment

If you administer the application, follow the [T3 image build guide](../../images/t3/README.md) and [deployment guide](https://github.com/jake-molnia/agent-runtime/blob/t3/sandbox-session-lifecycle/deploy/t3/README.md). They cover the central service, persistent storage, execution images, and runtime credentials.
