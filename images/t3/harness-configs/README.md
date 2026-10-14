# Worker provider configuration

Providers use their native configuration, credentials, model discovery, and session protocols in
execution workers. Configure an instance in **Settings > Providers**. Its environment variables
and settings travel to the worker; binaries come from the pinned worker image.

Aperture is usable through each provider's supported endpoint configuration. For Codex, use its
native `config.toml` provider entry and credential source, or the instance's launch arguments and
environment variables. T3 does not fetch an Aperture catalog at worker startup, generate provider
configuration, or remove models from native snapshots. A gateway outage must not prevent other
providers or workspace operations from starting.

Cursor uses its native browser sign-in in Settings. Its saved credential is transferred from the
auth utility worker to execution workers. Claude, Grok, OpenCode, Pi, and Muse retain their upstream
CLI-owned sign-in paths and instance environment variables. Run CLI sign-in in the destination
sandbox's terminal with the same config directory used by that instance. A login in one root's
sandbox does not sign in another root; API credentials supplied in instance settings travel with
the instance. Muse supports `muse login` or an explicit `META_API_KEY`; Claude supports
`claude auth login`, `CLAUDE_CODE_OAUTH_TOKEN`, or its documented API credentials. Do not sign in
on the central server and expect its local files to reach a worker.

An optional `T3_HARNESS_DEFAULTS_FILE` can supply deployment-owned defaults keyed by driver ID.
Its `config` object and `environment` array have the same shapes as provider instance settings.
`${NAME}` references resolve from the worker environment. Explicit instance values, including an
empty environment value, take precedence. Expanded defaults are not saved to central settings.
There is no required defaults file or gateway-specific setup mode.

When upgrading a deployment that used the removed bundled defaults and settings seed, provision
its existing native provider configuration in the worker home or instance settings first. Remove
the old `T3_HARNESS_DEFAULTS_FILE=/opt/t3/harness-configs/defaults.json` reference, or point it to a
file managed by the deployment. Existing Pi and OpenCode configuration files on retained storage
can be used through `PI_CODING_AGENT_DIR` and `OPENCODE_CONFIG`. For the OpenCode 2 runtime supplied
by the base image, retain `binaryPath: opencode2` on the instance. Deployment manifests and secrets
belong in the config repository, not this image.

The optional Aperture MCP endpoint remains independent of model routing. `APERTURE_UPSTREAM` and
`APERTURE_API_KEY` add it beside the session-scoped `t3-code` MCP server. They do not select model
providers or disable native accounts.

Worker provider calls run with full access while preserving plan versus normal interaction mode.
Kubernetes remains the execution boundary. Conversation SQLite remains in the central service.
