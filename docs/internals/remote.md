# Remote architecture

The browser connects to one central service over HTTP and WebSocket. That service owns conversation SQLite, projects, authentication, and orchestration. Execution pools own sandbox workspaces and provider processes. A pool is not another environment: moving execution does not copy conversation state.

The central service keeps its identity across restarts and address changes. Browser discovery rechecks the configured endpoint and uses its authenticated descriptor before replacing the active connection. An unavailable replacement must not send work to a previously selected endpoint. Saved machine catalogs are not connection sources in this fork.

Pairing links grant scoped access to the central service. Their credentials travel in URL fragments, are exchanged for a session, and are stripped from the browser address. Revocation and reconnection remain central authentication operations; sandbox credentials cannot authenticate browser sessions. See [environment authentication](./environment-auth.md).

Worker replacement and workspace routing sit behind the central service's execution transport. The browser continues to use the central origin for authenticated sandbox proxying. See [architecture](./overview.md) for the ownership boundaries and [remote access](../user/remote-access.md) for browser setup.
