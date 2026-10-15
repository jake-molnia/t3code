# OpenCode

The deployment supplies OpenCode 2 and runs it in your execution workspace.
Connect accounts or API endpoints in **Settings → Providers → Accounts**, then
choose OpenCode and an available model in the composer. See
[account and harness setup](./install.md#connect-a-provider-account).

OpenCode versions come from the sandbox image. Ask your deployment administrator
to upgrade the image when you need a newer version, then refresh provider status
after the replacement worker is available.

T3 manages the OpenCode server and its model configuration. You do not need a
local installation, a separate login, or an external OpenCode server.
Plan mode uses OpenCode's `plan` agent.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Account and model changes

Connecting, disabling, or removing an account refreshes the available models.
Existing threads keep their selected model. If that model is no longer available,
select another model and retry.
