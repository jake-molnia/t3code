# Worker harness configuration

Set `T3_HARNESS_DEFAULTS_FILE=/opt/t3/harness-configs/defaults.json`, `APERTURE_UPSTREAM` to the authorized pool proxy origin, and `APERTURE_API_KEY` to its SDK credential. The existing pool proxy uses `-` as the nonsecret SDK key because network identity authorizes upstream access. Never bake real credentials into this image.

The worker applies this manifest to native T3 provider factories after receiving each provider instance. Operator entries override matching configuration and environment fields; unrelated instance settings remain available. `${NAME}` values resolve from worker environment. Expanded defaults are not written into central or worker settings files. The manifest's driver keys are T3 driver IDs, including `claudeAgent`.

Codex uses its existing/API-key mode and Responses endpoint. Seed the central instance with `setupMode: existing` too, so T3 does not initiate managed ChatGPT credential sharing. Claude uses the Anthropic-compatible endpoint. Grok uses its native XAI API/model endpoint variables. OpenCode uses the pinned `opencode2` executable with native `providers`/`settings` configuration. On startup the worker reads Aperture's model catalog and publishes retained OpenCode and Pi configuration for Responses, Chat Completions, and Anthropic Messages separately. Their native provider names are `aperture`, `aperture-chat`, and `aperture-anthropic`. Codex, Claude, and Grok snapshots omit models whose advertised endpoints cannot be used by that harness. Model IDs and available context limits come from the catalog. Routes flagged `requires_client_auth` are excluded because this deployment supplies managed Aperture credentials rather than personal provider accounts. With the current catalog this leaves Claude unavailable until Aperture has a managed Anthropic Messages route. An unavailable or malformed catalog prevents worker startup instead of silently sending requests to a public provider.

Aperture MCP is added alongside the session-scoped `t3-code` MCP using each adapter's existing launch interface. ACP providers receive the existing stdio-to-HTTP bridge; Pi uses native MCP registration. No second provider launcher is installed.

Cursor and Muse require proprietary provider authentication and reject configuration in Aperture mode. An Aperture key is not a Cursor SDK or Muse account credential. They remain installed for upstream compatibility, but this deployment must leave their instances disabled.

All worker provider calls enforce full access while preserving plan versus normal interaction mode. Kubernetes remains the execution boundary.

`settings.seed.json` is a minimal central settings seed validated against T3's ServerSettings schema. Apply it only when the central settings file does not exist. It selects Codex with `gpt-6-luna` and disables providers requiring native account credentials.
