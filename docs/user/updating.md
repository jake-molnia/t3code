# Update T3 Code

Your deployment administrator updates the central application and execution images. Provider versions are part of those images. The web application does not install server or provider updates.

To identify your deployment, open **Settings → General → About**. It shows the fork revision and upstream baseline separately. A notice links to the verified build of a newer published server image when one is available; share that link with your deployment administrator. An unavailable image check does not affect your conversations.

Before scheduled maintenance, let active turns and terminal commands finish. A restart may interrupt work that cannot resume. Saved conversations remain in the deployment's persistent storage.

After the update, reload the application. If the browser reports a client and server version mismatch, reload once to fetch the current client. Contact your administrator if the mismatch remains.

For deployment procedures, see [release deployment images](../operations/release.md).
