# Codex

Connect your ChatGPT account once and use its models with compatible coding
harnesses. Codex runs in the deployment's execution workspace.

## Connect with ChatGPT

Open **Settings → Providers → Accounts**, choose **ChatGPT**, and start sign-in.
Open the displayed sign-in page and enter the device code. Return to T3 after
authorizing the account. When sign-in completes, choose Codex and a model in the
composer.

For another account, repeat the connection flow in **Accounts**. T3 manages the
connected accounts centrally. You do not need a separate Codex home or a local
CLI login. Disable an account to stop using it temporarily, or remove it to
disconnect it. These actions preserve your conversation history.

See [account and harness setup](./install.md#connect-a-provider-account) to use
another model service with the Codex harness.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
