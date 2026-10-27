# Project settings

Choose a project at the top of Settings to change its behavior, or choose **All projects** to edit the existing projects together. The selection follows you between project settings pages. App preferences and shared accounts do not need a project selector.

Project settings use saved defaults until you change them. Existing values are preserved when upgrading. Reset restores the saved default or repository value. A change to one project does not change another project. **All projects** writes the selected value to each current project; it does not change defaults for future projects. Controls show **Mixed** when the projects disagree.

Harness switches in **Settings → Providers** control whether the selected projects can start new turns with each harness. Turning a harness on needs no separate global switch. Authentication and compatibility checks still apply. Turning it off blocks new turns, including queued and delegated work; a running turn finishes. Accounts, credentials, custom models, and model preferences remain shared.

## MCP connections

Open **Settings → MCP → Add connection**, enter the server URL, and sign in or supply
an access token. Choose **No authentication** for an open server. Services without
automatic OAuth registration need their own client ID and, when required, client secret.

Choose a project or **All projects** at the top of Settings, then set each connection's **Project access**.
The selection stays with you across settings pages and sign-in. New connections start disabled
for every project. **Selected tools only** grants access to the tools you select and keeps newly
added tools disabled. Selecting no tools grants no access. **All tools** includes new tools.
Connections and credentials are stored centrally, so enabling another project does not require
another sign-in. Reconnect renews authentication while retaining project access.

Agents discover tools as needed instead of loading the entire catalog into a conversation.
Access changes apply to the next tool search, schema lookup, or call in both new and existing
agent sessions. Disable a connection to remove this project's access. Calls already running can
finish. Disconnect removes the connection from every project. Completed external actions are
not undone. Integration execution requires a live thread in Full access and default
interaction mode; tool discovery is also available while planning.

## Worktree branch names

In **Settings → Source Control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to set its branch naming policy. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks

Open **Settings → Scheduled tasks** to create recurring tasks or manage existing
ones for the selected project. Each task uses its project, model, and workspace
settings. Fixed-time schedules use the server's time zone, which may differ from
your browser's.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. After you save the task, copy its URL from the editor. The sender must be able to reach your deployment's HTTPS address.
**Rotate** replaces the URL and the old one stops working.

For agents to return the same public URL, the deployment administrator must set
`T3CODE_PUBLIC_URL` on the central service, for example `https://t3.example.com`.
Restart the service after changing it. If your reverse proxy mounts the service
under a path, include that prefix, such as `https://example.com/t3/`, and configure
the proxy to strip it before forwarding `/api/hooks/...` to the service.
Use an HTTP(S) URL without credentials, a query string, or a fragment.
This setting advertises an address; it does not configure DNS, TLS, or the proxy.
Without it, the browser resolves the URL from its connection, and agents omit it.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To skip requests that waited too long before redelivery, set **Skip requests older than** on the task.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → General** (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Storage → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after merging, or when they
have no commits beyond the default branch. Only T3-managed worktrees are eligible. Active
sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
