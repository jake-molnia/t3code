# Managed model gateway

The image supplies `T3_GATEWAY_HARNESS_CONFIG_FILE=/opt/t3/gateway-harnesses.json`. Set `T3_GATEWAY_URL` to the worker-reachable T3 inference prefix, such as `http://head:3773/api/model-gateway`, and `T3_GATEWAY_API_KEY` to the deployment inference key. The URL does not include `/v1`. Management credentials remain on the head server. Never bake credentials into the image.

Gateway mode creates missing supported harness settings automatically, preserving existing instance IDs and explicit enablement. Account enrollment lives in T3 Settings and works before any worker starts.

Codex uses its existing/API-key setup mode with the Responses endpoint. Claude uses Anthropic Messages, and Grok uses Chat Completions. OpenCode uses the pinned `opencode2` executable. OpenCode and Pi use the `gateway` provider group over Responses. CLIProxyAPI translates these protocols to the connected upstream accounts.

Workers refresh the catalog before configuring providers, reading model snapshots, opening sessions, and starting turns. Catalog IDs appear in every supported harness even when absent from its bundled model list. The proxy's model list does not include context limits or reasoning capabilities, so T3 preserves matching native metadata and leaves unknown capabilities unspecified. An empty catalog is valid setup state. An unreachable gateway blocks inference without falling back to public endpoints.

The existing session-scoped `t3-code` MCP remains independent of model routing. No model gateway MCP server is injected.

Cursor, Muse, and Antigravity do not support this deployment's gateway credentials. Keep those harnesses disabled. Their upstream adapters remain available for installations using native authentication.

OpenCode 2 watches its configuration file and refreshes model definitions in place. Pi loads its model registry at process startup, so selecting a different model starts a fresh provider session through the existing session transition path. Neither operation replaces the execution worker or interrupts other running sessions. Saved selections from the retired gateway are translated at execution; historical events retain their original model IDs.

The shipped worker requires the gateway address and key. Missing model-access configuration stops startup; it does not expose a second account setup. Harness binary paths, home directories, compaction settings, and extra launch arguments remain execution settings. Gateway routing supplies the endpoint and credentials, appends its Codex routing flags after execution arguments, and excludes native Claude account tokens. Conversation SQLite stays on the head server.
