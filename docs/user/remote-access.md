# Access T3 Code from another browser

Open your deployment's HTTPS address on the device you want to use. The same central service keeps your projects and conversations available across authorized browsers.

## Authorize a browser

Ask your deployment administrator for a pairing link if the application requires authorization. Use a fresh one-time link for each browser. Once paired, the browser can reconnect without the original link.

Pairing URLs and authorization codes grant access to your deployment. Keep them out of screenshots, logs, and bug reports.

Authorized administrators can manage pairing links and client sessions in **Settings → Connections**. Revoking an unused link prevents new pairings. Revoke an existing client session to remove that browser's access.

## Use browser previews

Preview tabs run with the conversation's workspace. You and the agent can view the same tab from the web application, and `localhost` in a preview reaches services in that workspace.

Take control before interacting with an agent's tab. Release control when the agent can continue. Read-only connections can watch without changing the page.

If a preview fails to start, contact the deployment administrator. The execution image supplies Chromium and its libraries. Installing a browser on your device does not change the preview runtime.

## Connect an outside agent

To connect Claude Code, Codex, ChatGPT, or another external client to the deployment's MCP server, follow [outside agents](./outside-agents.md).

## Troubleshoot access

If the application cannot connect, check that you are using the deployment's current address and required network connection. Ask your administrator to check service health and proxy support for WebSocket connections.

If authorization has expired or been revoked, request a new pairing link. Reconnecting does not change an existing session's permissions.

For version mismatch messages after maintenance, follow [updates](./updating.md). Deployment administrators can find network and service configuration in the [native sandbox deployment guide](../../deploy/t3/README.md).
