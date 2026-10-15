# Antigravity

T3 Code runs Google's official Antigravity agent in your thread's sandbox.
It has its own sign-in, separate from the Antigravity IDE or CLI. Google controls
which models and account access are available through this agent.

## Set up Antigravity

Open **Settings > Providers**, add an Antigravity instance, and enable it.
Choose **Sign in** and complete the Google sign-in. Wait for T3 Code to confirm
account access and load models before starting a thread. Add a separate provider
instance for each Google account.

The sandbox image supplies Antigravity and its native helper. If the provider
reports a missing or incompatible runtime, ask your administrator to update the
image. Provider settings do not install or update executables.

### Sign in from your browser

Google returns to a `127.0.0.1` address. The sign-in listener runs inside the
sandbox, so the final page usually cannot load in your browser.

Copy the full return address, including everything after `?`, into the return URL
field in the client where you started sign-in, then choose **Continue**. Keep the
original address; do not replace it with the server's hostname. Only that sign-in
session can finish the attempt. If it expires, retry with the new link.

The return URL contains a temporary sign-in code. Paste it only into the setup
field. Wait for T3 Code to confirm account access.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

- **Google account** uses personal Google sign-in in the browser.
- **Gemini Enterprise** uses browser sign-in, a GCP project, and a GCP location.
- **Gemini API key** uses the configured API key without a browser.
- **Agent Platform (Vertex AI)** uses an API key, or a GCP project and location
  with Application Default Credentials available inside the sandbox.

API keys are stored separately from settings and redacted in the client.
The agent uses the credentials selected for this instance. Changing the method
stops its running sessions. Sign out before replacing an account.

## Models and threads

The model list comes from your Antigravity account and can differ from other
Antigravity apps. A resumed thread keeps its selected model. If access to that
model ends, select another available model before continuing. Use **Refresh
provider status** in provider settings to check access and reload models.

Use Antigravity's native `/plan` command for planning. T3 Code's separate Plan mode
is unavailable. Questions with fixed choices still need one of the offered answers.

T3 Code keeps conversation history and file diffs, but Antigravity cannot rewind
its conversation. Reverting a thread or editing and resubmitting an earlier turn
is unavailable. Continue with a follow-up message or start a new thread.

### Skills and attachments

Put project skills in `.agents/skills`. Antigravity also reads `.gemini/skills`
and the legacy `.agent/skills` directory, in that order of precedence. Shared
skills belong in `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills`
inside the sandbox.

Antigravity receives images directly. Other attachments, including PDFs, text,
audio, archives, and videos, are saved in the sandbox and passed as file paths
for the agent to inspect. A video path does not enable native video input.

Antigravity groups its native subagent activity into batches. You cannot open
or control those individual subagents. An idle batch does not confirm that
every child succeeded.

## Accounts and troubleshooting

Disabling an instance stops its sessions and keeps its Google sign-in. Signing
out stops its sessions and removes the saved login. Both keep thread history
and workspace files. Sending `/logout` in a thread signs out its provider instance.

A central restart or sandbox process replacement keeps credentials and native
session data on retained storage. Separate top-level threads have separate
workspaces. Delegated child threads share their parent's workspace while keeping
their own provider sessions.

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT
allowances for personal Google sign-ins. If Google reports `SUBSCRIPTION_REQUIRED`,
an account restriction, or a usage limit, follow its message and any retry time.
See [Google's account plans](https://antigravity.google/docs/plans) for eligibility.
