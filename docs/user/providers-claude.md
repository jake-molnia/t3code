# Claude

Claude Code runs in the deployment's execution workspace. Connect model accounts
in **Settings → Providers → Accounts**, then choose Claude and an available model
in the composer.

## Connect an account

Choose **Claude** in **Accounts** and complete the browser sign-in. Paste the
final redirect URL into T3 if prompted, even if the localhost page cannot load.
Connect additional accounts through the same flow. You do not need separate
Claude configuration directories.

To use an OpenAI-compatible model service, add an **API endpoint** in **Accounts**.
The gateway translates requests for compatible models. See
[account and harness setup](./install.md#connect-a-provider-account).

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. T3 offers
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter and other model services

In **Settings → Providers → Accounts**, add an **API endpoint** with your service's
OpenAI-compatible base URL, API key, and full model IDs. For OpenRouter, use
`https://openrouter.ai/api/v1`. Select Claude and the connected model in the
composer. Models may offer different thinking or context controls.
